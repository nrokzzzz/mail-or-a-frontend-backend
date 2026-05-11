# Mail-or-a Server — Full Project Audit

> **Audit Version:** 2.0 (Updated May 2026)
> **Last Updated:** 2026-05-11
> **Previous Audit:** v1.0 (pre-remediation)

---

## 1. Project Overview

**Mail-or-a (Mailora)** is a Node.js/Express backend for an AI-powered email opportunity tracker. It connects to users' Gmail inboxes via OAuth + Pub/Sub webhooks, classifies incoming emails (job, internship, hackathon, workshop) using **Google Gemini AI** (`@google/generative-ai` SDK), encrypts and stores them in MongoDB across stage-based collections, and exposes REST APIs for the frontend.

**Stack:** Express 5, MongoDB (Mongoose 9), Google Gemini AI SDK, KafkaJS, Joi validation, express-rate-limit, AES-256-CBC encryption, JWT httpOnly cookies, bcryptjs, Docker Compose.

---

## 2. Audit Summary — Remediation Status

### Security Issues

| # | Issue | Severity | Status | Fix Applied |
|---|-------|----------|--------|-------------|
| 4.1 | Secrets in `.env` | 🔴 CRITICAL | ⚠️ Operational | `.env` is in `.gitignore`. Recommend rotating all secrets. |
| 4.2 | OAuth tokens stored in plaintext | 🔴 CRITICAL | ✅ **FIXED** | `connectedAccount.model.js` now encrypts tokens at rest via pre-save/post-init hooks using `enc:` prefix + AES-256-CBC |
| 4.3 | No rate limiting | 🔴 CRITICAL | ✅ **FIXED** | `express-rate-limit` installed. 4-tier system: general (100/15min), sensitive (10/15min), upload (20/15min), webhook (500/5min). Applied globally + per-route. |
| 4.4 | Weak encryption key | 🟡 HIGH | ⚠️ Operational | Recommend: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| 4.5 | JWT fallback secret `"fallback_secret"` | 🟡 HIGH | ✅ **FIXED** | Removed from `google.controller.js`. All files now use `process.env.JWT_SECRET` without fallback. |
| 4.6 | Webhook no authentication | 🟡 HIGH | ⚠️ Operational | Recommend setting `WEBHOOK_SECRET` in `.env` |
| 4.7 | `from` field docs inconsistency | 🟡 MEDIUM | ✅ **FIXED** | Code encrypts `from` correctly. Documentation updated. |
| 4.8 | No logout endpoint | 🟡 MEDIUM | ✅ **FIXED** | `POST /api/auth/logout` added. Clears httpOnly cookie with proper flags. |
| 4.9 | Helmet after routes | 🟡 MEDIUM | ✅ **FIXED** | `app.use(helmet())` is now line 26 in `app.js`, before all route definitions. |
| 4.10 | Debug `console.log(token)` | 🟢 LOW | ✅ **FIXED** | Removed from `auth.middleware.js`. |

### Code Quality Issues

