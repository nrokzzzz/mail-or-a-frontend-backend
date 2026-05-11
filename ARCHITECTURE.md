# Mailora 2.0 — System Architecture Document

> Comprehensive architecture documentation covering system design, data flow, security model, and deployment topology.

---

## 1. High-Level Architecture

Mailora follows an **event-driven microservices architecture** with three independent services connected through Apache Kafka as the central message broker, backed by MongoDB Atlas for persistence, and AWS S3 for file storage.

### Service Topology

```
┌────────────────────────────────────────────────────────────────────────┐
│                        Docker Compose Network                          │
│                                                                        │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌───────────┐ │
│  │   Client      │  │   Server      │  │  WhatsApp    │  │  SerpAPI  │ │
│  │  (Nginx)      │  │  (Express 5)  │  │  Service     │  │  Service  │ │
│  │  Port: 80     │  │  Port: 5000   │  │  Port: 5002  │  │  Port:5001│ │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬─────┘ │
│         │                  │                  │                │       │
│         │    REST API      │     Kafka         │                │       │
│         └─────────────────►│◄────────────────►│                │       │
│                            │                                   │       │
│                            │◄──────REST Proxy─────────────────►│       │
│                            │                                          │
│  ┌──────────────┐  ┌──────┴───────┐  ┌──────────────┐               │
│  │  Zookeeper   │  │    Kafka      │  │   MongoDB    │               │
│  │  Port: 2181  │  │  Port: 9092   │  │  Port: 27017 │               │
│  └──────────────┘  └──────────────┘  └──────────────┘               │
│                                                                        │
└────────────────────────────────────────────────────────────────────────┘
                            │
           ┌────────────────┼────────────────┐
           │                │                │
  ┌────────┴───────┐ ┌─────┴──────┐ ┌──────┴──────┐
  │ Gmail Pub/Sub  │ │ Gemini AI  │ │   AWS S3    │
  │ (Webhooks)     │ │ 2.5 Flash  │ │ (Files)     │
  └────────────────┘ └────────────┘ └─────────────┘
```

### Service Responsibilities

| Service | Tech Stack | Responsibility |
|---------|-----------|----------------|
| **Client** | React 19, Vite 8, TailwindCSS | SPA frontend served via Nginx with gzip compression |
| **Server** | Express 5, Mongoose 9, KafkaJS | Main API: auth, email classification, webhooks, reminders |
| **WhatsApp Service** | Express, whatsapp-web.js | Kafka consumer for sending WhatsApp reminder messages |
| **SerpAPI Service** | Express, SerpAPI SDK | REST proxy for job search aggregation |
| **Kafka** | Confluent 7.5, KafkaJS | Asynchronous message broker with DLQ support |
| **MongoDB** | Atlas / Docker | Primary database with field-level encryption |

---

## 2. Email Classification Pipeline

The core value proposition — the 5-step automated pipeline from email arrival to classified storage:

```
┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│  Gmail       │     │  Express      │     │  Kafka        │
│  Pub/Sub     │────►│  Webhook      │────►│  Producer     │
│  Push        │     │  Controller   │     │  (Topic:      │
│              │     │              │     │  email-       │
│              │     │              │     │  classification│
└─────────────┘     └──────────────┘     └──────┬───────┘
                                                 │
                    ┌──────────────┐     ┌──────┴───────┐
                    │  MongoDB      │     │  Kafka        │
                    │  (Encrypted   │◄────│  Consumer     │
                    │   Stage       │     │  + Gemini AI  │
                    │   Collections)│     │  Classification│
                    └──────┬───────┘     └──────────────┘
                           │
                    ┌──────┴───────┐     ┌──────────────┐
                    │  Reminder     │     │  WhatsApp     │
                    │  Scheduler    │────►│  Service      │
                    │  (node-cron)  │     │  (via Kafka)  │
                    └──────────────┘     └──────────────┘
```

### Step-by-Step Flow

