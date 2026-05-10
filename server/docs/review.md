# Project Review — OTP Verification, Mail Storage & User Model

---

## 1. OTP Verification Flow

### Step 1 — Request OTP (`POST /api/auth/forgot-password`)

**File:** `modules/auth/auth.controller.js` → `forgotPassword()`

1. User submits their email.
2. Server looks up the user in MongoDB.
3. A **6-digit OTP** is generated using:
   ```js
   const otp = String(Math.floor(100000 + Math.random() * 900000));
   ```
4. The OTP is **bcrypt hashed** (rounds = 10) before storing — raw OTP is never saved.
5. Three fields are written to the User document:
   - `passwordResetOtp` — bcrypt hash of the OTP
   - `passwordResetOtpExpiry` — `Date.now() + 10 minutes`
   - `passwordResetToken` — cleared (set to `undefined`)
6. The **raw OTP** is emailed to the user via nodemailer (Gmail SMTP).
7. Response is always `"If this email exists, an OTP has been sent."` — same message whether email exists or not (prevents user enumeration).

---

### Step 2 — Verify OTP (`POST /api/auth/verify-otp`)

**File:** `modules/auth/auth.controller.js` → `verifyOtp()`

1. User submits `{ email, otp }`.
2. User is fetched with hidden fields explicitly selected:
   ```js
   User.findOne({ email }).select("+passwordResetOtp +passwordResetOtpExpiry")
   ```
3. Checks:
   - User exists AND has `passwordResetOtp` AND `passwordResetOtpExpiry` set → else `"Invalid or expired OTP."`
   - `passwordResetOtpExpiry < now` → `"OTP has expired. Please request a new one."`
   - `bcrypt.compare(otp, user.passwordResetOtp)` → else `"Invalid OTP."`
4. On success:
   - OTP fields are **cleared** from DB (`undefined`)
   - A **short-lived JWT resetToken** is issued (15 min):
     ```js
     jwt.sign({ id: user._id, purpose: "password-reset" }, JWT_SECRET, { expiresIn: "15m" })
     ```
   - `resetToken` is **saved to DB** (`user.passwordResetToken`)
   - `resetToken` is returned to the client in the response body

---

### Step 3a — Reset Password (`POST /api/auth/reset-password`)

**File:** `modules/auth/auth.controller.js` → `resetPassword()`

Use when user **does NOT know** their old password.

1. User submits `{ resetToken, newPassword }`.
2. `jwt.verify(resetToken, JWT_SECRET)` — must be valid and not expired.
3. `decoded.purpose` must equal `"password-reset"`.
4. User fetched by `decoded.id` with `+passwordResetToken` selected.
5. `user.passwordResetToken === resetToken` checked — prevents token reuse after revocation.
6. New password is bcrypt hashed and saved.
7. `passwordResetToken` cleared from DB — **token is now dead, cannot be reused**.

---

### Step 3b — Change Password (`POST /api/auth/change-password`)

**File:** `modules/auth/auth.controller.js` → `changePassword()`

Use when user **KNOWS** their old password (extra OTP security layer).

1. User submits `{ resetToken, oldPassword, newPassword }`.
2. Same `resetToken` validation as Step 3a.
3. Additionally: `bcrypt.compare(oldPassword, user.password)` must match.
4. `oldPassword === newPassword` check — must be different.
5. New password hashed and saved. `resetToken` cleared from DB.

---

### OTP Token Lifecycle Diagram

```
POST /forgot-password
        │
        ▼
OTP generated (6 digits)
        │
        ├── bcrypt hash → saved to user.passwordResetOtp
        ├── expiry (10 min) → user.passwordResetOtpExpiry
        └── raw OTP → sent via email
        │
POST /verify-otp
        │
   OTP bcrypt match + not expired?
        │ YES
        ▼
OTP fields cleared from DB
resetToken (JWT, 15min) → saved to user.passwordResetToken
resetToken → returned to client
        │
POST /reset-password  OR  /change-password
        │
   resetToken valid (JWT) + matches DB + purpose = "password-reset"?
        │ YES
        ▼
Password updated (bcrypt hash)
user.passwordResetToken = undefined  ← token dead, single-use
```

---

## 2. How Emails Are Stored

### Trigger — Gmail Pub/Sub Webhook (`POST /webhook/gmail`)

**File:** `webhooks/gmail.webhook.controller.js`

When a new email arrives in a connected Gmail inbox, Google Cloud Pub/Sub pushes a notification:

```
Google Gmail → Pub/Sub Topic → POST /webhook/gmail (this server)
```

### Webhook Processing Steps

1. **Decode Pub/Sub message:**
   ```js
   JSON.parse(Buffer.from(message.data, "base64").toString("utf-8"))
   // → { emailAddress, historyId }
   ```

2. **Find ConnectedAccount** by `emailAddress` + `provider: "google"` + `isActive: true`.

3. **Refresh OAuth token if expired:**
   - `google.service.js → refreshGoogleTokenIfNeeded(account)`
   - If `tokenExpiry < now`, calls `oauthClient.refreshAccessToken()`
   - Updates `account.accessToken` + `tokenExpiry` in DB

4. **Fetch new messages via Gmail History API:**
   ```js
   gmail.users.history.list({ userId: "me", startHistoryId: account.lastHistoryId })
   ```
   Only messages with label `INBOX` and event type `messagesAdded` are processed.

5. **Extract email fields for each message:**
   - `subject` — from headers
   - `from` — from headers
   - `snippet` — Gmail's auto-generated preview
   - `body` — decoded from base64 MIME parts (prefers `text/plain`)

6. **Encrypt sensitive fields (AES-256-CBC):**
   ```js
   // utils/crypto.js
   encrypt(subject), encrypt(snippet), encrypt(body)
   // stored as: "<iv_hex>:<encrypted_hex>"
   ```
   `from` field is stored **unencrypted**.

