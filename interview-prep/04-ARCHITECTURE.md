# 4. ARCHITECTURE DEEP DIVE

---

## System Architecture Diagram

```
                    ┌──────────────────────────────────────────┐
                    │              INTERNET                      │
                    │                                            │
                    │   ┌────────┐    ┌──────────┐    ┌───────┐│
                    │   │ User   │    │ Google   │    │ MS    ││
                    │   │Browser │    │ Pub/Sub  │    │ Azure ││
                    │   └───┬────┘    └────┬─────┘    └───┬───┘│
                    └───────┼──────────────┼──────────────┼────┘
                            │              │              │
                    ┌───────▼──────────────▼──────────────▼────┐
                    │           NGINX / Load Balancer            │
                    └───────────────────┬──────────────────────┘
                                        │
                    ┌───────────────────▼──────────────────────┐
                    │         EXPRESS API SERVER (Port 5000)     │
                    │                                            │
                    │  ┌─────────────────────────────────────┐  │
                    │  │         MIDDLEWARE PIPELINE           │  │
                    │  │ Helmet → Morgan → Cookie → JSON      │  │
                    │  │ → CORS → RateLimiter → Joi → Auth    │  │
                    │  └─────────────────────────────────────┘  │
                    │                                            │
                    │  ┌──────────┐ ┌──────────┐ ┌──────────┐  │
                    │  │  Auth    │ │  Email   │ │  User    │  │
                    │  │  Module  │ │  Module  │ │  Module  │  │
                    │  └──────────┘ └──────────┘ └──────────┘  │
                    │  ┌──────────┐ ┌──────────┐ ┌──────────┐  │
                    │  │ Account  │ │  Job     │ │ Reminder │  │
                    │  │  Module  │ │  Proxy   │ │  Module  │  │
                    │  └──────────┘ └──────────┘ └──────────┘  │
                    │                                            │
                    │  ┌─────────────────────────────────────┐  │
                    │  │           SERVICES LAYER             │  │
                    │  │ emailAI │ gemini │ s3 │ google │ otp │  │
                    │  │ reminderCreator │ reminderScheduler  │  │
                    │  │ watchRenewal │ microsoft              │  │
                    │  └─────────────────────────────────────┘  │
                    │                                            │
                    │  ┌─────────────────────────────────────┐  │
                    │  │        KAFKA LAYER                    │  │
                    │  │ emailClassification.producer          │  │
                    │  │ emailClassification.consumer          │  │
                    │  │ whatsappMessage.producer              │  │
                    │  │ whatsappMessage.consumer              │  │
                    │  │ dlq.handler                           │  │
                    │  └─────────────────────────────────────┘  │
                    └──────────┬────────────┬──────────────────┘
                               │            │
              ┌────────────────▼──┐    ┌────▼─────────────┐
              │   MongoDB Atlas    │    │   Apache Kafka    │
              │   (8 collections)  │    │   (4 topics)      │
              └────────────────────┘    └──────────────────┘
                                               │
                         ┌─────────────────────┼──────────────┐
                         ▼                                     ▼
              ┌──────────────────────┐          ┌──────────────────────┐
              │  WhatsApp Service    │          │  SerpAPI Service     │
              │  (Port 5002)         │          │  (Port 5001)         │
              │                      │          │                      │
              │  Express + Kafka     │          │  Express + Cron      │
              │  whatsapp-web.js     │          │  SerpAPI Client      │
              │  Direct client calls │          │  Own MongoDB         │
              └──────────────────────┘          └──────────────────────┘
```

## Request Lifecycle — Complete Flow Analysis

### Flow 1: Gmail Webhook → Email Classification

```
Step 1: Google Pub/Sub sends POST to /webhook/gmail
  ├── Body: { message: { data: "<base64>" } }
  ├── Query: ?token=WEBHOOK_SECRET (optional auth)
  └── Expected response: 200 (always, even on error)

Step 2: Webhook controller decodes message
  ├── Buffer.from(message.data, "base64").toString("utf-8")
  ├── JSON.parse → { emailAddress, historyId }
  └── Logs: "Gmail webhook received"

Step 3: Lookup ConnectedAccount
  ├── ConnectedAccount.findOne({ emailAddress, provider: "google", isActive: true })
  ├── If not found → return 200 (no action)
  └── If found → proceed to email fetching

Step 4: Refresh OAuth token if expired
  ├── Check: account.tokenExpiry < Date.now()
  ├── If expired → oauthClient.refreshAccessToken()
  ├── Update DB: account.accessToken = newToken
  └── OAuth tokens decrypted via Mongoose post-init hook

Step 5: Fetch new emails via Gmail History API
  ├── gmail.users.history.list({ startHistoryId: account.lastHistoryId })
  ├── Filters: Only INBOX labels, only messagesAdded records
  ├── For each new message: gmail.users.messages.get({ id: msg.id })
  └── Extracts: subject, from, snippet, body (MIME parsing)

Step 6: Publish to Kafka (per email)
  ├── Topic: "email-classification"
  ├── Key: userId (partition affinity)
  ├── Value: { userId, connectedAccountId, provider, messageId,
  │            subject, from, snippet, body, internalDate }
  └── Adds: producedAt timestamp, retryCount: 0

Step 7: Update historyId
  ├── account.lastHistoryId = newHistoryId
  ├── await account.save()
  └── Next webhook will fetch only messages after this point

Step 8: Return 200 to Pub/Sub
  └── Total time: < 200ms (Kafka produce is fast)
```

