# 📬 Mail-or-a — Deep API & Architecture Documentation

> **Runtime:** Node.js (CommonJS) · **Framework:** Express.js v5 · **Port:** 5000
> **Database:** MongoDB Atlas (Mongoose) · **Frontend:** `http://localhost:5174`

---

## 🧠 How the Server Boots

```
server.js
  ├── require("dotenv").config()         → load all .env variables into process.env
  ├── const app = require("./app")       → build the Express app (middleware + routes)
  ├── connectDB()                        → mongoose.connect(MONGO_URI)
  └── app.listen(5000)                   → start HTTP server
```

```
app.js — middleware pipeline (runs on EVERY request, in this order):
  1. cookieParser()          → parse req.cookies so JWT cookie is readable
  2. express.json()          → parse JSON request bodies into req.body
  3. cors({ origin, credentials: true }) → allow http://localhost:5174 with cookies
  4. helmet()                → set security HTTP headers (XSS, HSTS, etc.)
  5. morgan("dev")           → log every request: METHOD /path status ms
  6. Route handlers          → matched route runs its own middleware chain + controller
```

---

## 🔐 The Auth Middleware — `middlewares/auth.middleware.js`

This is **the core guard** used on every protected route. It runs **before** the controller.

### How `protect` works internally:

```
Request arrives at a protected route
      ↓
1. Read req.cookies.token
   → If missing → 401 { message: "Not authenticated" }
      ↓
2. jwt.verify(token, JWT_SECRET)
   → If invalid/expired → 401 { message: "Invalid or expired token" }
   → Returns decoded payload: { id: "<userId>", iat: ..., exp: ... }
      ↓
3. User.findById(decoded.id)
   → If no user in DB → 401 { message: "User not found" }
      ↓
4. req.user = user           ← injects full user document into the request
5. next()                    ← passes control to the controller
```

**What the token looks like:**
```json
{
  "id": "6632a1b3c4d5e6f7a8b9c0d1",
  "iat": 1745000000,
  "exp": 1745604800
}
```

**How the cookie is set (on login/social auth):**
```js
res.cookie("token", token, {
  httpOnly: true,          // JS in browser cannot read it — XSS safe
  secure: true,            // HTTPS only in production
  sameSite: "strict",      // not sent with cross-site requests — CSRF safe
  maxAge: 7 * 24 * 60 * 60 * 1000  // 7 days in milliseconds
});
```

---

---

# 📌 PART 1 — AUTH APIs (`/api/auth`)

> **File:** `modules/auth/auth.routes.js` + `auth.controller.js`
> **No authentication required** on any of these routes — they are all public.

---

## 1. `POST /api/auth/send-signup-otp`

**Purpose:** First step of signup — sends a 6-digit OTP to the user's email before any account is created.

### Request
```json
{ "email": "user@example.com" }
```

### Internal Flow (step by step)
```
1. Validate email is present → 400 if missing
2. Regex validate email format → 400 if invalid
3. User.findOne({ email })
   → If user already exists → 400 "Email already in use"
4. Generate OTP:
     otp = String(Math.floor(Math.random() * 900000) + 100000)  // 6-digit string
5. Hash OTP:
     hashedOtp = await bcrypt.hash(otp, 10)                     // bcrypt, 10 salt rounds
6. Set expiry:
     expiresAt = new Date(Date.now() + 10 * 60 * 1000)          // 10 minutes from now
7. PendingVerification.findOneAndUpdate(
     { email },
     { hashedOtp, expiresAt },
     { upsert: true }                // create if not exists, update if already there (resend)
   )
8. sendSignupOtpEmail(email, otp)
   → Nodemailer → Gmail SMTP → sends HTML email with OTP in large styled digits
9. res.json({ message: "OTP sent to your email. It is valid for 10 minutes." })
```

### Why OTP is hashed
The plain OTP is sent by email. Only the **bcrypt hash** is stored in MongoDB. If the DB is ever compromised, the attacker cannot learn the OTP.

### MongoDB impact
- `pendingverifications` collection: upserted with `{ email, hashedOtp, expiresAt }`
- TTL index on `expiresAt` → MongoDB **auto-deletes** the document after 10 minutes (no cron needed)

### Responses
| Status | Body |
|---|---|
| 200 | `{ message: "OTP sent..." }` |
| 400 | `{ message: "Email already in use." }` |
| 400 | `{ message: "Invalid email format." }` |
| 500 | `{ message: "Internal server error" }` |

---

## 2. `POST /api/auth/signup`

**Purpose:** Second step of signup — verifies OTP and creates the user account.

### Request
```json
{
  "name": "Nagu",
  "email": "user@example.com",
  "password": "mypassword",
  "otp": "482931"
}
```

### Internal Flow
```
1. Validate all fields present (name, email, password, otp) → 400 if any missing
2. Validate password length >= 6 → 400 if too short
3. Validate email format (regex) → 400 if invalid
4. PendingVerification.findOne({ email })
   → If no record → 400 "No OTP found. Please request one first."
5. Check pending.expiresAt > now
   → If expired → deleteOne({ email }) → 400 "OTP has expired."
6. bcrypt.compare(otp, pending.hashedOtp)
   → If mismatch → 400 "Invalid OTP."
7. User.findOne({ email }) [race condition check]
   → If user was created between step 1 and now → 400 "Email already in use."
8. Hash password:
     hashed = await bcrypt.hash(password, 10)
9. User.create({ name, email, password: hashed })
   → authProvider defaults to "local"
10. PendingVerification.deleteOne({ email })  ← clean up OTP record
11. res.status(201).json({ message: "Account created successfully.", user: { _id, name, email } })
```

