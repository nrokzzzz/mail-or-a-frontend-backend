# Mail-or-a Server — Full Project Audit

---

## 1. Project Overview

**Mail-or-a** is a Node.js/Express backend for an AI-powered email opportunity tracker. It connects to users' Gmail inboxes via OAuth + Pub/Sub webhooks, classifies incoming emails (job, internship, hackathon, workshop) using Gemini AI, encrypts and stores them in MongoDB across stage-based collections, and exposes REST APIs for the frontend.

**Stack:** Express 5, MongoDB (Mongoose 9), Google APIs, Gemini AI, Nodemailer, AES-256-CBC encryption, JWT auth, Multer, BullMQ (unused), Redis (empty).

---

## 2. Project Structure

```
server/
├── server.js                          # Entry point — loads .env, connects DB, starts HTTP
├── app.js                             # Express app — middleware + route mounting
├── package.json                       # Dependencies & scripts
├── .env                               # Secrets (MONGO_URI, JWT_SECRET, API keys)
├── .gitignore                         # node_modules, .env, uploads, dist
│
├── config/
│   ├── db.js                          # mongoose.connect() wrapper
│   └── redis.js                       # EMPTY FILE — no Redis configured
│
├── middlewares/
│   ├── auth.middleware.js             # JWT cookie verification → req.user
│   └── upload.middleware.js           # Multer — PDF/DOCX only, disk storage
│
├── modules/
│   ├── auth/
│   │   ├── auth.controller.js         # Signup OTP, login, forgot/reset/change password
│   │   ├── auth.routes.js             # POST: send-signup-otp, signup, login, forgot/reset/change
│   │   ├── socialAuth.controller.js   # Google + Microsoft OAuth sign-in
│   │   ├── socialAuth.routes.js       # GET: google, google/callback, microsoft, microsoft/callback
│   │   ├── google.controller.js       # Gmail account connection (OAuth + watch)
│   │   ├── google.routes.js           # GET: /api/google, /api/google/callback
│   │   └── pendingVerification.model.js  # TTL-based OTP temp store
│   │
│   ├── user/
│   │   ├── user.model.js             # User schema (local + social auth fields)
│   │   ├── user.controller.js        # getProfile, updateProfile, uploadResume
│   │   └── user.routes.js            # GET /me, PUT /update, POST /upload-resume
│   │
│   ├── connectedAccount/
│   │   ├── connectedAccount.model.js  # OAuth tokens, historyId, subscription tracking
│   │   ├── connectedAccount.controller.js  # GET all connected accounts
│   │   └── connectedAccount.routes.js      # GET /api/accounts
│   │
│   ├── email/
│   │   ├── email.model.js            # DEPRECATED — replaced by 4 stage models
│   │   ├── registration.model.js     # Stage: apply/register CTAs (has deadlineDate)
│   │   ├── registered.model.js       # Stage: application received confirmations
│   │   ├── inprogress.model.js       # Stage: interview/HR/coding rounds
│   │   ├── confirmed.model.js        # Stage: offer letters, onboarding
│   │   ├── email.controller.js       # Query + decrypt emails by stage
│   │   └── email.routes.js           # GET: /, /registration, /registered, /inprogress, /confirmed
│   │
│   ├── job/                          # EMPTY DIRECTORY
│   └── remainder/                    # EMPTY DIRECTORY
│
├── services/
│   ├── emailAI.service.js            # Gemini 2.5 Flash — classify email category + stage + deadline
│   ├── gemini.service.js             # Gemini 2.5 Flash — extract skills from resume text
│   ├── google.service.js             # OAuth2 client factory, Gmail client, token refresh
│   ├── microsoft.service.js          # Microsoft OAuth URL, token exchange, Graph API profile
│   └── otp.email.service.js          # Nodemailer — signup OTP, reset link, change link emails
│
├── utils/
│   └── crypto.js                     # AES-256-CBC encrypt/decrypt with random IV
│
├── webhooks/
│   ├── gmail.webhook.js              # Router: POST /webhook/gmail
│   └── gmail.webhook.controller.js   # Pub/Sub handler → fetch → classify → encrypt → store
│
└── uploads/                          # Empty — temp storage for resume uploads
```

---

## 3. Architecture Flow

```
┌─────────────┐     OAuth      ┌──────────────┐     Pub/Sub     ┌─────────────┐
│   Frontend  │ ──────────────►│  Google APIs  │ ──────────────►│  /webhook   │
│  :5174      │                │  Gmail, OAuth │                │  /gmail     │
└──────┬──────┘                └──────────────┘                └──────┬──────┘
       │ REST API                                                     │
       ▼                                                              ▼
┌──────────────┐    JWT Cookie    ┌────────────┐   classify    ┌────────────┐
│  Express App │ ◄───────────────►│  MongoDB   │ ◄────────────►│ Gemini AI  │
│  :5000       │                  │  Atlas     │               │ 2.5 Flash  │
└──────────────┘                  └────────────┘               └────────────┘
```

