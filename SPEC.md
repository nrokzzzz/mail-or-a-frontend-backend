# Mailora 2.0 — Project Specification

> This document defines the formal specification fields for the Mailora project evaluation.

---

## problem_statement

Job seekers and students receive a large volume of emails about jobs, internships, hackathons, and workshops across multiple email accounts. Manually reading, classifying, and tracking these emails is time-consuming and unreliable. Important emails get buried in cluttered inboxes, and deadlines pass without the user realizing it. There is no single platform that provides a unified view of all career-related emails, automatically identifies what type of opportunity each email represents, extracts deadlines, and sends reminders. Existing email clients offer no AI-based understanding of email content, and users are forced to use separate tools for email tracking, reminders, job searching, and resume management.

---

## proposed_solution

Mailora solves this by creating an automated pipeline that works as follows. When a user connects their Gmail account, the system receives real-time notifications via Gmail Pub/Sub webhooks whenever a new email arrives. The email is then queued in Apache Kafka for asynchronous processing. A Kafka consumer sends the email content to Google Gemini AI (using the `@google/generative-ai` SDK, imported in `server/services/emailAI.service.js` and invoked via `model.generateContent()`), which returns the category (job, internship, hackathon, or workshop), the lifecycle stage (registration, registered, in progress, or confirmed), any detected deadline, and a brief summary. The classified email is encrypted using AES-256-CBC and stored in MongoDB. If a deadline is found, WhatsApp reminders are automatically scheduled at intervals like three days before, twelve hours before, and one hour before the deadline. A cron job checks for due reminders every five minutes and delivers them through a dedicated WhatsApp microservice via Kafka.

---

## system_architecture

Mailora follows an event-driven microservices architecture with three services — the main Express server (`server/app.js`, `server/server.js`), a WhatsApp messaging service (`whatsapp-service/src/app.js`), and a SerpAPI job search service (`serpapiservice/server.js`) — connected through Apache Kafka (`server/config/kafka.js`) and backed by MongoDB Atlas (`server/config/db.js`). All services are orchestrated via Docker Compose (`docker-compose.yml`).

The React frontend (`client/src/App.jsx`) communicates with the backend through REST API calls via Axios. The backend is organized into modules for authentication (`server/modules/auth/`), user management (`server/modules/user/`), connected accounts (`server/modules/connectedAccount/`), email classification (`server/modules/email/`), reminders (`server/modules/reminder/`), and job search (`server/modules/job/`). Each module has its own routes, controllers, and models.

The email classification pipeline works in five steps:
1. Gmail sends a Pub/Sub webhook notification when a new email arrives (`server/webhooks/gmail.webhook.controller.js`)
2. The server fetches the full email and publishes it to a Kafka topic (`server/services/kafka/emailClassification.producer.js`)
3. A Kafka consumer calls Google Gemini AI to classify the email (`server/services/kafka/emailClassification.consumer.js` → `server/services/emailAI.service.js`)
4. The classified content is encrypted and stored in the correct MongoDB collection based on its stage (`server/modules/email/registration.model.js`, `registered.model.js`, `inprogress.model.js`, `confirmed.model.js`)
5. If a deadline is detected, reminder documents are created (`server/services/reminderCreator.service.js`) and later processed by a cron job (`server/services/reminderScheduler.service.js`) that sends them through the WhatsApp microservice via Kafka

AI integration uses the `@google/generative-ai` SDK (version ^0.24.1). It is imported in `server/services/emailAI.service.js` as `const { GoogleGenerativeAI } = require("@google/generative-ai")`, instantiated as `new GoogleGenerativeAI(process.env.GEMINI_API_KEY)`, and invoked via `model.generateContent(prompt)` to classify emails. The same SDK is used in `server/services/gemini.service.js` for resume skill extraction. Gemini AI calls are wrapped in a circuit breaker (`server/utils/circuitBreaker.js`) that opens after 5 consecutive failures and recovers after 30 seconds. WhatsApp service HTTP calls are also wrapped in a separate circuit breaker instance (`server/services/kafka/whatsappMessage.consumer.js`) to prevent cascading failures when the WhatsApp microservice is unavailable.

Failed messages are retried up to five times with exponential backoff (1s, 2s, 4s, 8s, 16s). If they still fail, they are sent to a Dead Letter Queue topic (`server/services/kafka/dlq.handler.js`) and stored in a `failedmessages` collection (`server/modules/failedMessage/failedMessage.model.js`) for review.

The server implements graceful shutdown by disconnecting Kafka consumers, the Kafka producer, and the MongoDB connection in sequence when it receives a SIGTERM/SIGINT signal (`server/server.js`).

