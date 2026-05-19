# 1. PROJECT OVERVIEW — Mailora (Mail-or-a) v2.0

---

## Project Name
**Mailora** (formerly Mail-or-a) — version 2.0

## Problem Statement
Job seekers, college students, and active applicants receive **hundreds of emails daily** from platforms like LinkedIn, Naukri, Indeed, company HR departments, hackathon organizers, and workshop coordinators. Critical opportunity emails (interview schedules, application deadlines, offer letters) get **buried under promotional noise**. There is no intelligent system that can:

1. Automatically identify which emails are about real opportunities
2. Classify them by type (job, internship, hackathon, workshop)
3. Track their progression (applied → shortlisted → interview → offer)
4. Remind users before deadlines expire
5. Consolidate all opportunities into a single dashboard

**The consequence:** Students miss application deadlines, forget interview schedules, lose track of which companies they've applied to, and ultimately miss career-defining opportunities — all because of inbox chaos.

## What Problem Does This Solve
Mailora solves the **information overload problem** for job seekers by acting as an intelligent email assistant that:

- **Connects** to Gmail via OAuth and monitors the inbox in real-time via Pub/Sub webhooks
- **Classifies** every incoming email using Google Gemini AI into categories and stages
- **Encrypts** all email content at rest using AES-256-GCM for privacy
- **Organizes** emails into a 4-stage Kanban pipeline: Registration → Registered → In-Progress → Confirmed
- **Extracts** deadlines from email content and creates automated WhatsApp reminders
- **Delivers** urgency-tiered notifications (🚨 immediate, ⏰ 1-hour, ⚠️ 12-hour, 📌 24-hour, 🔔 3-day)
- **Searches** for new job opportunities via SerpAPI integration
- **Parses** resumes using AI to auto-populate user profiles

## Target Users

| User Segment | Pain Point | How Mailora Helps |
|---|---|---|
| College students | Applying to 50+ companies, can't track which responded | Dashboard shows all applications by stage |
| Fresh graduates | Miss interview emails buried under LinkedIn notifications | AI filters only opportunity emails, ignores noise |
| Active job seekers | Forget application deadlines while juggling multiple offers | WhatsApp reminders at 3-day, 24hr, 12hr, 1hr before deadline |
| Hackathon enthusiasts | Miss registration deadlines for hackathons/workshops | Automatic deadline extraction + reminder scheduling |
| Career services teams | Need to track student placement statistics | Consolidated view of confirmed offers |

## Real-World Use Case

**Scenario:** Priya is a final-year CS student who has applied to 30 companies through various job portals.

1. She receives an email from Oracle: "Complete your coding test by May 20th"
2. Mailora's Gmail webhook fires → fetches the email → publishes to Kafka
3. Gemini AI classifies it as: `category: "job"`, `stage: "inprogress"`, `deadline: "2025-05-20"`
4. Email is encrypted and stored in the `InProgressEmail` collection
5. Reminders are created: May 17 (3-day), May 18 (24hr), May 19 12:00 (12hr), May 19 23:00 (1hr)
6. On May 17, Priya receives a WhatsApp message:
   ```
   🔔 Mail-or-a Deadline Reminder
   
   Heads-up — 3 days until deadline
   
   💼 Category: JOB
   📄 Subject: Complete your Oracle coding test
   ⏳ Deadline: 20/05/2025, 11:59 PM
   ⏱️ Time Left: 3d 0h
   
   💡 Summary: Oracle OCI team coding assessment via HackerRank...
   ```
7. She never misses the deadline.

## Key Features (Detailed)

### 1. Multi-Provider Authentication
- **Local signup** with OTP-verified email (6-digit cryptographic OTP via `crypto.randomInt`)
- **Google OAuth** sign-in (openid + profile + email scopes)
- **Microsoft OAuth** sign-in (Azure AD common tenant, supports personal + work accounts)
- Account linking: Google sign-in links to existing email/password account automatically
- httpOnly JWT cookies with 7-day expiry, secure + sameSite flags

