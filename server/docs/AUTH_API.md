# Authentication API — Complete Reference

Base URL: `/api/auth`

---

## Table of Contents

| # | Endpoint | Method | Auth Required |
|---|----------|--------|---------------|
| 1 | [/signup](#1-signup) | POST | No |
| 2 | [/login](#2-login) | POST | No |
| 3 | [/google](#3-google-sign-in) | GET | No |
| 4 | [/google/callback](#4-google-callback) | GET | No (handled by Google) |
| 5 | [/microsoft](#5-microsoft-sign-in) | GET | No |
| 6 | [/microsoft/callback](#6-microsoft-callback) | GET | No (handled by Microsoft) |
| 7 | [/forgot-password](#7-forgot-password) | POST | No |
| 8 | [/verify-otp](#8-verify-otp) | POST | No |
| 9 | [/reset-password](#9-reset-password) | POST | No |
| 10 | [/change-password](#10-change-password) | POST | No (resetToken acts as auth) |

---

## Flow Diagrams

### Local Sign-Up & Login
```
POST /signup  →  POST /login  →  access protected routes with cookie/token
```

### Social Sign-In (Google / Microsoft)
```
GET /google  OR  GET /microsoft
     │
     ▼ (redirects to provider)
User approves on provider page
     │
     ▼ (provider redirects back)
GET /google/callback  OR  /microsoft/callback
     │
     ▼
Cookie set + redirect to: FRONTEND_URL/auth/callback?token=...&provider=...
```

### Forgot Password (user doesn't know old password)
```
POST /forgot-password  →  POST /verify-otp  →  POST /reset-password
```

### Change Password (user knows old password, adds OTP security)
```
POST /forgot-password  →  POST /verify-otp  →  POST /change-password
```

---

## 1. Signup

**`POST /api/auth/signup`**

Creates a new local account with email and password.

### Request Payload
```json
{
  "name": "John Doe",
  "email": "john@example.com",
  "password": "secret123"
}
```

| Field      | Type   | Required | Rules                        |
|------------|--------|----------|------------------------------|
| `name`     | String | Yes      | Non-empty                    |
| `email`    | String | Yes      | Valid email format           |
| `password` | String | Yes      | Minimum 6 characters         |

### Response — Success `201`
```json
{
  "message": "Account created successfully.",
  "user": {
    "_id": "664f1a2b3c4d5e6f7a8b9c0d",
    "name": "John Doe",
    "email": "john@example.com"
  }
}
```

### Response — Validation Error `400`
```json
{ "message": "Invalid input. Please provide name, email, and password (min 6 characters)." }
{ "message": "Invalid email format." }
{ "message": "Email already in use." }
```

### Response — Server Error `500`
```json
{ "message": "Internal server error" }
```

---

## 2. Login

**`POST /api/auth/login`**

Authenticates a local account. Sets a JWT in an **httpOnly cookie** and also returns it in the response body.

### Request Payload
```json
{
  "email": "john@example.com",
  "password": "secret123"
}
```

| Field      | Type   | Required |
|------------|--------|----------|
| `email`    | String | Yes      |
| `password` | String | Yes      |

### Response — Success `200`
```json
{
  "message": "Login successful",
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "user": {
    "_id": "664f1a2b3c4d5e6f7a8b9c0d",
    "name": "John Doe",
    "email": "john@example.com"
  }
}
```

> Cookie `token` is also set automatically (httpOnly, 7 days).

### Response — Error `400`
```json
{ "message": "Please provide email and password" }
{ "message": "Invalid credentials" }
{ "message": "This account uses google sign-in. Please log in with google." }
{ "message": "This account uses microsoft sign-in. Please log in with microsoft." }
```

### Response — Server Error `500`
```json
{ "message": "Internal server error" }
```

---

## 3. Google Sign-In

**`GET /api/auth/google`**

Redirects the user to Google's OAuth consent page. No request body needed — open this URL directly in the browser (e.g., as an anchor/button link on the frontend).

### Request
No payload. Browser navigates to this URL.

### Response
`302 Redirect` → Google OAuth page

---

## 4. Google Callback

**`GET /api/auth/google/callback`**

Handled automatically by Google after the user approves. Do **not** call this manually.

### What happens internally
1. Exchanges the authorization `code` for tokens
2. Fetches user profile (name, email, googleId) from Google
3. Finds existing user by `googleId` → logs them in
4. If not found by `googleId`, checks by `email` → links Google to existing account
5. If no account at all → creates a new one with `authProvider: "google"`
6. Sets JWT cookie and redirects to frontend

### Redirect on Success
```
FRONTEND_URL/auth/callback?token=<jwt>&provider=google
```

### Redirect on Failure
```
FRONTEND_URL/auth/error?message=google_failed
```

---

## 5. Microsoft Sign-In

**`GET /api/auth/microsoft`**

Redirects the user to Microsoft's OAuth consent page. Open this URL directly in the browser.

### Request
No payload. Browser navigates to this URL.

### Response
`302 Redirect` → Microsoft OAuth page

---

## 6. Microsoft Callback

**`GET /api/auth/microsoft/callback`**

Handled automatically by Microsoft after the user approves. Do **not** call this manually.

### What happens internally
1. Exchanges the authorization `code` for tokens
2. Fetches user profile from Microsoft Graph API (`/me`)
3. Finds existing user by `microsoftId` → logs them in
4. If not found by `microsoftId`, checks by `email` → links Microsoft to existing account
5. If no account at all → creates a new one with `authProvider: "microsoft"`
6. Sets JWT cookie and redirects to frontend

### Redirect on Success
```
FRONTEND_URL/auth/callback?token=<jwt>&provider=microsoft
```

### Redirect on Failure
```
FRONTEND_URL/auth/error?message=microsoft_failed
```

---

## 7. Forgot Password

**`POST /api/auth/forgot-password`**

Sends a 6-digit OTP to the user's registered email. OTP is valid for **10 minutes**.

### Request Payload
```json
{
  "email": "john@example.com"
}
```

| Field   | Type   | Required |
|---------|--------|----------|
| `email` | String | Yes      |

### Response — Success `200`
```json
{
  "message": "If this email exists, an OTP has been sent."
}
```

> Same message is returned whether the email exists or not (prevents user enumeration).

### Response — Validation Error `400`
```json
{ "message": "Please provide your email." }
```

### Response — Server Error `500`
```json
{ "message": "Internal server error" }
```

---

## 8. Verify OTP

**`POST /api/auth/verify-otp`**

Validates the OTP entered by the user. On success, returns a **`resetToken`** (valid for **15 minutes**) to be used in Step 3.

### Request Payload
```json
{
  "email": "john@example.com",
  "otp": "482910"
}
```

| Field   | Type   | Required | Rules         |
|---------|--------|----------|---------------|
| `email` | String | Yes      | Registered email |
| `otp`   | String | Yes      | 6-digit code from email |

### Response — Success `200`
```json
{
  "message": "OTP verified.",
  "resetToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

| Field        | Description                                    |
|--------------|------------------------------------------------|
| `resetToken` | Short-lived JWT (15 min) — required in Step 3  |

### Response — Error `400`
```json
{ "message": "Email and OTP are required." }
{ "message": "Invalid or expired OTP." }
{ "message": "OTP has expired. Please request a new one." }
{ "message": "Invalid OTP." }
```

### Response — Server Error `500`
```json
{ "message": "Internal server error" }
```

---

## 9. Reset Password

**`POST /api/auth/reset-password`**

Sets a new password using the `resetToken` from Step 2. Use this when the user **does not know their old password**.

### Request Payload
```json
{
  "resetToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "newPassword": "newSecure456"
}
```

| Field         | Type   | Required | Rules                          |
|---------------|--------|----------|--------------------------------|
| `resetToken`  | String | Yes      | Token from `/verify-otp`       |
| `newPassword` | String | Yes      | Minimum 6 characters           |

### Response — Success `200`
```json
{
  "message": "Password reset successful. You can now log in."
}
```

### Response — Error `400`
```json
{ "message": "Reset token and new password are required." }
{ "message": "Password must be at least 6 characters." }
{ "message": "Invalid or expired reset token." }
{ "message": "Invalid reset token." }
{ "message": "Reset token already used or invalid." }
```

### Response — Server Error `500`
```json
{ "message": "Internal server error" }
```

> `resetToken` is consumed on success and **cannot be reused**.

---

## 10. Change Password

**`POST /api/auth/change-password`**

Changes the password after OTP verification. Use this when the user **knows their old password** and wants OTP as extra security.

### Request Payload
```json
{
  "resetToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "oldPassword": "currentPass123",
  "newPassword": "newSecure456"
}
```

| Field         | Type   | Required | Rules                          |
|---------------|--------|----------|--------------------------------|
| `resetToken`  | String | Yes      | Token from `/verify-otp`       |
| `oldPassword` | String | Yes      | User's current password        |
| `newPassword` | String | Yes      | Minimum 6 characters           |

### Response — Success `200`
```json
{
  "message": "Password changed successfully."
}
```

### Response — Error `400`
```json
{ "message": "Reset token, old password, and new password are required." }
{ "message": "New password must be at least 6 characters." }
{ "message": "Invalid or expired reset token." }
{ "message": "Invalid reset token." }
{ "message": "Reset token already used or invalid." }
{ "message": "Old password is incorrect." }
{ "message": "New password must be different from the old password." }
```

### Response — Server Error `500`
```json
{ "message": "Internal server error" }
```

> `resetToken` is consumed on success and **cannot be reused**.

---

## Token & Session Details

| Token | Type | Transport | Expiry | Used For |
|-------|------|-----------|--------|----------|
| `token` (auth) | JWT | httpOnly Cookie + JSON body | 7 days | All protected API routes |
| `resetToken` | JWT | JSON body only | 15 minutes | `/reset-password` and `/change-password` only |
| OTP state | bcrypt hash in DB | Email to user | 10 minutes | `/verify-otp` only |

---

## Environment Variables Required

| Variable | Description |
|----------|-------------|
| `JWT_SECRET` | Secret for signing all JWT tokens |
| `EMAIL_USER` | Gmail address for sending OTP emails |
| `EMAIL_PASS` | Gmail App Password (not account password) |
| `GOOGLE_CLIENT_ID` | Google OAuth app client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth app client secret |
| `GOOGLE_AUTH_REDIRECT_URI` | `http://localhost:5000/api/auth/google/callback` |
| `MICROSOFT_CLIENT_ID` | Azure app registration client ID |
| `MICROSOFT_CLIENT_SECRET` | Azure app registration client secret |
| `MICROSOFT_REDIRECT_URI` | `http://localhost:5000/api/auth/microsoft/callback` |
| `FRONTEND_URL` | `http://localhost:5174` (frontend base URL for OAuth redirects) |

---

## Frontend Integration Notes

### Using the JWT token
After login or social sign-in, the token is available in two ways:
- **Cookie** (`token`) — set automatically, sent automatically on every request if `credentials: "include"` is used
- **Response body** — also returned in JSON for SPAs that prefer header-based auth (`Authorization: Bearer <token>`)

### Social sign-in redirect handling
After Google/Microsoft callback, the frontend receives:
```
/auth/callback?token=<jwt>&provider=google
```
The frontend should:
1. Read `token` from the URL query params
2. Store it (if using header-based auth) OR rely on the cookie
3. Redirect the user to the dashboard