### What's stored in the User document
```json
{
  "name": "Nagu",
  "email": "user@example.com",
  "password": "$2b$10$...(bcrypt hash)...",
  "authProvider": "local",
  "reminderPreferences": { "whatsapp": true, "email": true },
  "createdAt": "...",
  "updatedAt": "..."
}
```

### Note — No JWT issued here
The signup response does **not** set a cookie. The user must separately call `/login` to get a session.

### Responses
| Status | Body |
|---|---|
| 201 | `{ message: "Account created successfully.", user: { _id, name, email } }` |
| 400 | `{ message: "Invalid OTP." }` |
| 400 | `{ message: "OTP has expired." }` |
| 400 | `{ message: "No OTP found..." }` |
| 500 | `{ message: "Internal server error" }` |

---

## 3. `POST /api/auth/login`

**Purpose:** Authenticates a local user and issues a JWT session cookie.

### Request
```json
{ "email": "user@example.com", "password": "mypassword" }
```

### Internal Flow
```
1. Validate email + password present → 400 if missing
2. User.findOne({ email }).select("+password")
   → password field has select:false in schema — must explicitly select it
   → If no user → 400 "Invalid credentials"
3. Check user.authProvider === "local"
   → If "google" or "microsoft" → 400 "This account uses Google sign-in..."
   → This prevents OAuth users from logging in via password
4. Check user.password exists
   → Social accounts have no password — extra safety guard
5. bcrypt.compare(password, user.password)
   → If no match → 400 "Invalid credentials"
6. generateToken(user._id)
   → jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: "7d" })
7. res.cookie("token", token, { httpOnly, secure, sameSite, maxAge: 7d })
8. res.json({ message: "Login successful", token, user: { _id, name, email } })
   → Note: token is sent both in cookie AND response body
   → Cookie is for browser auto-attach; body is for mobile clients
```

### Responses
| Status | Body |
|---|---|
| 200 | `{ message: "Login successful", token, user: { _id, name, email } }` |
| 400 | `{ message: "Invalid credentials" }` |
| 400 | `{ message: "This account uses Google sign-in..." }` |
| 500 | `{ message: "Internal server error" }` |

---

## 4. `POST /api/auth/forgot-password`

**Purpose:** Sends password reset email links. Designed to not reveal whether the email exists (prevents user enumeration).

### Request
```json
{ "email": "user@example.com" }
```

### Internal Flow
```
1. Validate email present → 400 if missing
2. User.findOne({ email })
   → If no user → res.json({ message: "If this email exists, a reset link has been sent." })
     ↑ Same vague message whether user exists or not — prevents email enumeration attacks
3. Generate OTP:
     otp = String(Math.floor(Math.random() * 900000) + 100000)
4. Hash OTP:
     hashedOtp = await bcrypt.hash(otp, 10)
5. Store on User document:
     user.passwordResetOtp = hashedOtp
     user.passwordResetOtpExpiry = Date.now() + 10min
     await user.save()
6. Encrypt email for URL:
     encryptedEmail = encodeURIComponent(encrypt(email))
     → AES-256-CBC → hex string → URL-encoded
     → This hides the plain email from appearing in the reset link
7. Build links:
     resetLink  = FRONTEND_URL/reset-password?otp={otp}&email={encryptedEmail}
     changeLink = FRONTEND_URL/change-password?otp={otp}&email={encryptedEmail}
8. Send BOTH emails:
     sendResetPasswordEmail(email, resetLink)   ← for users who forgot password entirely
     sendChangePasswordEmail(email, changeLink) ← for users who know their old password
9. res.json({ message: "If this email exists, a reset link has been sent." })
```

### Why two different links?
- `/reset-password` → user **does not** know old password → only OTP needed
- `/change-password` → user **knows** old password → OTP + old password required → more secure

### Security Design
- The **plain OTP** is in the URL query param (sent by email link)
- The **email** is AES-256 encrypted in the URL — not readable to a passive observer
- The **hashed OTP** is in DB — the plain one cannot be recovered from it

### Responses
| Status | Body |
|---|---|
| 200 | `{ message: "If this email exists, a reset link has been sent." }` |
| 400 | `{ message: "Please provide your email." }` |
| 500 | `{ message: "Internal server error" }` |

---

## 5. `POST /api/auth/reset-password`

**Purpose:** Reset password using link from email (user does NOT know old password).

### Request
```json
{
  "encryptedEmail": "a1b2c3d4:hexhexhex...",
  "otp": "482931",
  "newPassword": "newpass123"
}
```

### Internal Flow
```
1. Validate all 3 fields present → 400 if missing
2. Validate newPassword.length >= 6
3. Decrypt email:
     email = decrypt(decodeURIComponent(encryptedEmail))
     → If decryption fails → 400 "Invalid request."
4. User.findOne({ email }).select("+passwordResetOtp +passwordResetOtpExpiry")
   → Both fields are select:false — must be explicitly selected
   → If no user or no OTP fields → 400 "Invalid or expired OTP."
5. Check user.passwordResetOtpExpiry > now
   → If expired → 400 "OTP has expired."
6. bcrypt.compare(otp, user.passwordResetOtp)
   → If mismatch → 400 "Invalid OTP."
7. Hash new password:
     user.password = await bcrypt.hash(newPassword, 10)
8. Clear OTP fields:
     user.passwordResetOtp = undefined
     user.passwordResetOtpExpiry = undefined
9. await user.save()
10. res.json({ message: "Password reset successful. You can now log in." })
```

