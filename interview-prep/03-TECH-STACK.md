# 3. COMPLETE TECH STACK ANALYSIS — Deep Dive with Interview Explanations

---

## Backend Runtime & Framework

### Node.js (v20 LTS)
- **Role in project:** Server-side JavaScript runtime powering all 3 backend services (Main Server, WhatsApp Service, SerpAPI Service)
- **Why chosen over Python/Django:**
  - **I/O Model:** Mailora is fundamentally I/O-bound — it calls Gmail API, Gemini AI, WhatsApp API, MongoDB, Kafka, and S3. Node's event loop handles thousands of concurrent I/O operations on a single thread. Python's GIL (Global Interpreter Lock) limits true concurrency, requiring multiprocessing for parallel I/O.
  - **Single Language Stack:** JavaScript on both frontend (React) and backend eliminates context switching and enables shared validation schemas (e.g., email regex patterns).
  - **NPM Ecosystem:** `kafkajs`, `@google/generative-ai`, `@aws-sdk/client-s3`, `whatsapp-web.js` — all mature, well-maintained packages.
  - **JSON Native:** MongoDB documents, Kafka messages, API responses — everything is JSON. Node handles JSON natively without serialization/deserialization overhead.
- **Why not Java/Spring Boot:**
  - Higher memory footprint (~200MB vs ~60MB for Node) — matters in containerized environments
  - Slower cold start time (JVM warmup) — critical for Docker container restarts
  - More boilerplate (annotations, DTOs, dependency injection) for a project of this scale
  - JVM ecosystem is better for CPU-bound workloads, which this project is not
- **Why not Go:**
  - Smaller package ecosystem for our needs (no mature Gemini AI SDK, WhatsApp library)
  - Go's concurrency model (goroutines) is overkill for our workload — Node's event loop suffices
  - Team familiarity with JavaScript ecosystem was higher
- **Interview explanation:** "I chose Node.js v20 because Mailora is an I/O-intensive application — every request involves external API calls (Gmail, Gemini, S3) and database operations. Node's non-blocking event loop handles these concurrent operations efficiently without the overhead of thread management. The single-language JavaScript stack also reduces cognitive load across the full-stack codebase."

### Express.js (v5)
- **Role in project:** HTTP framework for REST API routing, middleware pipeline, error handling
- **Why v5 over v4:**
  - **Native async/await support:** Express 5 automatically catches rejected promises in async route handlers and forwards them to the error handler. In Express 4, unhandled async rejections crashed the process.
  - **Improved error handling:** `app.use((err, req, res, next) => ...)` receives async errors without wrapping
  - Still, I added `asyncHandler` utility for backward-compatible explicit error catching
