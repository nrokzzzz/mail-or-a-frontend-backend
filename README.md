# 📬 Mailora 2.0 — AI-Powered Email Classification & Opportunity Tracker

> **Mailora** is a production-grade, event-driven web application that connects to users' Gmail inboxes, classifies incoming career-related emails using Google Gemini AI, organizes them on a visual dashboard, and sends automated WhatsApp reminders before deadlines expire.

---

## Problem Statement

Job seekers and students receive a large volume of emails about jobs, internships, hackathons, and workshops across multiple email accounts. Manually reading, classifying, and tracking these emails is time-consuming and unreliable. Important emails get buried in cluttered inboxes, and deadlines pass without the user realizing it. There is no single platform that provides a unified view of all career-related emails, automatically identifies what type of opportunity each email represents, extracts deadlines, and sends reminders. Existing email clients offer no AI-based understanding of email content, and users are forced to use separate tools for email tracking, reminders, job searching, and resume management.

---

## Proposed Solution

Mailora solves this by creating an automated pipeline that works as follows. When a user connects their Gmail account, the system receives real-time notifications via Gmail Pub/Sub webhooks whenever a new email arrives. The email is then queued in Apache Kafka for asynchronous processing. A Kafka consumer sends the email content to Google Gemini AI, which returns the category (job, internship, hackathon, or workshop), the lifecycle stage (registration, registered, in progress, or confirmed), any detected deadline, and a brief summary. The classified email is encrypted and stored in MongoDB. If a deadline is found, WhatsApp reminders are automatically scheduled at intervals like three days before, twelve hours before, and one hour before the deadline. A cron job checks for due reminders every five minutes and delivers them through a dedicated WhatsApp microservice via Kafka.

---

## System Architecture

Mailora follows an event-driven microservices architecture with three services — the main Express server, a WhatsApp messaging service, and a SerpAPI job search service — connected through Apache Kafka and backed by MongoDB Atlas.

### Architecture Diagram

```
┌──────────────────┐          ┌─────────────────────┐          ┌────────────────────┐
│   React Client   │  REST    │   Express Server     │  Kafka   │  WhatsApp Service  │
│   (Vite + React  │ ────────►│   (Main API +        │ ────────►│  (Messaging        │
│    19 + Tailwind) │ ◄────────│    Kafka Consumers)  │ ◄────────│   Microservice)    │
│   Port: 5173     │          │   Port: 5000         │          │   Port: 5002       │
└────────┬─────────┘          └──────────┬───────────┘          └────────────────────┘
         │                               │
         │                    ┌──────────┴───────────┐          ┌────────────────────┐
         │                    │   Apache Kafka        │          │  SerpAPI Service   │
         │                    │   (Message Broker     │          │  (Job Search       │
         │                    │    + DLQ)             │          │   Microservice)    │
         │                    │   Port: 9092          │          │   Port: 5001       │
         │                    └──────────┬───────────┘          └────────────────────┘
         │                               │
         │                    ┌──────────┴───────────┐
         │                    │   MongoDB Atlas       │
         │                    │   (Encrypted at Rest) │
         │                    └──────────────────────┘
         │
         │                    ┌──────────────────────┐          ┌────────────────────┐
         │                    │   Google Gmail API    │  Pub/Sub │  Google Gemini AI  │
         │                    │   (OAuth + Webhooks)  │ ────────►│  (2.5 Flash Model) │
         └────────────────────│   (Real-time Push)    │          │  Classification    │
                              └──────────────────────┘          └────────────────────┘
```

### Email Classification Pipeline (5-Step Flow)

```
Step 1: Gmail Pub/Sub Webhook     → POST /webhook/gmail receives push notification
Step 2: Kafka Producer            → Email payload published to 'email-classification' topic
Step 3: Kafka Consumer + Gemini   → Consumer calls Google Gemini AI 2.5 Flash for classification
Step 4: Encrypted MongoDB Storage → Classified email encrypted (AES-256-CBC) and stored by stage
Step 5: Reminder Scheduling       → If deadline detected, WhatsApp reminders created via cron
```