### Responses
| Status | Body |
|---|---|
| 200 | `{ message: "Password reset successful." }` |
| 400 | `{ message: "Invalid OTP." }` |
| 400 | `{ message: "OTP has expired." }` |
| 400 | `{ message: "Invalid request." }` |
| 500 | `{ message: "Internal server error" }` |

---

## 6. `POST /api/auth/change-password`

**Purpose:** Change password using email link (user KNOWS their old password — more secure flow).

### Request
```json
{
  "encryptedEmail": "a1b2c3d4:hexhexhex...",
  "otp": "482931",
  "oldPassword": "currentpass",
  "newPassword": "newpass123"
}
```

### Internal Flow
```
1. Validate all 4 fields present → 400 if missing
2. Validate newPassword.length >= 6
3. Decrypt email (same as reset-password step 3)
4. User.findOne({ email }).select("+password +passwordResetOtp +passwordResetOtpExpiry")
5. Check user exists + OTP fields exist → 400 if not
6. Check OTP not expired → 400 if expired
7. bcrypt.compare(otp, user.passwordResetOtp) → 400 if mismatch
8. bcrypt.compare(oldPassword, user.password)
   → If old password wrong → 400 "Old password is incorrect."
9. Check oldPassword !== newPassword
   → 400 "New password must be different from the old password."
10. Hash new password + clear OTP fields + save
11. res.json({ message: "Password changed successfully." })
```

**Difference from reset:** Steps 8 and 9 are the extra verification — old password must be correct AND new must differ.

### Responses
| Status | Body |
|---|---|
| 200 | `{ message: "Password changed successfully." }` |
| 400 | `{ message: "Old password is incorrect." }` |
| 400 | `{ message: "New password must be different..." }` |
| 400 | `{ message: "Invalid OTP." }` |
| 500 | `{ message: "Internal server error" }` |

---

---

# 📌 PART 2 — SOCIAL AUTH APIs (`/api/auth`)

> **File:** `modules/auth/socialAuth.routes.js` + `socialAuth.controller.js`
> **No JWT required** — these initiate/complete OAuth flows.

---

## 7. `GET /api/auth/google`

**Purpose:** Start Google Sign-In / Sign-Up. Redirects browser to Google.

### Internal Flow
```
1. getGoogleOAuthClient(GOOGLE_AUTH_REDIRECT_URI)
   → new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI)
2. Create CSRF state token:
     state = jwt.sign({ purpose: "google-auth" }, JWT_SECRET, { expiresIn: "10m" })
     → Signed JWT — verifiable; cannot be forged without knowing JWT_SECRET
3. Build Google Auth URL with scopes: ["openid", "profile", "email"]
   → access_type: "offline" (get refresh_token)
   → prompt: "select_account" (show account picker)
4. res.redirect(authUrl)  ← browser goes to Google
```

### Why a state token (not just a random string)?
Using a JWT as state means: the backend can verify it was issued by itself without needing to store anything in session/DB.

---

## 8. `GET /api/auth/google/callback`

**Purpose:** Google redirects back here after user consents. Creates or links the user account.

### Query Params received from Google
```
?code=4/0AY0e-g7...   &state=eyJhb...
```

### Internal Flow
```
1. Validate code + state present → 400 if missing
2. Verify state JWT:
     decoded = jwt.verify(state, JWT_SECRET)
     → Check decoded.purpose === "google-auth"
     → If invalid/expired → 400 "Invalid or expired state." (CSRF attempt rejected)
3. getGoogleOAuthClient(GOOGLE_AUTH_REDIRECT_URI)
4. Exchange code for tokens:
     { tokens } = await oauthClient.getToken(code)
     → tokens: { access_token, refresh_token, id_token, expiry_date }
5. Set credentials on client:
     oauthClient.setCredentials(tokens)
6. Fetch Google profile:
     oauth2 = google.oauth2({ version: "v2", auth: oauthClient })
     { data: profile } = await oauth2.userinfo.get()
     → profile: { id, name, email, picture, ... }
7. Validate profile.email exists → 400 if missing
8. Find or create user logic:
     a) User.findOne({ googleId: profile.id })
        → Found → existing Google user → skip to step 9
     b) Not found → User.findOne({ email: profile.email })
        → Found → local account with same email → link Google to it:
             user.googleId = profile.id
             user.authProvider = "google"
             await user.save()
        → Not found → Brand new user:
             User.create({ name, email, googleId, authProvider: "google" })
9. generateToken(user._id) → jwt.sign({ id }, JWT_SECRET, { expiresIn: "7d" })
10. setAuthCookie(res, token) → HttpOnly cookie
11. res.redirect(FRONTEND_URL/auth/callback?token={token}&provider=google)
    → Frontend reads the token from URL params and stores it if needed
```

### On error:
```
res.redirect(FRONTEND_URL/auth/error?message=google_failed)
```

---

## 9. `GET /api/auth/microsoft`

**Purpose:** Start Microsoft Sign-In. Redirects to Azure AD.

### Internal Flow
```
1. Create CSRF state token:
     state = jwt.sign({ purpose: "microsoft-auth" }, JWT_SECRET, { expiresIn: "10m" })
2. getMicrosoftAuthUrl(state):
     params = { client_id, response_type: "code", redirect_uri, scope: "openid profile email User.Read", state }
     authUrl = https://login.microsoftonline.com/common/oauth2/v2.0/authorize?{params}
     → "common" tenant = supports both personal + work/school accounts
3. res.redirect(authUrl)
```