---

## 4. Security Audit

### 4.1 🔴 CRITICAL — Secrets Exposed in `.env` (Committed to Repo)

**File:** `.env`

The `.gitignore` lists `.env`, but the file exists in the working tree with **real production secrets**:

| Secret | Risk |
|--------|------|
| `MONGO_URI` with embedded password `1234%40Nagu1234` | Full database access |
| `JWT_SECRET` = `Lnrokzzzz@email@2324nvhsvadn3` | Forge any JWT, impersonate any user |
| `GEMINI_API_KEY` | Unauthorized AI API usage & billing |
| `GOOGLE_CLIENT_ID` + `GOOGLE_CLIENT_SECRET` | OAuth hijacking |
| `EMAIL_ENCRYPTION_KEY` | Decrypt all stored email content |

**Impact:** If this repo is pushed to a public GitHub, all secrets are compromised.

**Fix:** Rotate ALL secrets immediately. Use `.env.example` with placeholder values. Verify `.env` is in `.gitignore` and never committed.

---

### 4.2 🔴 CRITICAL — OAuth Tokens Stored in Plaintext

**File:** `connectedAccount.model.js`

`accessToken` and `refreshToken` are stored as plain strings in MongoDB. If the database is breached, attackers get full Gmail read/modify access to every connected user's inbox.

**Fix:** Encrypt tokens at rest using `utils/crypto.js` (already available). Decrypt only when making API calls.

---

### 4.3 🔴 CRITICAL — No Rate Limiting

No rate limiting middleware exists anywhere. Every endpoint is vulnerable:

| Endpoint | Attack |
|----------|--------|
| `POST /api/auth/login` | Brute-force password guessing |
| `POST /api/auth/send-signup-otp` | OTP flooding / email bombing |
| `POST /api/auth/forgot-password` | Email bombing |
| `POST /webhook/gmail` | Webhook abuse / DoS |

**Fix:** Add `express-rate-limit` globally and stricter per-route limits on auth endpoints.

---

### 4.4 🟡 HIGH — Weak Encryption Key

**File:** `.env`

```
EMAIL_ENCRYPTION_KEY=ksajdhfjk675237tw%'/%*^qekhf
```

This is a human-typed string, not a cryptographically random key. The special characters (`%`, `'`, `/`, `*`, `^`) may also cause URL-encoding issues.

**Fix:** Generate a proper 256-bit random key: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

---

### 4.5 🟡 HIGH — JWT Fallback Secret

**File:** `google.controller.js:23, 54`

```js
process.env.JWT_SECRET || "fallback_secret"
```

If `JWT_SECRET` is ever undefined, the fallback `"fallback_secret"` is trivially guessable. This exists ONLY in `google.controller.js` — all other files use `process.env.JWT_SECRET` without fallback (which would crash, which is actually safer).

**Fix:** Remove the fallback. Fail fast on startup if `JWT_SECRET` is missing.

---

### 4.6 🟡 HIGH — Webhook Has No Real Authentication

**File:** `gmail.webhook.controller.js:85-88`

```js
if (process.env.WEBHOOK_SECRET && req.query.token !== process.env.WEBHOOK_SECRET)
```

- `WEBHOOK_SECRET` is **not defined in `.env`** — so the guard is completely bypassed.
- Even if set, passing secrets as query params is insecure (logged in URLs, visible in browser history).

**Fix:** Define `WEBHOOK_SECRET`, use Google Pub/Sub push authentication (JWT bearer verification), or validate the Pub/Sub message signature.

---

### 4.7 🟡 MEDIUM — `from` Field Encrypted Inconsistently

**File:** `gmail.webhook.controller.js:204` encrypts `from`:
```js
from: encrypt(from),
```

But `review.md` line 158 states: *"`from` field is stored unencrypted."* — The review doc is **outdated**. The current code does encrypt `from`. This is fine, but the documentation is wrong.

---

### 4.8 🟡 MEDIUM — No Logout Endpoint

There is no `POST /api/auth/logout` to clear the `token` cookie. Users cannot explicitly sign out.

**Fix:** Add a logout route that clears the cookie:
```js
res.clearCookie("token", { httpOnly: true, secure: true, sameSite: "strict" });
```

---

### 4.9 🟡 MEDIUM — Helmet After Routes