### 2. Gmail Integration (Real-Time)
- OAuth 2.0 with `gmail.readonly` + `gmail.modify` scopes
- Gmail Pub/Sub watch subscription for real-time INBOX notifications
- History API for incremental email fetching (only new messages since last check)
- Automatic watch renewal every 6 hours (Gmail watches expire after 7 days)
- Support for up to 3 connected Gmail accounts per user

### 3. AI-Powered Email Classification
- Google Gemini 2.5 Flash with JSON response mode
- Classifies into 4 categories: `job`, `internship`, `hackathon`, `workshop`
- Classifies into 4 stages: `registration`, `registered`, `inprogress`, `confirmed`
- Extracts deadline dates (YYYY-MM-DD format)
- Generates concise summaries (`matter` field)
- Extracts application/registration links
- Circuit breaker protection (5 failures → 30s cooldown)

### 4. Kafka Event-Driven Pipeline
- 4 topics: `email-classification`, `email-classification-dlq`, `whatsapp-messages`, `whatsapp-messages-dlq`
- 3 partitions per topic with userId as partition key
- Exponential backoff retry (1s, 2s, 4s, 8s, 16s — max 5 retries)
- Dead Letter Queue with dual persistence (Kafka + MongoDB FailedMessage collection)
- Singleton producer, factory-pattern consumers

### 5. WhatsApp Reminder System
- Cron job every 5 minutes scans for due reminders
- Urgency-tiered messages with emoji indicators
- Kafka-backed delivery (replaces unreliable direct HTTP)
- Circuit breaker on WhatsApp service calls
- User preferences: can disable WhatsApp reminders
- OTP verification for WhatsApp number

### 6. Resume AI Extraction
- PDF parsing via `pdf-parse`, DOCX via `mammoth`
- Gemini AI extracts: role, skills, education, experience, projects, certifications, achievements
- Intelligent merge with existing profile data (Set dedup for skills, only fills empty fields)
- Keyword-based fallback when Gemini is unavailable
- Upload to AWS S3 with pre-signed URLs

### 7. Job Search (SerpAPI Microservice)
- Cron-based job fetching from Google Jobs API
- 7 role categories with fresher/experienced classification
- Paginated search API proxied through main server
- Independent microservice with its own MongoDB

### 8. Security
- AES-256-GCM field-level encryption for all email content
- Mongoose hooks for transparent OAuth token encryption
- bcrypt (cost 10) for passwords and OTPs
- Joi schema validation with `stripUnknown`
- Tiered rate limiting (4 levels)
- Helmet security headers
- CORS origin whitelist

## End-to-End Workflow (Complete)