- **Why not Fastify:**
  - Express has a larger ecosystem — more middleware, more Stack Overflow answers
  - Fastify's schema-based validation competes with our Joi middleware approach
  - Performance difference is negligible for I/O-bound workloads (Fastify is ~15% faster for CPU-bound routing, which isn't our bottleneck)
- **Why not NestJS:**
  - NestJS adds a heavy abstraction layer (decorators, modules, providers) that's overkill for our API
  - Our modular folder structure (modules/auth, modules/email, etc.) achieves the same organization without framework lock-in
  - NestJS TypeScript requirement would add transpilation complexity without proportional benefit for our team
- **Why not Koa:**
  - Koa requires middleware composition (async/await chain) that's less intuitive for error handling
  - Smaller ecosystem and community compared to Express

---

## Database

### MongoDB (v7) + Mongoose (v9)
- **Role in project:** Primary database for all application data across 8 collections
- **Why MongoDB over PostgreSQL:**

| Consideration | MongoDB | PostgreSQL |
|---|---|---|
| Data shape | Document (nested objects, arrays) | Relational (flat tables, JOINs) |
| Email model fit | ✅ Emails are self-contained documents | ❌ Would need 5+ tables with foreign keys |
| Schema flexibility | Different stages have different fields | Would need nullable columns or EAV pattern |
| TTL auto-expiry | Native (`expireAfterSeconds` index) | Requires cron job or pg_cron extension |
| Cross-collection queries | `$unionWith` aggregation | UNION ALL + complex JOINs |
| Array fields | Native array type with `$each`, `$addToSet` | Requires array columns or join tables |
| Encryption at rest | Application-level (our approach works) | Same approach, but pgcrypto also available |

- **Why not DynamoDB:**
  - No aggregation pipeline — `$unionWith`, `$facet`, `$match` are critical for our cross-collection pagination
  - No TTL per-document based on a custom field (DynamoDB TTL is per-item but limited)
  - Compound unique indexes (for dedup) are more natural in MongoDB
  - DynamoDB's pricing model (read/write capacity units) is harder to predict for variable workloads
  - Would need DynamoDB Streams + Lambda for what our Kafka consumer does natively

- **Mongoose ORM Advantages in This Project:**
  - Pre/post hooks for transparent token encryption
  - Schema validation with custom validators
  - `select: false` on password field — never returned unless explicitly requested
  - Virtual populate for cross-collection references
  - Plugin system for shared indexing patterns

- **Key MongoDB Features Used:**
  ```javascript
  // TTL Index — auto-expire emails after 3 months
  schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
  
  // Compound Unique — prevent duplicate emails
  schema.index({ providerMessageId: 1, provider: 1 }, { unique: true });
  
  // Sparse Unique — allow null values for optional OAuth IDs
  schema.index({ googleId: 1 }, { unique: true, sparse: true });
  
  // Compound query index — covers primary access pattern
  schema.index({ userId: 1, receivedAt: -1 });
  
  // $unionWith aggregation — cross-collection pagination
  RegistrationEmail.aggregate([
    { $match: { userId: ObjectId(userId), category } },
    { $unionWith: { coll: "registeredemails", pipeline: [...] } },
    { $unionWith: { coll: "inprogressemails", pipeline: [...] } },
    { $unionWith: { coll: "confirmedemails", pipeline: [...] } },
    { $facet: {
      data: [{ $sort: { receivedAt: -1 } }, { $skip }, { $limit }],
      total: [{ $count: "count" }],
    }},
  ]);
  ```

---

## Message Broker

### Apache Kafka (KafkaJS)
- **Role in project:** Asynchronous message broker for email classification and WhatsApp delivery pipelines
- **Why Kafka over RabbitMQ:**

| Feature | Kafka | RabbitMQ |
|---|---|---|
| Message persistence | ✅ Log-based (retained even after consumption) | ❌ Deleted after acknowledgment |
| Message replay | ✅ Can replay from any offset | ❌ Cannot replay consumed messages |
| Consumer scaling | ✅ Partition-based parallelism | ⚠️ Requires prefetch tuning |
| Throughput | ✅ 100K+ messages/sec | ⚠️ 10-20K messages/sec |
| Use case fit | Event streaming, log aggregation | Task queues, RPC |

- **Why not Redis Pub/Sub:**
  - Fire-and-forget model — if the consumer is down, messages are **permanently lost**
  - No message persistence, no replay capability
  - No consumer groups for load balancing
  - Redis Pub/Sub is a good fit for real-time notifications, not for critical data pipelines

- **Why not AWS SQS:**
  - SQS has a 256KB message size limit (email bodies can exceed this)
  - SQS doesn't support message ordering within a partition (FIFO queues are limited)
  - Would add AWS vendor lock-in for a component that benefits from local development (Docker Compose)

- **KafkaJS Configuration in Project:**
  ```javascript
  // Singleton Kafka instance
  const kafka = new Kafka({
    clientId: "mailora-server",
    brokers: [process.env.KAFKA_BROKER || "localhost:9092"],
    retry: { retries: 5, initialRetryTime: 300 },
  });
  
  // Singleton producer (lazy-initialized)
  let producerInstance = null;
  async function getProducer() {
    if (!producerInstance) {
      producerInstance = kafka.producer();
      await producerInstance.connect();
    }
    return producerInstance;
  }
  
  // Factory pattern for consumers
  function createConsumer(groupId) {
    return kafka.consumer({ groupId });
  }
  ```

---

## AI / Machine Learning

### Google Gemini 2.5 Flash (@google/generative-ai)
- **Role in project:** Email classification AND resume data extraction (two separate services)
- **Why Gemini Flash over GPT-4:**
  - **JSON Response Mode:** `responseMimeType: "application/json"` guarantees valid JSON output. GPT-4's function calling is an alternative but less direct.
  - **Speed:** Flash is optimized for low-latency inference (~200-500ms) compared to GPT-4 (~1-3s)
  - **Cost:** Significantly cheaper per token for our high-volume classification task
  - **Google ecosystem integration:** Native SDK works seamlessly with Google Cloud (we're already using Gmail API)
- **Why not a custom ML model:**
  - Our classification task requires understanding natural language context (is "assessment" an exam or a job assessment?)
  - Training a custom model requires labeled data — we'd need thousands of pre-classified emails
  - Gemini handles edge cases (multilingual emails, informal language) out of the box
  - The structured JSON output eliminates regex parsing — a major source of bugs
- **Two Gemini Services in the Codebase:**
  1. **emailAI.service.js** — Email classification with circuit breaker
  2. **gemini.service.js** — Resume profile extraction (no circuit breaker — single-use, user-triggered)

---

## Cloud Services

### AWS S3 (@aws-sdk/client-s3)
- **Role in project:** Object storage for resumes (PDF/DOCX) and profile photos (JPEG/PNG)
- **Operations implemented:**
  - `uploadToS3(filePath, originalName, mimetype, userId, folder)` — Upload with UUID filename
  - `deleteFromS3(key)` — Delete on profile photo replacement
  - `getPresignedUrl(key, expiresIn)` — Time-limited access URL (1 hour default)
- **Security model:**
  ```
  Bucket → NOT publicly accessible
  Files → Only accessible via pre-signed URLs
  URLs → Expire after 1 hour
  Filenames → UUID (not original filename — prevents enumeration)
  Path → {folder}/{userId}/{uuid}.{ext} (user isolation)
  ```
- **Why not Cloudinary:** S3 pre-signed URLs are more secure (auto-expire). Cloudinary permanent URLs are convenient but less secure for sensitive documents like resumes.
- **Why not GCS (Google Cloud Storage):** AWS S3 is the industry standard. Pre-signed URL API is identical, and S3 has broader CDN integration options.

### Gmail API + Google Pub/Sub
- **Gmail API operations:** `users.messages.get`, `users.history.list`, `users.watch`, `users.getProfile`
- **Pub/Sub:** Push-based webhook notification when new emails arrive in INBOX
- **Watch subscription:** Created during Gmail account connection, renewed every 6 hours via cron

---

## Security Libraries

### bcryptjs
- **Why not SHA-256:** SHA-256 is a fast hash — an attacker can compute ~10 billion SHA-256 hashes per second on a modern GPU. bcrypt with cost factor 10 takes ~100ms per hash, making brute-force computationally infeasible.
- **Why not argon2:** argon2 is the newer standard and is memory-hard (resistant to GPU attacks), but bcryptjs has zero native dependencies (pure JavaScript) — critical for our Alpine Docker images which don't have native build tools.
- **Usage in project:** Password hashing (signup, login), OTP hashing (signup OTP, password reset OTP, mobile OTP)

### jsonwebtoken (JWT)
- **Token structure:** `{ id: userId }` — minimal payload (no PII in token)
- **Expiry:** 7 days — balances security (shorter = more secure) with UX (longer = fewer re-logins)
- **Storage:** httpOnly cookie (XSS-proof) + sameSite + secure flags
- **Verification:** Every protected request → `jwt.verify(token, JWT_SECRET)` → `User.findById(decoded.id)`

### Joi
- **Why not express-validator:** Joi provides declarative schema definitions that are more readable and composable. The `stripUnknown: true` option automatically removes unexpected fields — preventing mass assignment attacks without explicit field whitelisting.
- **Middleware factory pattern:**
  ```javascript
  function validateBody(schema) {
    return (req, res, next) => {
      const { error, value } = schema.validate(req.body, {
        abortEarly: true,     // Stop on first error
        stripUnknown: true,   // Remove unknown fields
        convert: true,        // Type coercion
      });
      if (error) return res.status(400).json({ status: "fail", message: error.details[0].message });
      req.body = value; // Replace with sanitized values
      next();
    };
  }
  ```

### Helmet
- **Headers set:** X-Content-Type-Options, X-Frame-Options, X-XSS-Protection, HSTS, Referrer-Policy, Content-Security-Policy
- **Why important:** Prevents clickjacking (iframe embedding), MIME sniffing, and forces HTTPS in production

---

## DevOps & Infrastructure

### Docker + Docker Compose
- **7 services orchestrated:**

| Service | Image | Port | Purpose |
|---|---|---|---|
| zookeeper | confluentinc/cp-zookeeper:7.5.0 | 2181 | Kafka cluster coordination |
| kafka | confluentinc/cp-kafka:7.5.0 | 9092 | Message broker |
| mongodb | mongo:7 | 27017 | Database |
| server | Custom (node:20-alpine) | 5000 | Main API |
| client | Custom (nginx:alpine) | 80 | React SPA |
| whatsapp | Custom (node:20-alpine) | 5002 | WhatsApp service |
| serpapi | Custom (node:20-alpine) | 5001 | Job search |

- **Multi-stage builds:**
  ```dockerfile
  # Client: 2-stage build — Node for building, Nginx for serving
  FROM node:20-alpine AS build   # Stage 1: ~900MB
  RUN npm ci && npm run build
  
  FROM nginx:alpine AS production # Stage 2: ~25MB
  COPY --from=build /app/dist /usr/share/nginx/html
  ```

- **Health checks:**
  ```dockerfile
  HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD wget -q --spider http://localhost:5000/health || exit 1
  ```

### Nginx
- **Role:** Static file server for React SPA in production
- **Key features:**
  - Gzip compression (text/css/js/json/svg) — ~70% bandwidth reduction
  - 1-year cache headers with `immutable` directive for hashed static assets
  - SPA fallback: `try_files $uri $uri/ /index.html` — all routes serve index.html

### node-cron
- **Two scheduled jobs:**
  1. **Reminder Scheduler** — `*/5 * * * *` (every 5 minutes) — processes due WhatsApp reminders
  2. **Watch Renewal** — `0 */6 * * *` (every 6 hours) — renews Gmail Pub/Sub watches
- **Both run once on startup** after a delay (10s for reminders, 30s for watch renewal) to let DB and Kafka connect first

---

## Frontend

### React 18 + Vite
- **Why React:** Component-based architecture, large ecosystem, team familiarity
- **Why Vite over CRA:** 10x faster HMR, native ES modules, smaller production bundles
- **Key patterns used:**
  - `lazy()` + `Suspense` for code-splitting (auth pages, dashboard, profile)
  - Context API for global state (AuthContext, ThemeContext)
  - Custom hooks for reusable logic
  - Service layer pattern (authService.js, emailService.js) — separates API calls from components
  - ErrorBoundary for graceful error handling in production
  - ProtectedRoute component for auth-gated pages

### Axios (axiosClient)
- **Base URL:** `VITE_API_URL` environment variable
- **Interceptors:** Automatic `withCredentials: true` for cookie-based auth
- **Error handling:** Centralized in service layer — components get clean success/error responses
