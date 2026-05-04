# Password Reset & Change — How It Actually Works

Base URL: `/api/auth`

---

## Flow Overview

There is **no separate OTP verification step**. The OTP is verified directly inside the reset/change endpoint itself. The flow is **2 steps, not 3**.

### Reset Password (user forgot their password)
```
POST /forgot-password  →  POST /reset-password
```

### Change Password (user knows their old password)
```
POST /forgot-password  →  POST /change-password
```

---

## What Happens When User Clicks "Forgot Password"

### Step 1 — `POST /api/auth/forgot-password`

**File:** `modules/auth/auth.controller.js` → `forgotPassword()`

#### What the server does internally:

1. User submits `{ email }`.
2. Server looks up the user in MongoDB by email.
3. A **6-digit numeric OTP** is generated:
   ```js
   const otp = String(Math.floor(100000 + Math.random() * 900000));
   // Example output: "482910"
   ```
4. The OTP is **bcrypt hashed** (10 rounds) before storing — the raw OTP is never saved in the database:
   ```js
   const hashedOtp = await bcrypt.hash(otp, 10);
   ```
5. Two fields are written to the User document:
   - `passwordResetOtp` → bcrypt hash of the OTP
   - `passwordResetOtpExpiry` → `Date.now() + 10 minutes`
6. The user's **email is encrypted** using AES-256-CBC and URL-encoded:
   ```js
   const encryptedEmail = encodeURIComponent(encrypt(email));
   // Example: "a1b2c3d4e5f6%3A7890abcdef..."
   ```
7. Two frontend links are constructed with the **raw OTP + encrypted email** as query params:
   ```
   Reset link:  {FRONTEND_URL}/reset-password?otp=482910&email={encryptedEmail}
   Change link: {FRONTEND_URL}/change-password?otp=482910&email={encryptedEmail}
   ```
8. **Two separate emails are sent** to the user:
   - Email 1: "Reset Your Password" — contains a blue button linking to the reset page
   - Email 2: "Change Your Password" — contains a green button linking to the change page
9. Response is always the same whether the email exists or not (prevents user enumeration):
   ```json
   { "message": "If this email exists, a reset link has been sent." }
   ```

#### Request
```json
{
  "email": "user@example.com"
}
```

#### Responses

| Status | Body | When |
|--------|------|------|
| `200` | `{ "message": "If this email exists, a reset link has been sent." }` | Always — even if email doesn't exist |
| `400` | `{ "message": "Please provide your email." }` | No email in body |
| `500` | `{ "message": "Internal server error" }` | Server failure |

---

## Step 2a — Reset Password (user does NOT know old password)

### `POST /api/auth/reset-password`

**File:** `modules/auth/auth.controller.js` → `resetPassword()`

The frontend extracts `otp` and `email` from the URL query params and sends them in the request body.

#### What the server does internally:

1. Receives `{ encryptedEmail, otp, newPassword }`.
2. **Decrypts the email** from the encrypted string:
   ```js
   const email = decrypt(decodeURIComponent(encryptedEmail));
   // "a1b2c3d4e5f6%3A7890abcdef..." → "user@example.com"
   ```
3. Finds the user by the decrypted email, explicitly selecting the hidden OTP fields:
   ```js
   User.findOne({ email }).select("+passwordResetOtp +passwordResetOtpExpiry")
   ```
4. **Validates the OTP** — three checks:
   - User exists AND has `passwordResetOtp` AND `passwordResetOtpExpiry` set
   - `passwordResetOtpExpiry` has not passed (`< new Date()`)
   - `bcrypt.compare(otp, user.passwordResetOtp)` matches
5. If all checks pass:
   - New password is bcrypt hashed and saved
   - OTP fields are **cleared** from the database (`undefined`)
   - The OTP is now dead — it cannot be reused