---

## 10. `GET /api/auth/microsoft/callback`

**Purpose:** Azure AD redirects back here after user consents.

### Internal Flow
```
1. Validate code + state → 400 if missing
2. Verify state JWT → decoded.purpose must be "microsoft-auth"
3. getMicrosoftTokens(code):
     POST https://login.microsoftonline.com/common/oauth2/v2.0/token
     Body: { client_id, client_secret, code, redirect_uri, grant_type: "authorization_code" }
     Returns: { access_token, refresh_token, expires_in, ... }
4. getMicrosoftProfile(tokenData.access_token):
     GET https://graph.microsoft.com/v1.0/me
     Headers: { Authorization: "Bearer {access_token}" }
     Returns: { id, displayName, mail, userPrincipalName, ... }
5. email = profile.mail || profile.userPrincipalName
   → Microsoft returns email in different fields depending on account type
6. Find or create user (same logic as Google callback):
     findOne({ microsoftId }) → findOne({ email }) → create new
7. generateToken → setAuthCookie → redirect to frontend
```

---

---

# 📌 PART 3 — GMAIL ACCOUNT CONNECTION (`/api/google`)

> **File:** `modules/auth/google.routes.js` + `google.controller.js`
> **⚠️ Different from social auth!** This connects a Gmail inbox for email tracking — NOT for sign-in.
> **Requires:** User to be logged in (JWT cookie)

---

## 11. `GET /api/google` → `protect` middleware → `googleAuth`

**Purpose:** Start Gmail connection for a **logged-in** user. Asks for `gmail.readonly` + `gmail.modify` scopes.

### Middleware Chain
```
Request: GET /api/google
      ↓
protect middleware:
  1. Read token from req.cookies.token
  2. jwt.verify(token) → decoded.id
  3. User.findById(decoded.id) → req.user = user
  4. next()
      ↓
googleAuth controller:
  1. getGoogleOAuthClient() ← uses GOOGLE_REDIRECT_URI (not GOOGLE_AUTH_REDIRECT_URI)
  2. Create state JWT:
       stateToken = jwt.sign({ userId: req.user._id.toString() }, JWT_SECRET, { expiresIn: "10m" })
       → userId is embedded in state so we know WHO is connecting their Gmail
  3. Build authUrl with scopes:
       ["https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/gmail.modify"]
     access_type: "offline" → get refresh_token
     prompt: "consent"      → always show consent screen (forces refresh_token generation)
  4. res.redirect(authUrl)
```

### Why `prompt: "consent"` here but `prompt: "select_account"` for sign-in?
- For sign-in: just pick the account
- For Gmail connection: must force consent screen every time — otherwise Google won't return a new `refresh_token`

---

## 12. `GET /api/google/callback` → `googleCallback`

**Purpose:** Complete Gmail connection. Starts Gmail watch() for real-time push.

### No `protect` middleware here — state JWT carries the userId

### Internal Flow
```
1. Validate code + state present
2. Verify state JWT → decoded.userId
3. getGoogleOAuthClient()    ← default GOOGLE_REDIRECT_URI
4. Exchange code for tokens: { tokens } = await oauthClient.getToken(code)
5. oauthClient.setCredentials(tokens)
6. Get Gmail client: gmail = google.gmail({ version: "v1", auth: oauthClient })
7. Get Gmail profile:
     profile = await gmail.users.getProfile({ userId: "me" })
     emailAddress = profile.data.emailAddress
8. Check account limit:
     count = await ConnectedAccount.countDocuments({ userId })
     → If >= 3 → 400 "Maximum 3 connected email accounts allowed"
9. Start Gmail push notifications:
     watchResponse = await gmail.users.watch({
       userId: "me",
       requestBody: {
         topicName: GOOGLE_PUBSUB_TOPIC,  // "projects/.../topics/gmail-notifications"
         labelIds: ["INBOX"]              // only watch INBOX changes
       }
     })
     → Returns: { historyId, expiration }
     → historyId = the current history marker (we'll diff from this point)
10. Save Connected Account:
     ConnectedAccount.create({
       userId,
       provider: "google",
       emailAddress,
       accessToken: tokens.access_token,
       refreshToken: tokens.refresh_token,
       tokenExpiry: new Date(tokens.expiry_date),
       lastHistoryId: watchResponse.data.historyId,
       isActive: true
     })
11. res.json({ message: "Gmail connected successfully", email: emailAddress })
```

### What `watch()` does
Google's Gmail API `watch()` tells Google: _"Push a Pub/Sub message to my topic whenever this inbox changes"_. The messages arrive at `/webhook/gmail`.

### Note: watch() expires after 7 days
The subscription must be renewed before it expires — this renewal logic using `node-cron` is **not yet implemented**.

---

---

# 📌 PART 4 — USER APIs (`/api/user`)

> **File:** `modules/user/user.routes.js` + `user.controller.js`
> **All routes require:** `protect` middleware (JWT cookie)

---

## 13. `GET /api/user/me` → `protect` → `getProfile`

**Purpose:** Return the current user's full profile.

### Middleware Chain
```
GET /api/user/me
      ↓
protect:
  1. Verify JWT cookie → req.user = User document
      ↓
getProfile:
  1. User.findById(req.user._id)
     → Returns all fields EXCEPT password, passwordResetOtp, passwordResetOtpExpiry
       (those have select:false in schema)
  2. res.json(user)
```