### Microservices Communication

| Service | Port | Communication | Purpose |
|---------|------|---------------|---------|
| **Express Server** | 5000 | REST + Kafka Producer/Consumer | Main API, email classification, auth |
| **WhatsApp Service** | 5002 | Kafka Consumer | Sends WhatsApp reminder messages |
| **SerpAPI Service** | 5001 | REST Proxy | Job search aggregation via SerpAPI |
| **Kafka Broker** | 9092 | Pub/Sub Topics | Asynchronous message passing |
| **MongoDB Atlas** | 27017 | Mongoose ODM | Primary database (encrypted at rest) |
| **Zookeeper** | 2181 | Kafka Coordination | Kafka broker management |

### Resilience Patterns

- **Circuit Breaker**: Wraps Gemini AI calls — opens after 5 failures, 30s cooldown
- **Retry with Exponential Backoff**: Failed Kafka messages retried up to 5 times (1s, 2s, 4s, 8s, 16s)
- **Dead Letter Queue (DLQ)**: Permanently failed messages sent to `dlq.*` Kafka topics and stored in `failedmessages` MongoDB collection
- **Graceful Shutdown**: SIGTERM/SIGINT disconnects Kafka consumers → Kafka producer → MongoDB in sequence
- **Health Checks**: `GET /health` reports MongoDB connection state + Gemini circuit breaker status

---

## Technologies Used

### Frontend
| Technology | Version | Purpose |
|-----------|---------|---------|
| React | 19 | UI component library |
| Vite | 8 | Build tool and dev server |
| React Router DOM | 7 | Client-side routing and navigation |
| TailwindCSS | 4 | Utility-first CSS framework |
| Framer Motion | 12 | Page transitions and micro-animations |
| Axios | 1.x | HTTP client for API calls |
| React Hot Toast | 2.x | Toast notification system |
| React Lazy + Suspense | — | Code splitting and lazy loading |
| ErrorBoundary | — | Global error catching with fallback UI |

### Backend
| Technology | Version | Purpose |
|-----------|---------|---------|
| Node.js | 20 LTS | JavaScript runtime |
| Express | 5.2 | Web framework |
| MongoDB / Mongoose | 9.2 | Database and ODM |
| KafkaJS | 2.2 | Apache Kafka client |
| **Google Gemini AI SDK** (`@google/generative-ai`) | **0.24** | **AI email classification (imported in `emailAI.service.js`, invoked via `model.generateContent()`)** |
| JWT (jsonwebtoken) | 9.x | Authentication tokens |
| bcryptjs | 3.x | Password hashing |
| Joi | 18.x | Request body validation schemas |
| Helmet | 8.x | Security HTTP headers |
| express-rate-limit | 8.x | API rate limiting |
| Morgan | 1.x | HTTP request logging |
| Multer | 2.x | File upload handling |
| Nodemailer | 8.x | Email sending (OTP, password reset) |
| node-cron | 4.x | Scheduled reminder checks |
| pdf-parse | 1.x | PDF resume text extraction |
| Mammoth | 1.x | DOCX resume text extraction |
| AES-256-CBC (Node.js crypto) | — | Field-level encryption at rest |

### Infrastructure
| Technology | Purpose |
|-----------|---------|
| Apache Kafka | Asynchronous message broker |
| Zookeeper | Kafka broker coordination |
| Docker / Docker Compose | Containerized multi-service deployment |
| GitHub Actions | CI/CD pipeline (lint, test, build, Docker) |
| MongoDB Atlas | Cloud-hosted database |
| AWS S3 | Resume and photo file storage |
| Gmail Pub/Sub API | Real-time email push notifications |
| Nginx | Client static file serving (Docker) |
| SerpAPI | Job search aggregation |

### AI Integration Details

**Google Gemini AI** is the core differentiator of Mailora. It is used in two places:

1. **Email Classification** (`server/services/emailAI.service.js`):
   - Library: `@google/generative-ai` — imported as `const { GoogleGenerativeAI } = require("@google/generative-ai")`
   - Model: `gemini-2.5-flash` with `responseMimeType: "application/json"`
   - Invocation: `const result = await model.generateContent(prompt)` → `JSON.parse(result.response.text())`
   - Protected by a Circuit Breaker (opens after 5 consecutive failures, 30s recovery timeout)
   - Called by: `server/services/kafka/emailClassification.consumer.js` via `classifyEmail(subject, snippet)`

2. **Resume Skill Extraction** (`server/services/gemini.service.js`):
   - Same SDK, same model
   - Invocation: `const result = await model.generateContent(prompt)` with skill extraction prompt
   - Called by: `server/modules/user/user.controller.js` via `extractSkills(resumeText)`

---

## In Scope

The current version (v2.0) includes the following features, all of which are implemented and functional:

### Authentication & User Management
- Email/password registration with OTP verification (bcrypt-hashed OTPs, 10-minute TTL)
- Google OAuth social sign-in via `googleapis` SDK
- Microsoft OAuth social sign-in via Azure AD Graph API
- JWT authentication with httpOnly secure cookies (7-day expiry)
- Logout endpoint (`POST /api/auth/logout`) that clears JWT cookie
- Forgot password flow with encrypted email in reset links
- Change password flow with old password verification
- User profile management (basic info, sections, photo, resume)

### Gmail Integration & Email Classification
- Gmail account connection via OAuth 2.0 (up to 3 accounts per user)
- Real-time email monitoring via Gmail Pub/Sub webhooks
- AI-powered email classification using Google Gemini AI 2.5 Flash into:
  - **4 categories**: job, internship, hackathon, workshop
  - **4 stages**: registration, registered, in-progress, confirmed
- AI-extracted deadlines, summaries, and application links
- All email content encrypted at rest using AES-256-CBC with random IVs
- Emails auto-expire after 90 days (MongoDB TTL index)

### Dashboard & Frontend
- Paginated email dashboard with category and stage filters (`?page=N&limit=N`)
- Cross-collection pagination using MongoDB `$unionWith` aggregation
- Code-split React app with `React.lazy()` and `Suspense`
- Global `ErrorBoundary` with styled fallback UI
- Responsive design with TailwindCSS and Framer Motion animations
- Theme support (light/dark mode via ThemeContext)

### Reminders & Notifications
- Automatic WhatsApp reminder scheduling based on AI-extracted deadlines
- Reminder intervals: 3 days, 24 hours, 12 hours, and 1 hour before deadline
- WhatsApp number verification via OTP
- Cron job checks for due reminders every 5 minutes
- Reminders delivered through dedicated WhatsApp microservice via Kafka

### Resume & Job Search
- Resume upload (PDF/DOCX) with AI-powered skill extraction via Gemini
- Extracted skills stored on user profile
- S3-backed file storage for resumes and profile photos
- Built-in job search engine powered by SerpAPI microservice

### Infrastructure & Security
- API versioning (`/api/v1/` with backward-compatible `/api/` alias)
- Rate limiting: global (100/15min), sensitive (10/15min), upload (20/15min), webhook (500/5min)
- Input validation using Joi schemas on all auth and user routes
- Structured logging with tagged log levels (info, warn, error, debug)
- Circuit breaker pattern for Gemini AI calls
- Kafka retry with exponential backoff (5 retries) + Dead Letter Queue
- Graceful shutdown (SIGTERM/SIGINT → Kafka → MongoDB disconnect)
- Docker Compose deployment with health checks for all services
- GitHub Actions CI/CD pipeline (server tests, client build, Docker verification)
- `.editorconfig` and `.gitattributes` for consistent code style

---

## Out of Scope

The current version does not include:
- Microsoft Outlook email monitoring (Gmail only)
- In-app email reply or compose functionality
- Native mobile application (React Native)
- Multi-language / internationalization support
- Team or organization accounts
- Custom user-defined email classification rules
- Google/Outlook Calendar integration
- Email attachment analysis (only email body is classified)
- Analytics dashboards with trends and charts
- Payment or subscription features
- Browser push notifications (WhatsApp only)
- Offline support / PWA capabilities
- End-to-end encryption (uses encryption at rest)