### Flow 2: Kafka Consumer → AI Classification → Storage

```
Step 1: Consumer receives message from Kafka
  ├── JSON.parse(message.value.toString()) → payload
  └── Enters processEmailMessage(payload) function

Step 2: Retry loop (max 5 attempts)
  ├── retryCount = payload.retryCount || 0
  └── while (retryCount <= MAX_RETRIES) { ... }

Step 3: Gemini AI classification
  ├── classifyEmail(subject, snippet) via circuit breaker
  ├── Gemini prompt includes: today's date, classification rules,
  │   deadline extraction rules, output JSON schema
  └── Returns: { category, stage, deadline, matter, links }

Step 4: Validate classification result
  ├── Skip if category not in ["job", "internship", "hackathon", "workshop"]
  ├── Skip if stage not in ["registration", "registered", "inprogress", "confirmed"]
  └── Determine Mongoose model from STAGE_MODELS map

Step 5: Encrypt sensitive fields
  ├── encrypt(subject) → "gcm:iv:authTag:ciphertext"
  ├── encrypt(from), encrypt(snippet), encrypt(body), encrypt(matter)
  ├── links.map(l => encrypt(l))
  └── Non-sensitive: category, aiProcessed, expiresAt (3 months from now)

Step 6: Store in stage-specific MongoDB collection
  ├── If stage === "registration" || "inprogress": processDeadlineEmail()
  │   ├── Parse deadline (default: 24h from now if missing)
  │   ├── Model.create({ ...baseDoc, deadlineDate })
  │   └── createReminders({ userId, emailId, deadlineDate, ... })
  └── Else: Model.create(baseDoc)

Step 7: Handle errors
  ├── Error code 11000 (duplicate) → skip silently (idempotent)
  ├── Other errors → increment retryCount → exponential backoff
  └── After MAX_RETRIES → sendToDLQ(topic, payload, error, retryCount)
```

### Flow 3: Reminder Scheduling → WhatsApp Delivery

```
Step 1: Cron fires every 5 minutes
  └── processDueReminders()

Step 2: Query due reminders
  ├── Reminder.find({ status: "pending", scheduledAt: { $lte: now } }).limit(50)
  └── If none found → return (no work)

Step 3: For each reminder
  ├── User.findById(reminder.userId).select("name countryCode mobileNumber ...")
  ├── Check: user exists, WhatsApp enabled, mobile verified
  ├── If any check fails → status = "skipped", failReason = "reason"
  └── Build WhatsApp number: countryCode.replace("+","") + mobileNumber

Step 4: Format urgency message
  ├── Switch on reminderType: emoji + urgency label
  ├── Calculate timeLeft (days + hours)
  ├── Include: category icon, subject, deadline, summary
  └── Return formatted WhatsApp message string

Step 5: Publish to Kafka
  ├── produceWhatsAppMessage({ reminderId, userId, whatsappNumber, message, ... })
  ├── Update reminder: status = "queued"
  └── 500ms delay between messages

Step 6: WhatsApp consumer receives message
  ├── Main server consumer: HTTP POST to WhatsApp service (circuit breaker)
  ├── WhatsApp service consumer: Direct sendMessage() (no HTTP hop)
  ├── On success: Reminder status → "sent", sentAt = now
  ├── On failure: Retry with exponential backoff
  └── After MAX_RETRIES: DLQ + Reminder status → "failed"
```

## Middleware Pipeline (Detailed)

```
Incoming Request
    │
    ▼
┌─────────────────────────────────────────────────────┐
│ 1. Helmet                                            │
│    Sets security headers: X-Frame-Options,           │
│    X-Content-Type-Options, HSTS, CSP, etc.           │
├─────────────────────────────────────────────────────┤
│ 2. Morgan (dev mode)                                 │
│    Logs: "POST /api/auth/login 200 45ms"             │
├─────────────────────────────────────────────────────┤
│ 3. Cookie Parser                                     │
│    Parses cookies → req.cookies.token                │
├─────────────────────────────────────────────────────┤
│ 4. JSON Body Parser                                  │
│    express.json({ limit: "10mb" }) → req.body        │
├─────────────────────────────────────────────────────┤
│ 5. CORS                                             │
│    Origin whitelist: mail-or-a.dev, localhost:5173    │
│    Credentials: true (allows cookies)                │
│    Methods: GET, POST, PUT, DELETE, PATCH            │
├─────────────────────────────────────────────────────┤
│ 6. Rate Limiter (per-route)                          │
│    General: 100 req / 15 min                         │
│    Sensitive: 10 req / 15 min                        │
│    OTP: 3 req / 10 min                               │
│    Webhook: 500 req / 5 min                          │
├─────────────────────────────────────────────────────┤
│ 7. Joi Validation (per-route)                        │
│    validateBody(joiSchemas.login) → strips unknown   │
│    fields, validates types, returns 400 on error     │
├─────────────────────────────────────────────────────┤
│ 8. Auth Middleware (protected routes only)            │
│    Extract JWT from cookie or Authorization header   │
│    jwt.verify(token, JWT_SECRET) → { id }            │
│    User.findById(decoded.id) → req.user              │
│    If invalid/expired → 401 Unauthorized             │
├─────────────────────────────────────────────────────┤
│ 9. Controller Logic                                  │
│    Wrapped in asyncHandler for error catching        │
│    Business logic → database operations → response   │
├─────────────────────────────────────────────────────┤
│ 10. Global Error Handler                             │
│     Catches all unhandled errors:                    │
│     • ValidationError → 400                          │
│     • Duplicate key (11000) → 400                    │
│     • JWT errors → 401                               │
│     • AppError → custom statusCode                   │
│     • Unknown → 500 (stack in dev only)              │
└─────────────────────────────────────────────────────┘
```