### Response Example
```json
{
  "_id": "6632a1b3c4d5e6f7a8b9c0d1",
  "name": "Nagu",
  "email": "nagu@example.com",
  "authProvider": "local",
  "mobileNumber": "+919876543210",
  "countryCode": "+91",
  "isMobileVerified": false,
  "reminderPreferences": { "whatsapp": true, "email": true },
  "extractedSkills": ["React", "Node.js", "MongoDB"],
  "createdAt": "2026-04-01T00:00:00.000Z"
}
```

---

## 14. `PUT /api/user/update` → `protect` → `updateProfile`

**Purpose:** Update mobile number, country code, and reminder preferences.

### Request
```json
{
  "mobileNumber": "9876543210",
  "countryCode": "+91",
  "reminderPreferences": { "whatsapp": false, "email": true }
}
```

### Internal Flow
```
protect middleware → req.user set
      ↓
updateProfile:
  1. Destructure { mobileNumber, countryCode, reminderPreferences } from req.body
  2. User.findById(req.user._id)
  3. Conditionally update fields (only if provided):
       if (mobileNumber) user.mobileNumber = mobileNumber
       if (countryCode)  user.countryCode = countryCode
       if (reminderPreferences) user.reminderPreferences = reminderPreferences
  4. await user.save()
  5. res.json({ message: "Profile updated", user })
```

**Note:** Fields not sent in the request body are **not changed** — partial updates supported.

---

## 15. `POST /api/user/upload-resume` → `protect` → `upload.single("file")` → `uploadResume`

**Purpose:** Upload a resume PDF or DOCX, parse its text, extract skills using Gemini AI, save to user.

### Middleware Chain (3 middlewares before controller)
```
POST /api/user/upload-resume
      ↓
1. protect middleware → validates JWT cookie → req.user set
      ↓
2. upload.single("file")  ← Multer middleware
   - Field name must be "file" in form-data
   - Checks MIME type:
       Allowed: "application/pdf"
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
       Others → Error "Only PDF and DOCX allowed"
   - Saves file to uploads/ with name: Date.now() + "-" + originalname
   - Injects req.file: { path, mimetype, originalname, ... }
      ↓
3. uploadResume controller:
   1. filePath = req.file.path  (e.g. "uploads/1714000000000-resume.pdf")
   2. dataBuffer = await fs.promises.readFile(filePath)
   3. Extract text:
        if PDF  → pdfParse(dataBuffer) → extractedText = parsed.text
        if DOCX → mammoth.extractRawText({ buffer }) → extractedText = result.value
   4. Gemini AI skill extraction:
        skills = await extractSkills(extractedText)
        → Prompt: "Extract only technical skills. Return a JSON array of strings."
        → Model: gemini-2.5-flash with responseMimeType: "application/json"
        → Returns: ["React", "Node.js", "MongoDB", "Python", ...]
   5. Save to user:
        user.resumeUrl = filePath
        user.extractedSkills = skills
        await user.save()
   6. Cleanup: fs.promises.unlink(filePath)  ← delete file from disk after processing
   7. res.json({ message: "Resume processed", skills })
```

### Request Format
```
POST /api/user/upload-resume
Content-Type: multipart/form-data

file: [your resume.pdf or resume.docx]
```

### Response
```json
{
  "message": "Resume processed",
  "skills": ["React", "TypeScript", "Node.js", "MongoDB", "Docker", "AWS"]
}
```

---

---

# 📌 PART 5 — CONNECTED ACCOUNTS (`/api/accounts`)

> **File:** `modules/connectedAccount/connectedAccount.routes.js` + `connectedAccount.controller.js`
> **Requires:** `protect` middleware

---

## 16. `GET /api/accounts` → `protect` → `getAccounts`

**Purpose:** List all email accounts the user has connected.

### Internal Flow
```
protect → req.user
      ↓
getAccounts:
  1. ConnectedAccount.find({ userId: req.user._id })
     .select("-accessToken -refreshToken")    ← never expose tokens to frontend
  2. res.json(accounts)
```

### Response Example
```json
[
  {
    "_id": "6640abc123...",
    "userId": "6632a1b3...",
    "provider": "google",
    "emailAddress": "nagu@gmail.com",
    "tokenExpiry": "2026-04-25T10:00:00.000Z",
    "lastHistoryId": "987654",
    "isActive": true,
    "createdAt": "2026-04-20T00:00:00.000Z"
  }
]
```

**Tokens are excluded from response** (`-accessToken -refreshToken`) — they are sensitive OAuth credentials stored encrypted in DB and only used server-side.

---

---

# 📌 PART 6 — EMAIL APIs (`/api/emails`)

> **File:** `modules/email/email.routes.js` + `email.controller.js`
> **All routes require:** `protect` middleware
> **All emails are decrypted on-the-fly before being returned**

### The 4 Stage Models
| Model | Collection | Stage Meaning |
|---|---|---|
| `RegistrationEmail` | `registrationemails` | Job/internship/hackathon application CTA — "Apply Now" |
| `RegisteredEmail` | `registeredemails` | "Application received" / "Successfully registered" |
| `InProgressEmail` | `inprogressemails` | Interviews, coding rounds, assessment tests |
| `ConfirmedEmail` | `confirmedemails` | Offer letters, onboarding, acceptance |

### How decryption works in the controller
```js
function decryptEmail(email, type) {
  return {
    ...email._doc,       // spread all raw MongoDB fields
    type,                // inject the stage type string
    subject: decrypt(email.subject),  // AES-256-CBC decrypt
    from:    decrypt(email.from),
    snippet: decrypt(email.snippet),
    body:    decrypt(email.body),
  };
}
```