```
┌─────────────────────────────────────────────────────────────────┐
│                    USER JOURNEY                                  │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. SIGNUP                                                       │
│     Email → Send OTP → Verify OTP → Create User → Login         │
│     OR: Google/Microsoft OAuth → Find/Create/Link User          │
│                                                                  │
│  2. CONNECT GMAIL                                                │
│     Profile → "Connect Gmail" → OAuth consent → Callback        │
│     → Save tokens (encrypted) → Start Gmail watch()             │
│     → Store historyId for incremental sync                      │
│                                                                  │
│  3. EMAIL INGESTION (Real-Time)                                  │
│     Gmail Pub/Sub → POST /webhook/gmail → Decode base64         │
│     → Find ConnectedAccount → Refresh token if expired          │
│     → Gmail History API (startHistoryId) → Get new messages     │
│     → Extract headers + body → Publish to Kafka                 │
│                                                                  │
│  4. AI CLASSIFICATION (Async via Kafka)                          │
│     Kafka consumer → Gemini AI classify(subject, body)          │
│     → { category, stage, deadline, matter, links }              │
│     → Encrypt all fields (AES-256-GCM)                          │
│     → Store in stage-specific MongoDB collection                │
│     → Create Reminder documents if deadline exists              │
│                                                                  │
│  5. REMINDER DELIVERY (Cron + Kafka)                             │
│     Cron (*/5 * * * *) → Find pending reminders (scheduledAt)   │
│     → Look up user's WhatsApp number → Format message           │
│     → Publish to Kafka `whatsapp-messages`                      │
│     → WhatsApp consumer → Send via whatsapp-web.js              │
│     → Update reminder status (queued → sent / failed)           │
│                                                                  │
│  6. DASHBOARD (Frontend)                                         │
│     React SPA → Axios → /api/v1/emails → Decrypt + paginate    │
│     → Display by category tabs (Registration/Registered/etc.)   │
│     → Email detail view with links and summary                  │
│     → Delete email → Cascade delete pending reminders           │
│                                                                  │
│  7. PROFILE MANAGEMENT                                           │
│     Upload resume → PDF/DOCX parse → Gemini extract             │
│     → Merge skills, education, experience → Save to user        │
│     Upload photo → S3 upload → Pre-signed URL generation        │
│     Change password → bcrypt verify old → hash new              │
│     Verify WhatsApp → OTP via WhatsApp → bcrypt compare         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## High-Level Architecture Summary

```
                              ┌─────────────────┐
                              │   React + Vite   │
                              │   (Nginx:80)     │
                              └────────┬─────────┘
                                       │ HTTPS
                              ┌────────▼─────────┐
                              │  Express API     │
                              │  (Node:5000)     │
                              │                  │
                              │  ┌────────────┐  │
                ┌─────────────┤  │   Kafka    │  ├──────────────┐
                │             │  │   Broker   │  │              │
                │             │  └────────────┘  │              │
                │             │                  │              │
                │             │  ┌────────────┐  │              │
                │             │  │  MongoDB   │  │              │
                │             │  │  (Atlas)   │  │              │
                │             │  └────────────┘  │              │
                │             │                  │              │
                │             │  ┌────────────┐  │              │
                │             │  │   AWS S3   │  │              │
                │             │  │ (Resumes)  │  │              │
                │             │  └────────────┘  │              │
                │             └──────────────────┘              │
                │                                               │
    ┌───────────▼──────────┐                     ┌──────────────▼──────────┐
    │  WhatsApp Service    │                     │  SerpAPI Job Service    │
    │  (Node:5002)         │                     │  (Node:5001)            │
    │  whatsapp-web.js     │                     │  Google Jobs API        │
    │  Kafka Consumer      │                     │  Cron Scheduler         │
    └──────────────────────┘                     └─────────────────────────┘
                │
    ┌───────────▼──────────┐
    │  External Services   │
    │  • Gmail API         │
    │  • Gmail Pub/Sub     │
    │  • Gemini AI API     │
    │  • Microsoft Graph   │
    │  • SerpAPI           │
    └──────────────────────┘