7. **Save to MongoDB `Email` collection:**
   ```js
   Email.create({
     userId, connectedAccountId, provider: "google",
     providerMessageId: msg.id,   // unique dedup key
     subject: encrypt(subject),
     from,
     snippet: encrypt(snippet),
     body: encrypt(emailBody),
     receivedAt: new Date(parseInt(fullMessage.data.internalDate))
   })
   ```
   Duplicate emails are silently skipped (MongoDB unique index on `providerMessageId + provider`, error code `11000`).

8. **AI Classification via Gemini (`gemini-2.0-flash`):**
   ```js
   classifyEmail(subject, snippet)
   // returns: { category: "job"|"internship"|"hackathon"|"interview"|"other", deadline: "YYYY-MM-DD" | null }
   ```

9. **Update email with AI results:**
   - `category` set from AI
   - `deadlineDate` = AI deadline (or tomorrow if null/invalid)
   - `expiryDate` = deadlineDate + 5 days
   - `aiProcessed = true`

10. **Update `account.lastHistoryId`** to the new historyId for the next webhook call.

---

### Email Retrieval (`GET /api/emails`)

**File:** `modules/email/email.controller.js`

```js
Email.find({ userId: req.user._id }).sort({ receivedAt: -1 })
```

Each email is **decrypted on the fly** before sending to client:
```js
emails.map(email => ({
  ...email._doc,
  subject: decrypt(email.subject),
  snippet: decrypt(email.snippet),
  body: decrypt(email.body),
}))
```

### Encryption Details (`utils/crypto.js`)

| Detail | Value |
|---|---|
| Algorithm | AES-256-CBC |
| Key derivation | `SHA-256(EMAIL_ENCRYPTION_KEY)` → 32-byte key |
| IV | 16 random bytes per encryption (prepended to ciphertext) |
| Storage format | `<iv_hex>:<ciphertext_hex>` |

---

### Email Schema (`modules/email/email.model.js`)

| Field | Type | Description |
|---|---|---|
| `userId` | ObjectId → User | Owner of the email |
| `connectedAccountId` | ObjectId → ConnectedAccount | Which inbox it came from |
| `provider` | `"google"` \| `"microsoft"` | Email provider |
| `providerMessageId` | String | Provider's message ID (unique dedup) |
| `subject` | String | AES-256-CBC encrypted |
| `from` | String | Sender address (plain) |
| `snippet` | String | AES-256-CBC encrypted |
| `body` | String | AES-256-CBC encrypted |
| `receivedAt` | Date | Original received timestamp |
| `category` | enum | `job \| internship \| hackathon \| interview \| other` |
| `stage` | enum | `apply \| inprogress \| completed` |
| `deadlineDate` | Date | AI-extracted or tomorrow |
| `expiryDate` | Date | deadlineDate + 5 days |
| `isExpired` | Boolean | Default false |
| `aiProcessed` | Boolean | Whether AI has classified it |

**Indexes:**
- `{ providerMessageId, provider }` — unique (prevents duplicate storage)
- `{ userId, receivedAt: -1 }` — fast per-user sorted queries

---

## 3. User Model Details

**File:** `modules/user/user.model.js`

### Schema Fields

| Field | Type | Notes |
|---|---|---|
| `name` | String | Required, trimmed |
| `email` | String | Required, unique, lowercase, indexed |
| `password` | String | `select: false` — never returned by default; bcrypt hashed |
| `authProvider` | `"local"` \| `"google"` \| `"microsoft"` | Default `"local"` |
| `googleId` | String | Sparse unique — only set for Google OAuth users |
| `microsoftId` | String | Sparse unique — only set for Microsoft OAuth users |
| `mobileNumber` | String | Sparse unique — optional |
| `countryCode` | String | Default `"+91"` |
| `isMobileVerified` | Boolean | Default `false` |
| `reminderPreferences.whatsapp` | Boolean | Default `true` |
| `reminderPreferences.email` | Boolean | Default `true` |
| `resumeUrl` | String | Local file path (temp, deleted post-processing) |
| `extractedSkills` | `[String]` | AI-extracted skills from resume |
| `passwordResetOtp` | String | `select: false` — bcrypt hash of OTP |
| `passwordResetOtpExpiry` | Date | `select: false` — 10 min TTL |
| `passwordResetToken` | String | `select: false` — single-use JWT (15 min) |
| `createdAt` / `updatedAt` | Date | Auto-managed by `{ timestamps: true }` |

### Key Design Decisions

- **`password` is `select: false`** — must explicitly call `.select("+password")` to retrieve it. Prevents accidental exposure.
- **`googleId` and `microsoftId` are sparse unique** — `null` values are allowed (multiple users without it), but if set it must be unique.
- **OTP fields are all `select: false`** — sensitive reset state is never accidentally leaked in API responses.
- **`authProvider` guards login method** — `login` endpoint checks this field and blocks Google/Microsoft users from using password login, redirecting them to the correct provider.
- **Account linking** — a locally registered email can be linked to Google/Microsoft by setting `googleId`/`microsoftId` on the existing document during OAuth callback.

### Resume Processing Flow

```
POST /api/user/upload-resume
        │
   multer saves file to uploads/
        │
   mimetype === "application/pdf"?
        ├── YES → pdf-parse extracts text
        └── NO  → mammoth extracts text (DOCX)
        │
   Gemini (gemini-2.5-flash) extractSkills(text)
        │   returns: ["JavaScript", "React", ...]
        │
   user.extractedSkills = skills
   user.resumeUrl = filePath
   await user.save()
        │
   fs.unlink(filePath)  ← file deleted after processing
        │
   Response: { message, skills }
```