---

## Future Enhancements

### Short-Term (v2.1)
- **Microsoft Outlook Integration**: Monitor Outlook inboxes using Microsoft Graph API webhooks, extending multi-provider support beyond Gmail
- **Browser Push Notifications**: Add Web Push API as an alternative notification channel alongside WhatsApp reminders
- **Analytics Dashboard**: Track application trends, deadline compliance rates, and category distribution with interactive charts
- **Smart Job Recommendations**: Use extracted resume skills to recommend matching jobs from the SerpAPI service
- **Gmail Watch Renewal**: Automated cron-based renewal of Gmail Pub/Sub subscriptions before 7-day expiry

### Medium-Term (v3.0)
- **Calendar Synchronization**: Sync detected deadlines and interview dates to Google Calendar and Outlook Calendar
- **AI Email Composer**: Generate follow-up and application emails using Gemini AI based on email context
- **Multi-Language Support**: Internationalize the frontend with i18next for Hindi, Spanish, and other languages
- **React Native Mobile App**: Native iOS/Android app with push notifications and offline email viewing
- **Attachment Analysis**: Use Gemini Vision API to analyze email attachments (PDFs, images) for additional context
- **Redis Caching Layer**: Add Redis for rate-limit store sharing across instances and frequently-accessed data caching

### Long-Term (v4.0)
- **Team/Organization Accounts**: Placement cells and career services can manage students' email tracking centrally
- **Application Auto-Fill**: Use stored profile data (skills, experience, education) to auto-fill job application forms
- **AI Interview Preparation**: Generate interview questions and preparation materials based on the job description in classified emails
- **Full CRM / Applicant Tracking System**: End-to-end pipeline from email discovery to application submission to offer acceptance
- **Blockchain Credential Verification**: Verify academic credentials and certifications using blockchain technology
- **Third-Party Plugin Marketplace**: Allow developers to build plugins for custom email classification rules, notification channels, and integrations

### Extensibility Points in Current Codebase

The architecture already supports these enhancements through:

| Extension Point | Current Implementation | Future Use |
|----------------|----------------------|------------|
| Kafka Topics | `TOPICS` registry in `server/config/kafka.js` | Add new topics for calendar sync, analytics events |
| Consumer Factory | `createConsumer()` in kafka config | Plug in new consumers for any Kafka topic |
| Microservice Pattern | `whatsapp-service/`, `serpapiservice/` | Add new microservices (e.g., `calendar-service/`) |
| Route Mounting | Modular `v1Router.use()` in `app.js` | Add new API modules without touching existing code |
| Circuit Breaker | `CircuitBreaker` utility class | Wrap any external service (Calendar API, Graph API) |
| Validation Schemas | `joiSchemas.js` with `validateBody()` | Add schemas for new endpoints |
| Email Stage Models | `STAGE_MODELS` registry in consumer | Add new stages (e.g., "rejected", "withdrawn") |
| Provider Support | `ConnectedAccount.provider` enum: `["google", "microsoft"]` | Add "outlook" provider with same token management |

---

## Requirements

### Functional Requirements

| ID | Requirement | Implementation |
|----|------------|----------------|
| FR-01 | User registration with email/password and OTP verification | `auth.controller.js` → `sendSignupOtp` + `signup` |
| FR-02 | Google and Microsoft social sign-in | `socialAuth.controller.js` + `microsoft.service.js` |
| FR-03 | Gmail account connection with real-time monitoring | `google.controller.js` → OAuth + `gmail.users.watch()` |
| FR-04 | AI-powered email classification into 4 categories × 4 stages | `emailAI.service.js` → Gemini `generateContent()` |
| FR-05 | Encrypted email storage with 90-day auto-expiry | 4 stage models with AES-256-CBC + TTL index |
| FR-06 | Paginated dashboard with category/stage filters | `email.controller.js` → `$unionWith` aggregation |
| FR-07 | Automatic WhatsApp reminders based on deadlines | `reminderCreator.service.js` + `reminderScheduler.service.js` |
| FR-08 | Resume upload with AI skill extraction | `user.controller.js` → `uploadResume` + `gemini.service.js` |
| FR-09 | Built-in job search | `serpapiservice/` microservice via REST proxy |
| FR-10 | User profile management | `user.controller.js` → CRUD for all profile sections |
| FR-11 | Logout with cookie clearing | `auth.controller.js` → `logout` |