```

## Project Folder Structure

```
mail-or-a/
├── client/                     # React SPA (Vite + Tailwind)
│   ├── src/
│   │   ├── components/         # Reusable UI components
│   │   ├── context/            # AuthContext, ThemeContext
│   │   ├── helpers/            # axiosClient
│   │   ├── hooks/              # Custom React hooks
│   │   ├── layouts/            # AppLayout, AuthLayout
│   │   ├── pages/              # auth/, dashboard/, profile/, home/
│   │   ├── services/           # authService, emailService, profileService, jobService
│   │   └── styles/             # Global CSS
│   ├── Dockerfile              # Multi-stage: Node build → Nginx serve
│   └── nginx.conf              # SPA routing + gzip + caching
│
├── server/                     # Main Express API
│   ├── config/                 # db.js, kafka.js, redis.js
│   ├── middlewares/            # auth, rateLimiter, upload
│   ├── modules/                # Feature modules (domain-driven)
│   │   ├── auth/               # auth.controller, socialAuth, google (Gmail connect)
│   │   ├── connectedAccount/   # OAuth token management, sync
│   │   ├── email/              # 4 stage models, email.controller
│   │   ├── failedMessage/      # DLQ persistence model
│   │   ├── job/                # Proxy to SerpAPI microservice
│   │   ├── reminder/           # Reminder model
│   │   └── user/               # User model, profile management
│   ├── services/               # Business logic services
│   │   ├── kafka/              # Producers, consumers, DLQ handler
│   │   ├── emailAI.service     # Gemini classification
│   │   ├── gemini.service      # Resume extraction
│   │   ├── google.service      # OAuth client factory
│   │   ├── microsoft.service   # Microsoft OAuth
│   │   ├── otp.email.service   # Nodemailer transactional emails
│   │   ├── reminderCreator     # Creates reminder documents
│   │   ├── reminderScheduler   # Cron job for delivery
│   │   ├── s3.service          # AWS S3 operations
│   │   └── watchRenewal        # Gmail watch renewal cron
│   ├── utils/                  # Shared utilities
│   │   ├── AppError.js         # Custom error class
│   │   ├── apiResponse.js      # Standardized JSON responses
│   │   ├── asyncHandler.js     # Async error wrapper
│   │   ├── auth.js             # JWT + cookie helpers
│   │   ├── circuitBreaker.js   # Circuit breaker pattern
│   │   ├── crypto.js           # AES-256-GCM encrypt/decrypt
│   │   ├── emailParser.js      # Gmail MIME body extraction
│   │   ├── joiSchemas.js       # Joi validation schemas
│   │   ├── logger.js           # Structured logging
│   │   └── validators.js       # Legacy validation helpers
│   ├── webhooks/               # Gmail Pub/Sub webhook handler
│   ├── tests/                  # Jest test suites
│   ├── Dockerfile              # Node Alpine production image
│   ├── app.js                  # Express app configuration
│   └── server.js               # Boot sequence + graceful shutdown
│
├── whatsapp-service/           # WhatsApp messaging microservice
│   ├── src/
│   │   ├── config/             # kafka.js, whatsapp.js
│   │   ├── consumers/          # Kafka consumer for message delivery
│   │   ├── controllers/        # HTTP send endpoints
│   │   ├── routes/             # Express routes
│   │   ├── services/           # whatsappService (send logic)
│   │   └── utils/              # logger
│   ├── Dockerfile
│   └── server.js               # Boot: WhatsApp init → Express → Kafka consumer
│
├── serpapiservice/             # Job search microservice
│   ├── config/                 # db.js
│   ├── models/                 # job.model.js
│   ├── routes/                 # job.routes.js
│   ├── services/               # serpapi.service, jobCron.service
│   ├── Dockerfile
│   └── server.js
│
└── docker-compose.yml          # 7 services: Zookeeper, Kafka, MongoDB,
                                #   Server, Client, WhatsApp, SerpAPI
```

## Service Communication Matrix

| From | To | Protocol | Purpose |
|---|---|---|---|
| Google Pub/Sub | Server `/webhook/gmail` | HTTPS POST | Real-time email notification |
| Server webhook | Kafka `email-classification` | Kafka produce | Queue email for AI processing |
| Server consumer | Gemini AI API | HTTPS POST | Classify email |
| Server consumer | MongoDB | TCP | Store classified email |
| Server cron | Kafka `whatsapp-messages` | Kafka produce | Queue reminder for delivery |
| WhatsApp consumer | WhatsApp client | Internal | Send message |
| Server | WhatsApp service | HTTP POST | OTP delivery (direct) |
| Server | SerpAPI service | HTTP GET/POST | Job search proxy |
| Client | Server | HTTPS | All API calls |
| Server | Gmail API | HTTPS | Fetch emails, manage watches |
| Server | AWS S3 | HTTPS | File upload/download |
| Server | Microsoft Graph | HTTPS | User profile (OAuth) |
| Server | Nodemailer/Gmail SMTP | SMTP | Transactional emails (OTP, reset) |