**All 4 text fields** (`subject`, `from`, `snippet`, `body`) are stored encrypted and decrypted only when fetched. The `userId`, `receivedAt`, `category`, `deadlineDate` etc. are stored unencrypted.

---

## 17. `GET /api/emails` → `protect` → `getAllEmails`

**Purpose:** Return ALL emails for the user across all 4 stages, sorted by newest first.

### Internal Flow
```
protect → req.user
      ↓
getAllEmails:
  1. Run 4 queries IN PARALLEL using Promise.all:
       RegistrationEmail.find({ userId: req.user._id }).sort({ receivedAt: -1 })
       RegisteredEmail.find(...)
       InProgressEmail.find(...)
       ConfirmedEmail.find(...)
  2. Decrypt every document in all 4 result sets
  3. Flatten all results into one array
  4. Re-sort the flat array by receivedAt descending (cross-collection sort)
  5. res.json(all)
```

### Performance Note
All 4 DB queries run in parallel (not sequential) using `Promise.all` — so latency = slowest single query, not the sum of all 4.

---

## 18–21. `GET /api/emails/registration` | `/registered` | `/inprogress` | `/confirmed`

**Purpose:** Get emails from a single specific stage only.

### Internal Flow (same pattern for all 4)
```
protect → req.user
      ↓
get[Stage]Emails:
  1. [StageModel].find({ userId: req.user._id }).sort({ receivedAt: -1 })
  2. emails.map(e => decryptEmail(e, "[stage]"))
  3. res.json(decryptedEmails)
```

---

---

# 📌 PART 7 — GMAIL WEBHOOK (`/webhook/gmail`)

> **File:** `webhooks/gmail.webhook.js` + `gmail.webhook.controller.js`
> **No auth middleware** — called by Google's Pub/Sub service, not by a user
> **Optional security:** `WEBHOOK_SECRET` env var check

---

## 22. `POST /webhook/gmail`

**Purpose:** Receive real-time Gmail change notifications from Google Cloud Pub/Sub. This is the **heart of the email pipeline**.

### How Google Pub/Sub works with this endpoint

```
User connects Gmail → gmail.users.watch() called
                     ↓
             Google starts watching INBOX
                     ↓
     New email arrives in user's Gmail INBOX
                     ↓
Google Pub/Sub pushes a message to:
  POST https://your-server.com/webhook/gmail
  Body: { "message": { "data": "<base64>", "messageId": "..." } }
                     ↓
   This controller handles it
```

### Internal Flow (deeply detailed)
```
1. Optional webhook secret check:
     if (WEBHOOK_SECRET && req.query.token !== WEBHOOK_SECRET) → 403

2. Read Pub/Sub message:
     message = req.body.message
     → If no message → sendStatus(200)  ← always 200 to Pub/Sub or it retries forever

3. Decode Pub/Sub payload:
     raw = Buffer.from(message.data, "base64").toString("utf-8")
     { emailAddress, historyId } = JSON.parse(raw)

4. Find the ConnectedAccount:
     account = ConnectedAccount.findOne({
       emailAddress,
       provider: "google",
       isActive: true
     })
     → If not found → sendStatus(200)  ← not our user, ignore

5. fetchNewEmails(account, historyId)   ← internal async function
   ↓
   5a. Check account.lastHistoryId exists:
         → If missing → save new historyId and return (can't diff without a start point)

   5b. Refresh Google OAuth token if expired:
         oauthClient = await refreshGoogleTokenIfNeeded(account)
         → Checks: new Date() >= account.tokenExpiry
         → If expired → oauthClient.refreshAccessToken()
           → Updates account.accessToken + account.tokenExpiry in DB

   5c. Get Gmail History API client:
         gmail = google.gmail({ version: "v1", auth: oauthClient })

   5d. Fetch history delta:
         response = await gmail.users.history.list({
           userId: "me",
           startHistoryId: account.lastHistoryId  ← only changes since last known point
         })
         → If no history (empty inbox change) → update lastHistoryId → return

   5e. Loop through history records:
         for each record in response.data.history:
           for each msgObj in record.messagesAdded:
             msg = msgObj.message
             → Skip if not in INBOX (filter by msg.labelIds.includes("INBOX"))

   5f. Fetch full email content:
         fullMessage = await gmail.users.messages.get({ userId: "me", id: msg.id })
         headers = fullMessage.data.payload.headers
         subject = headers.find(h => h.name === "Subject")?.value
         from    = headers.find(h => h.name === "From")?.value
         snippet = fullMessage.data.snippet

   5g. Extract email body (recursive MIME traversal):
         extractBody(payload, snippet):
           → Direct body.data? → base64url decode → return text
           → Recursively flatten all MIME parts
           → Look for text/plain part first → base64url decode
           → Fallback to text/html → base64url decode
           → Fallback to any part with data
           → Final fallback to snippet

   5h. Classify email with Gemini AI:
         aiResult = await classifyEmail(subject, snippet)
         → Sends prompt to gemini-2.5-flash with classification rules
         → Returns: { category, stage, deadline }
         category options: "job" | "internship" | "hackathon" | "workshop" | "other"
         stage options:    "registration" | "registered" | "inprogress" | "confirmed" | "other"

   5i. Filter non-tracked emails:
         → If category === "other" → skip (log "⏭️ Skipping")
         → If stage === "other"    → skip (log "⏭️ Skipping")

   5j. Get the correct model:
         getModelForStage(stage):
           "registration" → RegistrationEmail
           "registered"   → RegisteredEmail
           "inprogress"   → InProgressEmail
           "confirmed"    → ConfirmedEmail

   5k. Encrypt all text fields:
         subject: encrypt(subject)   ← AES-256-CBC with random IV each time
         from:    encrypt(from)
         snippet: encrypt(snippet)
         body:    encrypt(emailBody)

   5l. Build base document:
         {
           userId, connectedAccountId, provider: "google",
           providerMessageId: msg.id,  ← Gmail message ID (used for dedup)
           subject, from, snippet, body,  ← all encrypted
           receivedAt: new Date(parseInt(fullMessage.data.internalDate)),
           category, aiProcessed: true,
           expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000)  ← 3 months TTL
         }

   5m. Save to correct model:
         if stage === "registration":
           deadlineDate = new Date(deadline)  ← from Gemini
           If no deadline → default to tomorrow
           RegistrationEmail.create({ ...baseDoc, deadlineDate })
         else:
           Model.create(baseDoc)

   5n. Handle duplicates:
         catch err.code === 11000 → log "⚠️ Duplicate skipped"
         (providerMessageId + provider is a unique compound index)

   5o. Update lastHistoryId:
         account.lastHistoryId = newHistoryId
         await account.save()

6. res.sendStatus(200)  ← always 200 for Pub/Sub compliance
```