**File:** `app.js:17-20`

```js
app.get('/', (req, res) => { res.send("Hello NaGu"); })  // ← route BEFORE helmet
app.use(helmet());
```

The root route `GET /` is defined BEFORE `helmet()` middleware. Responses from this route won't have security headers.

**Fix:** Move `app.use(helmet())` before any route definitions.

---

### 4.10 🟢 LOW — Debug Logging in Auth Middleware

**File:** `auth.middleware.js:7`

```js
console.log(token);
```

Logs the JWT token to stdout on every authenticated request. In production, this leaks tokens into log files.

**Fix:** Remove this line or gate behind `NODE_ENV !== "production"`.

---

## 5. Code Quality Audit

### 5.1 🔴 Dead Code & Empty Modules

| Item | Status |
|------|--------|
| `modules/job/` | Empty directory — never implemented |
| `modules/remainder/` | Empty directory — never implemented (typo: "remainder" vs "reminder") |
| `config/redis.js` | Empty file — 0 bytes |
| `modules/email/email.model.js` | Deprecated, contains only a comment |
| `bullmq` in package.json | Installed but never imported anywhere |
| `ioredis` in package.json | Installed but never used (redis.js is empty) |
| `node-cron` in package.json | Installed but never imported |
| `openai` in package.json | Installed but never imported (using Gemini instead) |

**Impact:** ~4 unused npm packages inflating `node_modules` by ~50MB+. Empty directories suggest abandoned features.

**Fix:** Remove unused dependencies. Delete empty directories/files or add TODO markers.

---

### 5.2 🟡 Duplicate Gemini SDK Imports

**File:** `package.json`

```json
"@google/genai": "^1.43.0",
"@google/generative-ai": "^0.24.1"
```

Two different Google AI SDKs are installed. Only `@google/generative-ai` is used (in `emailAI.service.js` and `gemini.service.js`). `@google/genai` is never imported.

**Fix:** Remove `@google/genai`.

---

### 5.3 🟡 No Input Sanitization

No input sanitization or validation library (e.g., `joi`, `express-validator`, `zod`) is used anywhere. All validation is manual `if (!field)` checks. This is error-prone and inconsistent.

Examples of missing validation:
- `updateProfile` — no validation on `mobileNumber` format
- `uploadResume` — no file size limit in multer config
- Email controller — no pagination on `find()` queries (returns ALL emails)

---

### 5.4 🟡 No Pagination on Email Queries

**File:** `email.controller.js`

Every endpoint does:
```js
Model.find({ userId: req.user._id }).sort({ receivedAt: -1 })
```

No `.limit()` or `.skip()`. For users with thousands of classified emails, this returns the entire collection in one response.

**Fix:** Add `?page=1&limit=20` query param support.

---

### 5.5 🟡 `getAllEmails` N+1-like Pattern

**File:** `email.controller.js:28-35`

```js
const results = await Promise.all(
  MODELS.map(({ model, type }) =>
    model.find({ userId: req.user._id }).sort({ receivedAt: -1 })
      .then(docs => docs.map(doc => decryptEmail(doc, type)))
  )
);
```

This fires 4 parallel MongoDB queries (one per model), then decrypts ALL results in memory, then sorts again in JS. For large datasets this is expensive.

---

### 5.6 🟢 No Error Handling Middleware

There is no global Express error handler:
```js
app.use((err, req, res, next) => { ... });
```

Unhandled errors (e.g., multer file type rejection) will produce raw stack traces to the client.

---

### 5.7 🟢 Password Reset Sends TWO Emails

**File:** `auth.controller.js:204-205`

```js
await sendResetPasswordEmail(user.email, resetLink);
await sendChangePasswordEmail(user.email, changeLink);
```

Every `POST /forgot-password` sends **both** a reset email AND a change-password email. Users receive 2 emails simultaneously, which is confusing.

**Fix:** Send one email with both options, or let the user choose the flow first.

---

## 6. Data Model Audit

### 6.1 User Schema

| Field | Type | Security | Notes |
|-------|------|----------|-------|
| `name` | String | — | Required, trimmed |
| `email` | String | — | Required, unique, lowercase, indexed |
| `password` | String | `select: false` | bcrypt hashed |
| `authProvider` | enum | — | `local`, `google`, `microsoft` |
| `googleId` | String | sparse unique | OAuth linking |
| `microsoftId` | String | sparse unique | OAuth linking |
| `mobileNumber` | String | sparse unique | No format validation |
| `countryCode` | String | — | Default `+91` |
| `isMobileVerified` | Boolean | — | Default false, never set to true anywhere |
| `resumeUrl` | String | — | Set then file deleted — field becomes stale |
| `extractedSkills` | [String] | — | AI-extracted from resume |
| `passwordResetOtp` | String | `select: false` | bcrypt hashed OTP |
| `passwordResetOtpExpiry` | Date | `select: false` | 10-min window |