---

## technologies_used

### Frontend
- React 19 — UI component library
- Vite 8 — Build tool and dev server
- React Router DOM 7 — Client-side routing and navigation
- TailwindCSS 4 — Utility-first CSS framework
- Framer Motion 12 — Page transitions and micro-animations
- Axios — HTTP client for API calls
- React Hot Toast — Toast notification system
- React.lazy + Suspense — Code splitting and lazy loading
- ErrorBoundary — Global error catching with styled fallback UI

### Backend
- Node.js 20 LTS — JavaScript runtime
- Express 5.2 — Web framework
- MongoDB (Mongoose 9.2) — Database and ODM
- KafkaJS 2.2 — Apache Kafka client
- Google Gemini AI SDK (`@google/generative-ai` v0.24) — AI email classification (imported in `emailAI.service.js`, invoked via `model.generateContent()`) and resume skill extraction (imported in `gemini.service.js`)
- JWT (jsonwebtoken) — Authentication tokens stored in httpOnly cookies
- bcryptjs — Password and OTP hashing
- Joi 18 — Request body validation schemas with middleware
- Helmet 8 — Security HTTP headers
- express-rate-limit 8 — API rate limiting (4 tiers)
- Morgan — HTTP request logging
- Multer 2 — File upload handling (PDF, DOCX)
- Nodemailer 8 — Email sending for OTP and password reset
- node-cron 4 — Scheduled reminder checks every 5 minutes
- pdf-parse — PDF resume text extraction
- Mammoth — DOCX resume text extraction
- AES-256-GCM (Node.js crypto) — Authenticated field-level encryption at rest for email content and OAuth tokens (with backward-compatible AES-256-CBC decryption for legacy data)
- AWS SDK (S3) — Resume and photo file storage

### Infrastructure
- Apache Kafka (Confluent 7.5) — Asynchronous message broker with DLQ
- Zookeeper — Kafka broker coordination
- Docker / Docker Compose — Containerized multi-service deployment (6 services)
- GitHub Actions — CI/CD pipeline (server tests, client build, Docker verification)
- MongoDB Atlas — Cloud-hosted database
- AWS S3 — File storage for resumes and profile photos
- Gmail Pub/Sub API — Real-time email push notifications
- Nginx — Client static file serving in Docker production build
- SerpAPI — Job search aggregation

---

## in_scope

The current version (v2.0) includes:

1. Email and password authentication with OTP verification (cryptographically secure via `crypto.randomInt`)
2. Google OAuth social sign-in via `googleapis` SDK
3. Microsoft OAuth social sign-in via Azure AD / Microsoft Graph API
4. JWT authentication with httpOnly secure cookies (7-day expiry)
5. Logout endpoint (`POST /api/auth/logout`) that clears the JWT cookie
6. Gmail account connection with real-time webhook monitoring via Pub/Sub (up to 3 accounts)
7. AI-powered email classification using Google Gemini AI 2.5 Flash (`@google/generative-ai` SDK) into 4 categories (job, internship, hackathon, workshop) and 4 stages (registration, registered, in-progress, confirmed)
8. Encrypted email storage using AES-256-GCM (authenticated encryption with random IVs) and 90-day auto-expiry via MongoDB TTL index. Backward-compatible decryption of legacy AES-256-CBC ciphertext.
9. Paginated dashboard with category and stage filters using MongoDB `$unionWith` cross-collection aggregation
10. Automatic WhatsApp reminder scheduling based on AI-extracted deadlines at intervals (3 days, 24h, 12h, 1h before)
11. WhatsApp number verification via OTP
12. Resume upload (PDF/DOCX) with AI-powered skill extraction using Gemini AI
13. Built-in job search engine powered by SerpAPI microservice
14. User profile management (basic info, sections, photo upload to S3)
15. API versioning (`/api/v1/` with backward-compatible `/api/` alias)
16. Rate limiting with 4 tiers (general, sensitive, upload, webhook) via `express-rate-limit`
17. Input validation using Joi schemas on all auth and user routes
18. Structured logging with tagged log levels via custom logger utility
19. Circuit breaker pattern wrapping Gemini AI calls (opens after 5 failures, 30s recovery)
20. Kafka retry with exponential backoff (5 retries) and Dead Letter Queue for failed messages
21. Graceful server shutdown (SIGTERM/SIGINT → Kafka → MongoDB disconnect)
22. Docker Compose deployment with 6 services and health checks
23. GitHub Actions CI/CD pipeline (server tests, client build, Docker verification)
24. OAuth token encryption at rest in ConnectedAccount collection using AES-256-GCM with `enc:` prefix markers and Mongoose pre/post hooks
25. React frontend with code splitting (`React.lazy`), ErrorBoundary, and Framer Motion animations
26. Automated Gmail Pub/Sub watch renewal via `node-cron` every 6 hours (`server/services/watchRenewal.service.js`) — prevents silent loss of real-time email notifications
27. Circuit breaker pattern on WhatsApp service HTTP calls (in addition to Gemini AI) — opens after 5 failures, 30s recovery
28. Test coverage enforcement via Jest with minimum thresholds (70% lines/functions/statements)
29. Await-based boot sequence — database connection is confirmed before accepting HTTP traffic