### Why always return 200?
Google Pub/Sub will **retry** any push that doesn't return 200. If there's an error, we still return 200 to avoid Pub/Sub flooding the server with retries. Errors are logged internally.

### Email Encryption: How AES-256-CBC works
```
KEY = sha256(EMAIL_ENCRYPTION_KEY) → 32-byte key
IV  = crypto.randomBytes(16)       → 16-byte random initialization vector (unique per encrypt)

encrypt(text):
  → cipher = createCipheriv("aes-256-cbc", key, iv)
  → encrypted = cipher.update(text, "utf8", "hex") + cipher.final("hex")
  → stored as: iv.toString("hex") + ":" + encrypted  (e.g. "a1b2c3d4e5f6...:4f9aab...")

decrypt(stored):
  → split on ":" → iv part + encrypted part
  → decipher = createDecipheriv("aes-256-cbc", key, iv)
  → plain = decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8")
```

Each encrypt call uses a **new random IV**, so the same text encrypted twice produces different ciphertext — safe from pattern analysis.

---

---

# 📌 PART 8 — OTP EMAIL SERVICE

> **File:** `services/otp.email.service.js`
> Used internally by auth.controller.js — not directly exposed as an API.

### Nodemailer Transport Setup
```js
nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.EMAIL_USER,  // your Gmail address
    pass: process.env.EMAIL_PASS   // Google App Password (NOT account password)
  }
})
```

### Three Email Templates
| Function | Subject | Trigger |
|---|---|---|
| `sendSignupOtpEmail(to, otp)` | "Verify Your Email — Mail-or-a" | `POST /api/auth/send-signup-otp` |
| `sendResetPasswordEmail(to, link)` | "Reset Your Password" | `POST /api/auth/forgot-password` |
| `sendChangePasswordEmail(to, link)` | "Change Your Password" | `POST /api/auth/forgot-password` |

---

---

# 📌 PART 9 — TOKEN REFRESH MECHANISM

> **File:** `services/google.service.js` — `refreshGoogleTokenIfNeeded(account)`

**Called from:** Gmail webhook controller before every Gmail API call.

```
refreshGoogleTokenIfNeeded(account):
  1. Create OAuth client with stored credentials:
       oauthClient.setCredentials({
         access_token:  account.accessToken,
         refresh_token: account.refreshToken
       })
  2. Check expiry:
       if (new Date() >= account.tokenExpiry):
         credentials = await oauthClient.refreshAccessToken()
         account.accessToken = credentials.access_token
         account.tokenExpiry = new Date(credentials.expiry_date)
         await account.save()    ← persist refreshed token to DB
  3. return oauthClient          ← ready to use
```

This means the system **never fails** due to expired Google tokens — it auto-refreshes silently.

---

---

# 📌 PART 10 — AI SERVICES

## Gemini — Email Classifier (`services/emailAI.service.js`)

```
classifyEmail(subject, body):
  Model: gemini-2.5-flash
  responseMimeType: "application/json"  ← forces Gemini to return raw JSON, not markdown

  Prompt includes:
    - Today's date (for deadline inference)
    - Tomorrow's date (default deadline for applicable stages)
    - Classification rules
    - Subject and body of the email

  Returns: { category, stage, deadline }
```

### Classification Rules (embedded in prompt)
| Output Field | Values | Logic |
|---|---|---|
| `category` | `job` · `internship` · `hackathon` · `workshop` · `other` | What type of opportunity is this? |
| `stage` | `registration` · `registered` · `inprogress` · `confirmed` · `other` | Where is the user in the process? |
| `deadline` | `YYYY-MM-DD` or `null` | When is the deadline? |

- Stage `"registration"` or `"inprogress"` with no explicit deadline → default to **tomorrow**
- Stage `"registered"` or `"confirmed"` → deadline is always **null** (no action needed)

## Gemini — Resume Skill Extractor (`services/gemini.service.js`)

```
extractSkills(resumeText):
  Model: gemini-2.5-flash
  responseMimeType: "application/json"

  Prompt: "Extract only technical skills from this resume text. Return a JSON array of strings."

  Input: raw text from PDF/DOCX
  Output: ["React", "Node.js", "Python", "Docker", ...]
```

---

---

# 🔄 Full End-to-End Flow Diagrams