## Error Handling Architecture

```javascript
// Custom error class with operational flag
class AppError extends Error {
  constructor(message, statusCode) {
    super(message);
    this.statusCode = statusCode;
    this.status = statusCode >= 500 ? "error" : "fail";
    this.isOperational = true; // Expected errors (not bugs)
  }
}

// Async handler — catches rejected promises
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

// Global error handler
app.use((err, req, res, next) => {
  if (err.name === "ValidationError") {
    // Mongoose validation error
    return sendError(res, 400, "Validation failed", err.errors);
  }
  if (err.code === 11000) {
    // MongoDB duplicate key
    const field = Object.keys(err.keyPattern)[0];
    return sendError(res, 400, `${field} already exists`);
  }
  if (err.name === "JsonWebTokenError") {
    return sendError(res, 401, "Invalid token");
  }
  if (err.isOperational) {
    return sendError(res, err.statusCode, err.message);
  }
  // Programming error — log stack, return generic message
  logger.error("Server", "Unhandled error", err);
  return sendError(res, 500, "Something went wrong");
});
```

## Architecture Decision: Modular Monolith + Microservices Hybrid

### Why This Hybrid Approach

**The main server is a modular monolith** — all core features (auth, email, user, reminders) live in one Express app with domain-driven folder organization (`modules/auth/`, `modules/email/`, etc.).

**WhatsApp and Job Search are microservices** — independently deployable with their own `server.js`, `Dockerfile`, and `package.json`.

### Why Not Full Microservices

```
ANTI-PATTERN: Breaking the email pipeline into microservices

  Webhook Service → Auth Service → Classification Service
       │                │                 │
       ▼                ▼                 ▼
  (needs ConnectedAccount) (needs User) (needs 4 email models)
       │                │                 │
       └────────────────┼────────────────┘
                        ▼
               DISTRIBUTED TRANSACTION
               (Saga pattern needed — massive complexity)
```

The email pipeline shares **one database** and needs transactional consistency:
- Webhook needs ConnectedAccount (with decrypted OAuth tokens)
- Classification needs email models (4 collections)
- Reminder creation needs User model (for WhatsApp number)
- All happen in sequence within the Kafka consumer

Splitting these into separate services would require:
- Network calls between services (latency)
- Distributed transactions or Saga pattern (complexity)
- Service discovery and load balancing (infrastructure)
- Shared database or database-per-service with sync (consistency challenges)

### Why Not Pure Monolith

WhatsApp service needs isolation because:
1. **whatsapp-web.js** runs a headless Chromium browser — memory-intensive, crash-prone
2. A WhatsApp crash should NOT take down the main API server
3. WhatsApp requires a persistent session (QR code scan) — different lifecycle from stateless API
4. Can be scaled independently (or replaced with Business API) without affecting main server

SerpAPI service needs isolation because:
1. Has its own cron schedule (daily job fetching)
2. Has its own rate limits (SerpAPI quota)
3. Has its own MongoDB collection (jobs don't belong in the main database)
4. Can be disabled entirely without affecting core functionality

## Graceful Shutdown Implementation

```javascript
// server.js — ordered shutdown
async function shutdown(signal) {
  logger.info("Server", `${signal} received — initiating graceful shutdown`);

  // 1. Stop accepting new HTTP connections
  server.close(() => logger.info("Server", "HTTP server closed"));

  // 2. Disconnect Kafka consumers (drain in-flight messages)
  if (emailConsumer) await emailConsumer.disconnect();
  if (whatsappConsumer) await whatsappConsumer.disconnect();

  // 3. Disconnect Kafka producer
  await disconnectProducer();

  // 4. Close MongoDB connection
  await mongoose.connection.close();

  logger.info("Server", "Graceful shutdown complete");
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

**Why this order matters:**
1. Stop HTTP first → no new requests enter the system
2. Stop consumers → finish processing current messages, don't pick up new ones
3. Stop producer → no new messages sent to Kafka
4. Close DB last → consumers may need DB during their final operations