**Issues:**
- `isMobileVerified` is defined but never toggled — no mobile verification flow exists
- `resumeUrl` stores a file path, but the file is deleted after processing — the field is meaningless after upload
- No `passwordResetToken` field exists in current schema, but `review.md` references it — the review doc is outdated

---

### 6.2 ConnectedAccount Schema

| Field | Type | Notes |
|-------|------|-------|
| `accessToken` | String | ⚠️ Plaintext — should be encrypted |
| `refreshToken` | String | ⚠️ Plaintext — should be encrypted |
| `tokenExpiry` | Date | `required: true` but Google callback may pass `null` |
| `lastHistoryId` | String | Gmail-specific, updated by webhook |
| `subscriptionId` | String | Outlook-specific, never populated |
| `subscriptionExpiry` | Date | Outlook-specific, never populated |

**Issue:** `tokenExpiry` is `required: true` in schema but `google.controller.js:104-106`:
```js
tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : null,
```
Passing `null` for a required field will cause a Mongoose validation error if Google doesn't return `expiry_date`.

---

### 6.3 Email Stage Models

All 4 models (registration, registered, inprogress, confirmed) share identical schema except `registration` has an extra `deadlineDate` field. This is heavy duplication.

**Consider:** A single model with a `stage` enum field would eliminate 3 duplicate files and simplify queries.

---

## 7. Missing Environment Variables

The code references env vars not present in `.env`:

| Variable | Used In | Impact |
|----------|---------|--------|
| `FRONTEND_URL` | `auth.controller.js`, `socialAuth.controller.js` | Reset links & OAuth redirects will be `undefined/reset-password?...` |
| `GOOGLE_AUTH_REDIRECT_URI` | `socialAuth.controller.js` | Google sign-in callback URL is undefined |
| `MICROSOFT_CLIENT_ID` | `microsoft.service.js` | Microsoft OAuth completely broken |
| `MICROSOFT_CLIENT_SECRET` | `microsoft.service.js` | Microsoft OAuth completely broken |
| `MICROSOFT_REDIRECT_URI` | `microsoft.service.js` | Microsoft OAuth completely broken |
| `WEBHOOK_SECRET` | `gmail.webhook.controller.js` | Webhook auth guard is bypassed |
| `EMAIL_USER` | `otp.email.service.js` | Nodemailer transport will fail |
| `EMAIL_PASS` | `otp.email.service.js` | Nodemailer transport will fail |
| `NODE_ENV` | `auth.controller.js`, `socialAuth.controller.js` | Cookie `secure` flag always false |

**Impact:** Microsoft OAuth, email sending, and password reset flows are non-functional without these vars.

---

## 8. Route Map

### Auth Routes (`/api/auth`)

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/api/auth/send-signup-otp` | Public | `sendSignupOtp` |
| POST | `/api/auth/signup` | Public | `signup` |
| POST | `/api/auth/login` | Public | `login` |
| POST | `/api/auth/forgot-password` | Public | `forgotPassword` |
| POST | `/api/auth/reset-password` | Public | `resetPassword` |
| POST | `/api/auth/change-password` | Public | `changePassword` |
| GET | `/api/auth/google` | Public | `googleSignIn` (OAuth redirect) |
| GET | `/api/auth/google/callback` | Public | `googleCallback` |
| GET | `/api/auth/microsoft` | Public | `microsoftSignIn` (OAuth redirect) |
| GET | `/api/auth/microsoft/callback` | Public | `microsoftCallback` |

### User Routes (`/api/user`)

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/user/me` | `protect` | `getProfile` |
| PUT | `/api/user/update` | `protect` | `updateProfile` |
| POST | `/api/user/upload-resume` | `protect` | `uploadResume` |

### Account Routes (`/api/accounts`)

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/accounts` | `protect` | `getAccounts` |

### Gmail Connection (`/api`)

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/google` | `protect` | `googleAuth` (Gmail OAuth) |
| GET | `/api/google/callback` | Public | `googleCallback` |

### Email Routes (`/api/emails`)

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| GET | `/api/emails` | `protect` | `getAllEmails` |
| GET | `/api/emails/registration` | `protect` | `getRegistrationEmails` |
| GET | `/api/emails/registered` | `protect` | `getRegisteredEmails` |
| GET | `/api/emails/inprogress` | `protect` | `getInProgressEmails` |
| GET | `/api/emails/confirmed` | `protect` | `getConfirmedEmails` |