## Signup → Login Flow
```
User → POST /send-signup-otp
           ↓
     [DB] PendingVerification upserted (hashed OTP, 10min TTL)
           ↓
     [Email] OTP sent via Nodemailer
           ↓
User → POST /signup (email + password + OTP)
           ↓
     OTP verified (bcrypt) → User created in DB → PendingVerification deleted
           ↓
User → POST /login (email + password)
           ↓
     JWT generated → HttpOnly cookie set
           ↓
     → Subsequent requests: cookie auto-sent → protect middleware validates → req.user set
```

## Gmail Email Tracking Flow
```
User (logged in) → GET /api/google  (protect middleware validates session)
       ↓
  Redirect to Google OAuth consent (gmail.readonly + gmail.modify)
       ↓
  GET /api/google/callback (with code + state JWT)
       ↓
  Tokens exchanged → gmail.users.watch() called → Pub/Sub subscription created
       ↓
  [DB] ConnectedAccount saved with tokens + lastHistoryId
       ↓

-- Later: new email arrives --
       ↓
  Google Pub/Sub → POST /webhook/gmail
       ↓
  Pub/Sub message decoded → emailAddress + historyId
       ↓
  [DB] ConnectedAccount looked up → token refreshed if needed
       ↓
  gmail.users.history.list(startHistoryId) → new message IDs
       ↓
  gmail.users.messages.get(id) → full message
       ↓
  extractBody() → full text (MIME recursive traversal)
       ↓
  classifyEmail(subject, snippet) → Gemini AI → { category, stage, deadline }
       ↓
  Encrypt all fields (AES-256-CBC)
       ↓
  [DB] Save to correct stage model (RegistrationEmail / RegisteredEmail / etc.)
       ↓
  account.lastHistoryId updated → next webhook starts from here
       ↓
  User → GET /api/emails → decrypted emails returned sorted by date
```

---

---

# 🗂️ Database Schema Reference

## User
```
Field                    Type      Default    Notes
───────────────────────────────────────────────────────────────
_id                      ObjectId              Auto
name                     String    required
email                    String    unique+idx  lowercase
password                 String    select:false  bcrypt hash
authProvider             String    "local"     local|google|microsoft
googleId                 String    sparse+unique
microsoftId              String    sparse+unique
mobileNumber             String    sparse+unique
countryCode              String    "+91"
isMobileVerified         Boolean   false
reminderPreferences      Object    {whatsapp:true, email:true}
resumeUrl                String
extractedSkills          [String]
passwordResetOtp         String    select:false  bcrypt hash
passwordResetOtpExpiry   Date      select:false
createdAt / updatedAt    Date      auto (timestamps:true)
```

## PendingVerification
```
Field      Type    Notes
────────────────────────────────────────
email      String  unique, lowercase
hashedOtp  String  bcrypt hash of 6-digit OTP
expiresAt  Date    TTL index → auto-delete after expiry (10min)
```

## ConnectedAccount
```
Field              Type      Notes
───────────────────────────────────────────────────────────────
userId             ObjectId  ref: User, indexed
provider           String    google|microsoft
emailAddress       String    unique per userId (compound index)
accessToken        String    OAuth access token (sensitive)
refreshToken       String    OAuth refresh token (sensitive)
tokenExpiry        Date
lastHistoryId      String    Gmail only — history sync marker
subscriptionId     String    Outlook only (not yet implemented)
subscriptionExpiry Date      Outlook only (not yet implemented)
isActive           Boolean   default: true
createdAt/updatedAt Date     auto
```

## Email Stage Models (same schema for all 4)
```
Field              Type      Notes
───────────────────────────────────────────────────────────────
userId             ObjectId  ref: User, indexed
connectedAccountId ObjectId  ref: ConnectedAccount
provider           String    google|microsoft
providerMessageId  String    Gmail message ID (unique per provider, dedup guard)
subject            String    AES-256 encrypted
from               String    AES-256 encrypted
snippet            String    AES-256 encrypted
body               String    AES-256 encrypted (full body)
receivedAt         Date
category           String    job|internship|hackathon|workshop
deadlineDate       Date      only on RegistrationEmail
aiProcessed        Boolean   default: true
expiresAt          Date      TTL index → auto-delete after 3 months
createdAt/updatedAt Date     auto

Indexes:
  { providerMessageId, provider: 1 } unique  ← prevents duplicate storage
  { userId, receivedAt: -1 }                 ← fast user timeline queries
  { expiresAt: 1 } expireAfterSeconds: 0     ← MongoDB TTL auto-cleanup
```

---

---

# 🧩 Middleware Dependency Map

```
Every API request pipeline:

[Client] → [cookieParser] → [express.json] → [cors] → [helmet] → [morgan]
                                                                       ↓
                                                              [Route matched]
                                                                       ↓
                                              ┌────────────────────────────────────┐
                                              │ Protected routes:                  │
                                              │   protect middleware               │
                                              │   → read cookie → verify JWT       │
                                              │   → DB lookup → req.user set       │
                                              │   → next()                         │
                                              └────────────────────────────────────┘
                                                                       ↓
                                              ┌────────────────────────────────────┐
                                              │ Resume upload route:               │
                                              │   protect → upload.single("file")  │
                                              │   → multer → req.file set          │
                                              │   → next()                         │
                                              └────────────────────────────────────┘
                                                                       ↓
                                                               [Controller]
                                                                       ↓
                                                               [res.json / redirect]
```

---

*Generated: 2026-04-24 | mail-or-a backend server — Deep API Reference*