| # | Issue | Severity | Status | Fix Applied |
|---|-------|----------|--------|-------------|
| 5.1a | Unused dependencies (bullmq, ioredis, openai, @google/genai) | 🔴 | ✅ **FIXED** | All 4 removed from `package.json`. Only used packages remain. |
| 5.1b | Empty modules (job/, remainder/) | 🔴 | ✅ **FIXED** | `remainder/` renamed to `reminder/` with full implementation. `job/` has `job.proxy.js`. |
| 5.1c | Empty `config/redis.js` | 🔴 | ✅ **FIXED** | Now contains documented placeholder with production Redis setup instructions. |
| 5.1d | Deprecated `email.model.js` | 🔴 | ✅ **FIXED** | Deleted. 4 stage-specific models are the active implementation. |
| 5.2 | Duplicate Gemini SDK (`@google/genai` + `@google/generative-ai`) | 🟡 | ✅ **FIXED** | Only `@google/generative-ai` remains. |
| 5.3 | No input validation library | 🟡 | ✅ **FIXED** | `joi` v18 installed. 11 schemas in `joiSchemas.js`. Wired into all auth + user routes via `validateBody()` middleware. |
| 5.4 | No pagination on email queries | 🟡 | ✅ **FIXED** | All endpoints support `?page=N&limit=N`. `getAllEmails` uses MongoDB `$unionWith` aggregation for cross-collection pagination. |
| 5.5 | `getAllEmails` N+1 pattern | 🟡 | ✅ **FIXED** | Replaced with `$unionWith` + `$facet` aggregation — pagination happens at database level. |
| 5.6 | No global error handler | 🟢 | ✅ **FIXED** | `app.js` lines 117-160: handles ValidationError, duplicate key, JWT errors, and generic errors. |
| 5.7 | Password reset sends two emails | 🟢 | ✅ **FIXED** | Now sends only `sendResetPasswordEmail`. |

### Infrastructure Issues

| # | Issue | Severity | Status | Fix Applied |
|---|-------|----------|--------|-------------|
| 10a | Missing `express-rate-limit` | 🔴 | ✅ **FIXED** | v8.5.1 installed and applied globally + per-route. |
| 10b | Missing validation library | 🔴 | ✅ **FIXED** | `joi` v18.2.1 installed with 11 schemas. |
| 10c | Missing `nodemon` in devDeps | 🟡 | ✅ **FIXED** | v3.1.14 added to devDependencies. |
| 12.6 | No global error handler | 🔴 | ✅ **FIXED** | Full error handler in `app.js`. |
| 12.7 | No pagination | 🟡 | ✅ **FIXED** | All email endpoints paginated. |
| 12.8 | No logout endpoint | 🟡 | ✅ **FIXED** | `POST /api/auth/logout` implemented. |
| 12.12 | No health check | 🟡 | ✅ **FIXED** | `GET /health` checks MongoDB + Gemini circuit breaker state. |
| 12.14 | `tokenExpiry: required` crash | 🟡 | ✅ **FIXED** | Controller defaults to `now + 1hr` if Google doesn't return `expiry_date`. |

### Additional Improvements (Not in Original Audit)

| Improvement | Implementation |
|-------------|----------------|
| `asyncHandler` utility | Eliminates try/catch boilerplate in all controllers |
| `apiResponse` utility | Standardized `sendSuccess/sendError/sendPaginated` helpers |
| Circuit breaker for Gemini AI | Opens after 5 failures, 30s cooldown, exposed via `/health` |
| Cryptographically secure OTP | `crypto.randomInt(100000, 999999)` replaces `Math.random()` |
| Broken logger syntax fixed | 10+ `logger.error()` calls in `user.controller.js` had broken string escaping |
| React ErrorBoundary | Global error boundary with styled fallback UI |
| React code splitting | All page components use `React.lazy()` + `Suspense` |
| Client Dockerfile | Multi-stage Node → Nginx build with gzip + SPA routing |
| `.editorconfig` + `.gitattributes` | Consistent indentation, line endings, charset |
| 13 test suites, 118 tests | All passing — covers utils, middleware, services, Kafka |

---

## 3. Current Dependency Audit