| Step | Component | File | Action |
|------|-----------|------|--------|
| **1** | Gmail Pub/Sub | `webhooks/gmail.webhook.controller.js` | Receives push notification, decodes base64 payload, fetches full email via Gmail API |
| **2** | Kafka Producer | `services/kafka/emailClassification.producer.js` | Publishes email payload to `email-classification` topic with userId as partition key |
| **3** | Kafka Consumer | `services/kafka/emailClassification.consumer.js` | Consumes message, calls `classifyEmail(subject, snippet)` from `emailAI.service.js` |
| **3a** | Gemini AI | `services/emailAI.service.js` | `GoogleGenerativeAI` SDK → `model.generateContent(prompt)` → JSON response with category, stage, deadline, matter, links |
| **3b** | Circuit Breaker | `utils/circuitBreaker.js` | Wraps Gemini calls — opens after 5 failures, recovers after 30s |
| **4** | MongoDB Storage | `modules/email/*.model.js` | Encrypted email stored in stage-specific collection (registration/registered/inprogress/confirmed) |
| **5** | Reminder Creator | `services/reminderCreator.service.js` | If deadline detected, creates reminder documents at intervals (3d, 24h, 12h, 1h) |
| **5a** | Cron Scheduler | `services/reminderScheduler.service.js` | Every 5 minutes, checks for due reminders and publishes to Kafka |
| **5b** | WhatsApp Service | `whatsapp-service/` | Kafka consumer sends WhatsApp messages via whatsapp-web.js |

### Failure Handling

```
Message Processing Attempt
       │
       ├─ Success → Store email, create reminders → Done
       │
       ├─ Failure (attempt 1-5) → Exponential backoff (1s, 2s, 4s, 8s, 16s) → Retry
       │
       └─ Failure (attempt 6) → Send to DLQ topic → Store in failedmessages collection → Alert
```

- **Retry**: Up to 5 retries with exponential backoff (`BASE_BACKOFF_MS * 2^(retryCount-1)`)
- **DLQ**: Dead Letter Queue via `services/kafka/dlq.handler.js` — publishes to `dlq.email-classification` topic
- **Persistence**: Failed messages stored in `failedMessage.model.js` with error metadata for manual review

---

## 3. Security Architecture

### Authentication Flow

```
┌─────────┐     POST /api/auth/login     ┌──────────┐
│  Client  │ ───────────────────────────► │  Server   │
│          │                              │           │
│          │  Set-Cookie: token=JWT       │ bcrypt    │
│          │ ◄─────────────────────────── │ compare   │
│          │                              │           │
│          │  GET /api/emails             │           │
│          │  Cookie: token=JWT           │ jwt.verify│
│          │ ───────────────────────────► │ → req.user│
│          │                              │           │
│          │  200 OK (encrypted data)     │ decrypt   │
│          │ ◄─────────────────────────── │ response  │
└─────────┘                              └──────────┘
```

### Encryption at Rest

| Data | Algorithm | Key Source | Implementation |
|------|-----------|-----------|----------------|
| Email subject, from, snippet, body | AES-256-CBC | `EMAIL_ENCRYPTION_KEY` env | `utils/crypto.js` → `encrypt()`/`decrypt()` with random IVs |
| OAuth access/refresh tokens | AES-256-CBC | Same key | `connectedAccount.model.js` → pre-save/post-init hooks with `enc:` prefix |
| User passwords | bcrypt (10 rounds) | Salt per hash | `bcryptjs` in `auth.controller.js` |
| OTP codes | bcrypt (10 rounds) | Salt per hash | Stored only as bcrypt hash, plain sent via email |

### Rate Limiting Tiers

| Tier | Limit | Endpoints | Implementation |
|------|-------|-----------|----------------|
| General | 100 req / 15 min | All API routes | `rateLimiter.middleware.js` → `generalLimiter` |
| Sensitive | 10 req / 15 min | Login, OTP, password reset | Per-route in `auth.routes.js` |
| Upload | 20 req / 15 min | Photo/resume uploads | `rateLimiter.middleware.js` → `uploadLimiter` |
| Webhook | 500 req / 5 min | Gmail Pub/Sub webhook | `rateLimiter.middleware.js` → `webhookLimiter` |

### Input Validation

All request bodies are validated using **Joi schemas** (`utils/joiSchemas.js`) before reaching controllers:

```
Request → Rate Limiter → Joi Validation → Auth Middleware → Controller
```

- Auth routes: email format, password min length, 6-digit OTP pattern
- User routes: country code pattern, mobile number digits, password confirmation
- Unknown fields are stripped automatically (`stripUnknown: true`)

---

## 4. Data Model Architecture

### MongoDB Collections