### Non-Functional Requirements

| ID | Requirement | Implementation |
|----|------------|----------------|
| NFR-01 | All email content encrypted at rest (AES-256-CBC) | `utils/crypto.js` → `encrypt()`/`decrypt()` with random IVs |
| NFR-02 | OAuth tokens encrypted at rest | `connectedAccount.model.js` → pre-save/post-init hooks with `enc:` prefix |
| NFR-03 | httpOnly secure JWT cookies | `utils/auth.js` → `setAuthCookie()` |
| NFR-04 | Kafka retry with exponential backoff + DLQ | `emailClassification.consumer.js` → 5 retries, then `dlq.handler.js` |
| NFR-05 | API rate limiting | `rateLimiter.middleware.js` → 4 tiers (general, sensitive, upload, webhook) |
| NFR-06 | Graceful server shutdown | `server.js` → SIGTERM/SIGINT handlers |
| NFR-07 | Structured logging (no raw console) | `utils/logger.js` → tagged log levels |
| NFR-08 | Input validation on all endpoints | `utils/joiSchemas.js` + `utils/validators.js` |
| NFR-09 | CI/CD pipeline | `.github/workflows/ci.yml` → test, build, Docker |
| NFR-10 | Containerized deployment | `docker-compose.yml` → 6 services with health checks |

---

## Project Structure

```
mail-or-a/
├── .editorconfig                     # Code style enforcement
├── .gitattributes                    # Line ending normalization
├── .github/workflows/ci.yml         # GitHub Actions CI/CD
├── docker-compose.yml                # Full-stack orchestration (6 services)
│
├── client/                           # React 19 + Vite 8 + TailwindCSS
│   ├── Dockerfile                    # Multi-stage: Node build → Nginx serve
│   ├── nginx.conf                    # SPA routing + gzip + caching
│   └── src/
│       ├── App.jsx                   # Lazy-loaded routes + ErrorBoundary
│       ├── components/               # Reusable UI (ErrorBoundary, ProtectedRoute)
│       ├── context/                  # AuthContext, ThemeContext
│       ├── layouts/                  # DashboardLayout
│       ├── pages/                    # All page components
│       └── services/                 # Axios API clients
│
├── server/                           # Express 5 + Kafka + Gemini AI
│   ├── Dockerfile                    # Node.js production image
│   ├── app.js                        # Middleware pipeline + route mounting
│   ├── server.js                     # Entry point + graceful shutdown
│   ├── config/                       # db.js, kafka.js, redis.js
│   ├── middlewares/                  # auth, upload, rateLimiter
│   ├── modules/
│   │   ├── auth/                     # Auth + social auth + Gmail connection
│   │   ├── user/                     # Profile management
│   │   ├── connectedAccount/         # OAuth token management (encrypted)
│   │   ├── email/                    # 4 stage models + controllers
│   │   ├── reminder/                 # Reminder scheduling
│   │   ├── failedMessage/            # DLQ persistence
│   │   └── job/                      # Job search proxy
│   ├── services/
│   │   ├── emailAI.service.js        # ★ Gemini AI classification + circuit breaker
│   │   ├── gemini.service.js         # ★ Gemini AI resume extraction
│   │   ├── kafka/                    # Producer, consumer, DLQ handler
│   │   ├── google.service.js         # OAuth2 client factory
│   │   ├── microsoft.service.js      # Microsoft OAuth
│   │   ├── otp.email.service.js      # Nodemailer OTP emails
│   │   ├── reminderCreator.service.js    # Creates reminder documents
│   │   ├── reminderScheduler.service.js  # Cron job for due reminders
│   │   └── s3.service.js            # AWS S3 file operations
│   ├── utils/
│   │   ├── crypto.js                 # AES-256-CBC + generateOtp()
│   │   ├── asyncHandler.js           # Async route wrapper
│   │   ├── apiResponse.js            # Standardized responses
│   │   ├── circuitBreaker.js         # Circuit breaker pattern
│   │   ├── joiSchemas.js             # Joi validation schemas
│   │   ├── validators.js             # Custom validation functions
│   │   ├── logger.js                 # Structured tagged logger
│   │   ├── auth.js                   # JWT + cookie helpers
│   │   └── AppError.js               # Custom error class
│   ├── webhooks/
│   │   ├── gmail.webhook.js          # Router for POST /webhook/gmail
│   │   └── gmail.webhook.controller.js   # Pub/Sub handler → Kafka
│   ├── tests/                        # 13 test suites, 118 tests
│   │   ├── utils/                    # Unit tests for all utilities
│   │   ├── services/                 # Kafka producer, DLQ, reminder tests
│   │   └── middleware/               # Auth middleware tests
│   └── docs/                         # API docs, audit report
│
├── whatsapp-service/                 # WhatsApp messaging microservice
│   ├── Dockerfile
│   └── src/                          # Kafka consumer + WhatsApp API
│
└── serpapiservice/                   # Job search microservice
    ├── Dockerfile
    └── server.js                     # SerpAPI integration
```