---

## out_of_scope

The current version does not include:
- Microsoft Outlook email monitoring (Gmail only)
- In-app email reply or compose functionality
- Native mobile application (React Native)
- Multi-language / internationalization support
- Team or organization accounts
- Custom user-defined email classification rules
- Google/Outlook Calendar integration
- Email attachment analysis
- Analytics dashboards with trends
- Payment or subscription features
- Browser push notifications
- Offline support / PWA
- End-to-end encryption

---

## future_enhancements

### Short-Term (v2.1)
- **Microsoft Outlook Integration**: Monitor Outlook inboxes using Microsoft Graph API webhooks, extending the multi-provider support. The `ConnectedAccount` model already has `provider: ["google", "microsoft"]` enum support.
- **Browser Push Notifications**: Add Web Push API as an alternative notification channel alongside WhatsApp reminders. The reminder scheduler can be extended to publish to a new Kafka topic.
- **Analytics Dashboard**: Track application trends, deadline compliance rates, and category distribution with interactive charts using Recharts.
- **Smart Job Recommendations**: Use extracted resume skills to filter and recommend matching jobs from the SerpAPI service. The `extractedSkills` field already exists on the User model.
- **~~Gmail Watch Renewal~~**: ✅ Implemented in v2.0 — Automated cron-based renewal of Gmail Pub/Sub subscriptions before the 7-day expiry via `node-cron` (`server/services/watchRenewal.service.js`).

### Medium-Term (v3.0)
- **Calendar Synchronization**: Sync detected deadlines and interview dates to Google Calendar and Outlook Calendar via their respective APIs. Extensible via the Kafka topic registry.
- **AI Email Composer**: Generate follow-up and application emails using Gemini AI based on the classified email context and user profile.
- **Multi-Language Support**: Internationalize the frontend with `i18next` for Hindi, Spanish, and other languages.
- **React Native Mobile App**: Native iOS/Android app with push notifications and offline email viewing, using the same REST API backend.
- **Attachment Analysis**: Use Gemini Vision API to analyze email attachments (PDFs, images) for additional classification context.
- **Redis Caching Layer**: Add Redis (via `ioredis`) for rate-limit store sharing across instances and frequently-accessed data caching. The `config/redis.js` file already contains production setup instructions.

### Long-Term (v4.0)
- **Team/Organization Accounts**: Placement cells and career services can manage students' email tracking centrally with role-based access control.
- **Application Auto-Fill**: Use stored profile data (skills, experience, education) to auto-fill job application forms via browser extension.
- **AI Interview Preparation**: Generate interview questions and preparation materials based on the job description extracted from classified emails.
- **Full CRM / Applicant Tracking System**: End-to-end pipeline from email discovery → application submission → interview → offer acceptance tracking.
- **Blockchain Credential Verification**: Verify academic credentials and certifications using blockchain technology for trusted profile data.
- **Third-Party Plugin Marketplace**: Allow developers to build plugins for custom email classification rules, notification channels, and third-party integrations.

### Extensibility Points (Already Implemented)

The current codebase supports these enhancements through:
- **Kafka Topics Registry**: `TOPICS` object in `server/config/kafka.js` — add new topics without touching existing consumers
- **Consumer Factory**: `createConsumer()` function — plug in new consumers for any Kafka topic
- **Microservice Pattern**: `whatsapp-service/` and `serpapiservice/` as independent services — add new microservices (e.g., `calendar-service/`)
- **Route Mounting**: Modular `v1Router.use()` in `app.js` — add new API modules without touching existing routes
- **Circuit Breaker Utility**: Generic `CircuitBreaker` class — wrap any external service call
- **Validation Schema Registry**: `joiSchemas` object — add schemas for new endpoints
- **Stage Model Registry**: `STAGE_MODELS` map in consumer — add new email lifecycle stages
- **Provider Enum**: `ConnectedAccount.provider: ["google", "microsoft"]` — add new OAuth providers