```
┌─────────────────────────────────────────────────────────────┐
│                    MongoDB Atlas                            │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │    users      │  │  connected   │  │  pending          │ │
│  │              │  │  accounts    │  │  verifications    │ │
│  │  (auth,      │  │  (OAuth      │  │  (OTP temp        │ │
│  │   profile)   │  │   tokens,    │  │   store, TTL)     │ │
│  │              │  │   encrypted) │  │                   │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │ registration │  │  registered  │  │  inprogress       │ │
│  │  emails      │  │  emails      │  │  emails           │ │
│  │ (encrypted,  │  │ (encrypted,  │  │  (encrypted,      │ │
│  │  +deadline)  │  │  no deadline)│  │  +deadline)       │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────┐ │
│  │  confirmed   │  │  reminders   │  │  failed           │ │
│  │  emails      │  │              │  │  messages         │ │
│  │ (encrypted,  │  │ (WhatsApp    │  │  (DLQ             │ │
│  │  no deadline)│  │  schedules)  │  │   persistence)    │ │
│  └──────────────┘  └──────────────┘  └──────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Cross-Collection Queries

The `getAllEmails` endpoint uses MongoDB `$unionWith` aggregation for database-level cross-collection pagination:

```javascript
// email.controller.js — $unionWith pipeline
RegistrationEmail.aggregate([
  { $match: { userId } },
  { $addFields: { _type: "registration" } },
  { $unionWith: { coll: "registeredemails", ... } },
  { $unionWith: { coll: "inprogressemails", ... } },
  { $unionWith: { coll: "confirmedemails",  ... } },
  { $sort: { receivedAt: -1 } },
  { $facet: {
    data: [{ $skip: skip }, { $limit: limit }],
    totalCount: [{ $count: "count" }]
  }}
]);
```

---

## 5. API Architecture

### Route Hierarchy

```
app.js
├── GET  /            → Server info (version, uptime)
├── GET  /health      → Dependency health check (MongoDB + Gemini circuit breaker)
│
├── /api/v1/          → Versioned API routes (current)
│   ├── /auth         → auth.routes.js (signup, login, logout, password flows)
│   ├── /auth         → socialAuth.routes.js (Google, Microsoft OAuth)
│   ├── /user         → user.routes.js (profile CRUD, uploads)
│   ├── /accounts     → connectedAccount.routes.js
│   ├── /emails       → email.routes.js (paginated dashboard queries)
│   ├── /jobs         → job.proxy.js (SerpAPI proxy)
│   └── /             → google.routes.js (Gmail OAuth connection)
│
├── /api/             → Backward-compatible alias → /api/v1/
│
├── /webhook/gmail    → Gmail Pub/Sub webhook (rate limited, 1MB body limit)
│
├── 404 handler       → AppError("Route not found")
└── Global error handler → Mongoose validation, duplicate key, JWT, generic
```

### Middleware Pipeline (per request)

```
1. helmet()              → Security headers
2. morgan("dev")         → HTTP logging
3. cookieParser()        → Parse JWT cookie
4. express.json()        → Parse JSON body (10MB limit)
5. cors()                → CORS with allowed origins
6. generalLimiter        → Rate limit (100/15min on /api/v1/)
7. [route-specific]      → validateBody(joiSchema), protect, upload
8. Controller            → Business logic with asyncHandler
9. apiResponse           → Standardized JSON response
```

---

## 6. Deployment Architecture

### Docker Compose Services

```yaml
# 6 services orchestrated via docker-compose.yml
services:
  client:            # React SPA → Nginx (port 80)
  server:            # Express API (port 5000)
  whatsapp-service:  # WhatsApp microservice (port 5002)
  serpapiservice:    # Job search microservice (port 5001)
  kafka:             # Confluent Kafka broker (port 9092)
  zookeeper:         # Kafka coordination (port 2181)
  mongo:             # MongoDB 7.0 (port 27017, dev only)
```

### Health Checks

Every service in Docker Compose has a health check:

| Service | Health Check | Interval |
|---------|-------------|----------|
| Zookeeper | `echo srvr | nc localhost 2181` | 10s |
| Kafka | `kafka-topics --bootstrap-server localhost:9092 --list` | 15s |
| MongoDB | `db.runCommand("ping")` via mongosh | 10s |
| Server | `GET /health` → checks MongoDB + Gemini circuit | — |
| Client | `curl -f http://localhost:80` via Nginx | — |

### CI/CD Pipeline (GitHub Actions)

```
Push to main/develop
       │
       ├── Job 1: Server Tests
       │   └── npm ci → npm test (118 tests)
       │
       ├── Job 2: Client Build
       │   └── npm ci → npm run build
       │
       └── Job 3: Docker Build (main only)
           └── docker build → verify image
```

---

## 7. Graceful Shutdown

```javascript
// server.js — shutdown sequence
process.on("SIGTERM", async () => {
  1. Stop accepting new connections (server.close())
  2. Disconnect Kafka consumers (stop consuming)
  3. Disconnect Kafka producer (flush pending)
  4. Disconnect MongoDB (mongoose.disconnect())
  5. Exit process
});
```

This ensures no in-flight messages are lost and all database connections are properly closed.