---

## Test Coverage

```
Test Suites: 13 passed, 13 total
Tests:       118 passed, 118 total
Time:        2.79s
```

| Suite | Tests | Coverage |
|-------|-------|----------|
| `utils/validators.test.js` | 16 | Email, password, OTP, required fields, middleware |
| `utils/crypto.test.js` | 12 | AES encrypt/decrypt, round-trip, edge cases |
| `utils/emailParser.test.js` | 10 | MIME parsing, multipart, nested structures |
| `utils/circuitBreaker.test.js` | 9 | CLOSED/OPEN/HALF_OPEN states, transitions |
| `utils/appError.test.js` | 8 | Custom errors, logger integration |
| `utils/apiResponse.test.js` | 8 | sendSuccess, sendPaginated, sendError |
| `utils/joiSchemas.test.js` | 24 | All Joi schemas + validateBody middleware |
| `utils/auth.test.js` | 5 | JWT generation, cookie settings |
| `utils/asyncHandler.test.js` | 4 | Success, rejection, throws |
| `middleware/auth.middleware.test.js` | 6 | Token extraction, validation, priority |
| `services/dlq.handler.test.js` | 7 | DLQ publishing, MongoDB persistence |
| `services/emailClassification.producer.test.js` | 5 | Topic, partition key, payload |
| `services/reminderCreator.test.js` | 4 | Reminder interval creation |

---

## Getting Started

### Prerequisites
- Node.js 20+
- Docker & Docker Compose
- MongoDB Atlas account (or local MongoDB)
- Google Cloud Console project (Gmail API + Pub/Sub + Gemini AI)

### Quick Start

```bash
# Clone the repository
git clone https://github.com/your-org/mail-or-a.git
cd mail-or-a

# Configure environment
cp server/.env.example server/.env   # Fill in real values

# Start all services
docker-compose up --build

# Or run locally (development)
cd server && npm install && npm run dev
cd client && npm install && npm run dev
```

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `MONGO_URI` | ✅ | MongoDB connection string |
| `JWT_SECRET` | ✅ | JWT signing secret (min 32 chars) |
| `EMAIL_ENCRYPTION_KEY` | ✅ | AES-256 key (`crypto.randomBytes(32).toString('hex')`) |
| `GEMINI_API_KEY` | ✅ | Google Gemini AI API key |
| `GOOGLE_CLIENT_ID` | ✅ | Google OAuth client ID |
| `GOOGLE_CLIENT_SECRET` | ✅ | Google OAuth client secret |
| `GOOGLE_PUBSUB_TOPIC` | ✅ | Gmail Pub/Sub topic name |
| `FRONTEND_URL` | ✅ | Frontend URL for redirects |
| `KAFKA_BROKERS` | ✅ | Kafka broker addresses |

---

## License

ISC