| Package | Version | Status | Used In |
|---------|---------|--------|---------|
| `@aws-sdk/client-s3` | ^3.1041.0 | ✅ Used | `s3.service.js` |
| `@aws-sdk/s3-request-presigner` | ^3.1042.0 | ✅ Used | `s3.service.js` |
| `@google/generative-ai` | ^0.24.1 | ✅ **Used** | `emailAI.service.js` (email classification), `gemini.service.js` (resume extraction) |
| `axios` | ^1.13.6 | ✅ Used | `microsoft.service.js` |
| `bcryptjs` | ^3.0.3 | ✅ Used | `auth.controller.js`, `user.controller.js` |
| `cookie-parser` | ^1.4.7 | ✅ Used | `app.js` |
| `cors` | ^2.8.6 | ✅ Used | `app.js` |
| `dotenv` | ^17.3.1 | ✅ Used | `server.js` |
| `express` | ^5.2.1 | ✅ Used | Framework |
| `express-rate-limit` | ^8.5.1 | ✅ Used | `rateLimiter.middleware.js`, `auth.routes.js` |
| `googleapis` | ^171.4.0 | ✅ Used | `google.service.js`, `google.controller.js` |
| `helmet` | ^8.1.0 | ✅ Used | `app.js` |
| `joi` | ^18.2.1 | ✅ Used | `joiSchemas.js` → all auth + user routes |
| `jsonwebtoken` | ^9.0.3 | ✅ Used | `auth.js`, `auth.middleware.js` |
| `kafkajs` | ^2.2.4 | ✅ Used | `config/kafka.js`, producers, consumers |
| `mammoth` | ^1.11.0 | ✅ Used | `user.controller.js` (DOCX parsing) |
| `mongoose` | ^9.2.3 | ✅ Used | All models |
| `morgan` | ^1.10.1 | ✅ Used | `app.js` |
| `multer` | ^2.1.0 | ✅ Used | `upload.middleware.js` |
| `node-cron` | ^4.2.1 | ✅ Used | `reminderScheduler.service.js` |
| `nodemailer` | ^8.0.2 | ✅ Used | `otp.email.service.js` |
| `pdf-parse` | ^1.1.1 | ✅ Used | `user.controller.js` (PDF parsing) |

**Dev Dependencies:**
| Package | Version | Status |
|---------|---------|--------|
| `jest` | ^30.4.2 | ✅ Test framework |
| `nodemon` | ^3.1.14 | ✅ Dev server auto-restart |

**Zero unused dependencies.** All packages listed in `package.json` are actively imported and used.

---

## 4. Test Results

```
Test Suites: 13 passed, 13 total
Tests:       118 passed, 118 total
Time:        2.79s
```

All tests pass. No flaky tests. No skipped tests.

---

## 5. Updated Summary Scorecard

| Category | Previous | Current | Key Improvements |
|----------|----------|---------|-----------------|
| **Security** | 🔴 D | 🟢 A- | OAuth tokens encrypted, rate limiting on all endpoints, secure OTP generation, logout endpoint |
| **Authentication** | 🟡 B- | 🟢 A | Full auth lifecycle with OTP, social OAuth, logout, JWT cookies |
| **Data Modeling** | 🟡 B- | 🟡 B+ | 4 stage models with encryption hooks, TTL indexes, proper indexing |
| **Code Quality** | 🟡 C+ | 🟢 A- | Zero unused deps, Joi validation, asyncHandler, structured logging, 118 tests |
| **Error Handling** | 🔴 D | 🟢 A | Global error handler, circuit breaker, asyncHandler, DLQ |
| **API Design** | 🟡 B | 🟢 A | Versioned routes, pagination, standardized responses, DELETE endpoints |
| **Documentation** | 🟡 C | 🟢 A- | Comprehensive README with architecture, specs, and extensibility docs |
| **DevOps** | 🔴 F | 🟢 A- | 118 tests, CI/CD pipeline, Docker Compose, health checks, structured logging |

---

## 6. Remaining Operational Items

These items require operational action (not code changes):

1. **Rotate secrets** if `.env` was ever committed to a public repo
2. **Generate strong encryption key**: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
3. **Set `WEBHOOK_SECRET`** in production `.env` for webhook authentication
4. **Configure Microsoft OAuth** env vars (`MICROSOFT_CLIENT_ID`, etc.) if Outlook sign-in is needed
5. **Set `EMAIL_USER`/`EMAIL_PASS`** for Nodemailer SMTP in production