#### Request
```json
{
  "encryptedEmail": "a1b2c3d4e5f6%3A7890abcdef1234567890abcdef",
  "otp": "482910",
  "newPassword": "myNewSecurePassword"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `encryptedEmail` | String | Yes | The encrypted+encoded email from the URL query param |
| `otp` | String | Yes | The 6-digit OTP from the URL query param |
| `newPassword` | String | Yes | New password (minimum 6 characters) |

#### Responses

| Status | Body | When |
|--------|------|------|
| `200` | `{ "message": "Password reset successful. You can now log in." }` | Success |
| `400` | `{ "message": "Email, OTP and new password are required." }` | Missing fields |
| `400` | `{ "message": "Password must be at least 6 characters." }` | Weak password |
| `400` | `{ "message": "Invalid request." }` | Decryption failed (tampered email) |
| `400` | `{ "message": "Invalid or expired OTP." }` | No OTP on record / user not found |
| `400` | `{ "message": "OTP has expired. Please request a new one." }` | Past 10-minute window |
| `400` | `{ "message": "Invalid OTP." }` | Wrong OTP entered |
| `500` | `{ "message": "Internal server error" }` | Server failure |

---

## Step 2b — Change Password (user KNOWS old password)

### `POST /api/auth/change-password`

**File:** `modules/auth/auth.controller.js` → `changePassword()`

Same as reset, but requires the old password as additional verification.

#### What the server does internally:

1. Receives `{ encryptedEmail, otp, oldPassword, newPassword }`.
2. Decrypts email (same as reset).
3. Finds user with hidden fields:
   ```js
   User.findOne({ email }).select("+password +passwordResetOtp +passwordResetOtpExpiry")
   ```
4. **Validates OTP** — same three checks as reset.
5. **Validates old password**:
   ```js
   bcrypt.compare(oldPassword, user.password)
   ```
6. **Checks old ≠ new** — prevents setting the same password.
7. If all checks pass:
   - New password bcrypt hashed and saved
   - OTP fields cleared from DB

#### Request
```json
{
  "encryptedEmail": "a1b2c3d4e5f6%3A7890abcdef1234567890abcdef",
  "otp": "482910",
  "oldPassword": "myCurrentPassword",
  "newPassword": "myNewSecurePassword"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `encryptedEmail` | String | Yes | Encrypted email from URL |
| `otp` | String | Yes | 6-digit OTP from URL |
| `oldPassword` | String | Yes | User's current password |
| `newPassword` | String | Yes | New password (min 6 chars, must differ from old) |

#### Responses

| Status | Body | When |
|--------|------|------|
| `200` | `{ "message": "Password changed successfully." }` | Success |
| `400` | `{ "message": "Email, OTP, old password and new password are required." }` | Missing fields |
| `400` | `{ "message": "New password must be at least 6 characters." }` | Weak password |
| `400` | `{ "message": "Invalid request." }` | Decryption failed |
| `400` | `{ "message": "Invalid or expired OTP." }` | No OTP on record |
| `400` | `{ "message": "OTP has expired. Please request a new one." }` | Past 10-min window |
| `400` | `{ "message": "Invalid OTP." }` | Wrong OTP |
| `400` | `{ "message": "Old password is incorrect." }` | Wrong old password |
| `400` | `{ "message": "New password must be different from the old password." }` | Same password |
| `500` | `{ "message": "Internal server error" }` | Server failure |

---

## Complete Lifecycle Diagram

```
User clicks "Forgot Password" on frontend
              │
              ▼
    POST /api/auth/forgot-password
    Body: { email: "user@example.com" }
              │
              ▼
    Server generates 6-digit OTP (e.g. "482910")
              │
              ├── bcrypt.hash(otp, 10) → saved to user.passwordResetOtp
              ├── Date.now() + 10min   → saved to user.passwordResetOtpExpiry
              └── encrypt(email)       → URL-safe encrypted email string
              │
              ▼
    TWO emails sent to user:
    ┌─────────────────────────────────────────────────────────┐
    │ Email 1: "Reset Your Password"                         │
    │ Link: /reset-password?otp=482910&email={encrypted}     │
    ├─────────────────────────────────────────────────────────┤
    │ Email 2: "Change Your Password"                        │
    │ Link: /change-password?otp=482910&email={encrypted}    │
    └─────────────────────────────────────────────────────────┘
              │
              ▼
    User clicks link → frontend opens with otp + email in URL
              │
       ┌──────┴──────┐
       ▼             ▼
  /reset-password    /change-password
       │                    │
       ▼                    ▼
  POST /reset-password     POST /change-password
  Body: {                  Body: {
    encryptedEmail,          encryptedEmail,
    otp,                     otp,
    newPassword              oldPassword,
  }                          newPassword
                           }
       │                    │
       ▼                    ▼
  decrypt(email)           decrypt(email)
  verify OTP               verify OTP
  (bcrypt compare)         (bcrypt compare)
       │                    │
       │                    ├── verify old password
       │                    ├── check old ≠ new
       │                    │
       ▼                    ▼
  Hash new password        Hash new password
  Clear OTP from DB        Clear OTP from DB
  ← OTP is dead ─────────── OTP is dead →
       │                    │
       ▼                    ▼
  "Password reset          "Password changed
   successful"              successfully"
```

---

## Key Design Decisions

### Why encrypted email in the URL instead of plain text?
The user's email is **AES-256-CBC encrypted** before being placed in the URL. This prevents the email address from being visible in browser history, server logs, or link previews. The server decrypts it back when processing the request.

### Why is OTP embedded in the link instead of entered manually?
Both the OTP and encrypted email are embedded as URL query parameters in the email links. The frontend extracts them automatically — the user just clicks the link and enters their new password. No manual OTP entry required.

### Why two emails instead of one?
The current implementation sends two separate emails — one for "Reset Password" (no old password needed) and one for "Change Password" (old password required). Both contain the same OTP. This is arguably redundant and could be combined into a single email.

### Why no separate "Verify OTP" step?
The previous version had a 3-step flow: `forgot → verify-otp → reset`. The current code simplified this to 2 steps by verifying the OTP directly inside the reset/change endpoint. There is no `/verify-otp` route anymore.

### OTP Security
- OTP is **bcrypt hashed** before storage — even with database access, the raw OTP cannot be recovered
- OTP expires after **10 minutes** (server-side check on `passwordResetOtpExpiry`)
- OTP is **single-use** — cleared from DB immediately after successful password change
- Both `passwordResetOtp` and `passwordResetOtpExpiry` are `select: false` on the User model — they are never returned in normal API responses

---

## Environment Variables Required

| Variable | Where Used | Purpose |
|----------|------------|---------|
| `JWT_SECRET` | — | Not used in this flow (used in login) |
| `EMAIL_ENCRYPTION_KEY` | `utils/crypto.js` | AES key to encrypt/decrypt the email in URLs |
| `FRONTEND_URL` | `auth.controller.js` | Base URL for reset/change links (e.g. `http://localhost:5174`) |
| `EMAIL_USER` | `otp.email.service.js` | Gmail address that sends the emails |
| `EMAIL_PASS` | `otp.email.service.js` | Gmail App Password for SMTP auth |

> ⚠️ `FRONTEND_URL`, `EMAIL_USER`, and `EMAIL_PASS` are **not currently defined** in `.env` — the password reset emails will fail until these are added.