### Webhook

| Method | Path | Auth | Handler |
|--------|------|------|---------|
| POST | `/webhook/gmail` | Unauthenticated | `handleGmailWebhook` |

---

## 9. Route Conflict Analysis

**File:** `app.js:22-23,28`

```js
app.use("/api/auth", require("./modules/auth/auth.routes"));
app.use("/api/auth", require("./modules/auth/socialAuth.routes"));
app.use("/api", require("./modules/auth/google.routes"));
```

Both `socialAuth.routes` and `google.routes` register `GET /google/callback`:
- `socialAuth.routes` → `GET /api/auth/google/callback` (sign-in callback)
- `google.routes` → `GET /api/google/callback` (Gmail connection callback)

These are on **different base paths** so no actual conflict exists — but the naming is confusing. The `.env` has `GOOGLE_REDIRECT_URI=http://localhost:5000/api/google/callback` (for Gmail connection), but `GOOGLE_AUTH_REDIRECT_URI` (for sign-in) is missing.

---

## 10. Dependency Audit

| Package | Version | Status |
|---------|---------|--------|
| `express` | `^5.2.1` | ⚠️ Express 5 is still in alpha/beta — risky for production |
| `@google/genai` | `^1.43.0` | 🔴 Unused — remove |
| `bullmq` | `^5.70.1` | 🔴 Unused — remove |
| `ioredis` | `^5.10.0` | 🔴 Unused — remove |
| `node-cron` | `^4.2.1` | 🔴 Unused — remove |
| `openai` | `^6.25.0` | 🔴 Unused — remove |
| `@google/generative-ai` | `^0.24.1` | ✅ Used |
| `mongoose` | `^9.2.3` | ✅ Used |
| `bcryptjs` | `^3.0.3` | ✅ Used |
| `jsonwebtoken` | `^9.0.3` | ✅ Used |
| `axios` | `^1.13.6` | ✅ Used (microsoft.service.js) |
| `googleapis` | `^171.4.0` | ✅ Used |
| `helmet` | `^8.1.0` | ✅ Used |
| `cors` | `^2.8.6` | ✅ Used |
| `morgan` | `^1.10.1` | ✅ Used |
| `cookie-parser` | `^1.4.7` | ✅ Used |
| `dotenv` | `^17.3.1` | ✅ Used |
| `multer` | `^2.1.0` | ✅ Used |
| `nodemailer` | `^8.0.2` | ✅ Used |
| `pdf-parse` | `^1.1.1` | ✅ Used |
| `mammoth` | `^1.11.0` | ✅ Used |

**Missing (should add):**
- `express-rate-limit` — rate limiting
- `joi` or `zod` — input validation
- `nodemon` — listed in scripts but not in devDependencies

---

## 11. Summary Scorecard

| Category | Grade | Key Issues |
|----------|-------|------------|
| **Security** | 🔴 D | Plaintext OAuth tokens, no rate limiting, missing env vars, weak encryption key |
| **Authentication** | 🟡 B- | Solid JWT + OTP flow, but no logout, no refresh token rotation |
| **Data Modeling** | 🟡 B- | Good schema design, but heavy duplication across 4 email models |
| **Code Quality** | 🟡 C+ | 5 unused dependencies, 3 empty modules, no validation library |
| **Error Handling** | 🔴 D | No global error handler, inconsistent try/catch patterns |
| **API Design** | 🟡 B | Clean REST conventions, but no pagination, no DELETE endpoints |
| **Documentation** | 🟡 C | `review.md` exists but is outdated vs actual code |
| **DevOps** | 🔴 F | No tests, no CI/CD, no health check endpoint, no logging strategy |

---

## 12. Priority Fix List

1. **Rotate all secrets** — `.env` contains real credentials
2. **Encrypt OAuth tokens** at rest in ConnectedAccount
3. **Add rate limiting** on all auth + webhook endpoints
4. **Add missing env vars** — FRONTEND_URL, MICROSOFT_*, EMAIL_USER/PASS
5. **Remove 5 unused packages** — `@google/genai`, `bullmq`, `ioredis`, `node-cron`, `openai`
6. **Add global error handler** middleware
7. **Add pagination** to email queries
8. **Add logout endpoint**
9. **Move helmet() before routes** in app.js
10. **Remove debug `console.log(token)`** from auth middleware
11. **Add input validation** library (zod/joi)
12. **Add health check** endpoint (`GET /health`)
13. **Clean up empty directories** (job/, remainder/)
14. **Fix `tokenExpiry: required`** vs nullable in google.controller.js
