# 6. AUTHENTICATION & SECURITY — Complete Analysis

---

## Multi-Layer Security Model

```
Layer 7: Information Hiding     — Generic error messages, select:false
Layer 6: CSRF Protection        — JWT-signed OAuth state params
Layer 5: Encryption at Rest     — AES-256-GCM (emails), bcrypt (passwords)
Layer 4: Rate Limiting          — 4 tiers, per-endpoint configuration
Layer 3: Input Validation       — Joi schemas with stripUnknown
Layer 2: Authentication         — JWT httpOnly cookies, dual-source
Layer 1: Transport Security     — HTTPS, Helmet headers, CORS
```

### Layer 1 — Transport Security

**Helmet Headers Applied:**
| Header | Value | Purpose |
|---|---|---|
| X-Content-Type-Options | nosniff | Prevents MIME type sniffing |
| X-Frame-Options | DENY | Prevents clickjacking via iframe |
| X-XSS-Protection | 1; mode=block | Enables browser XSS filter |
| Strict-Transport-Security | max-age=31536000 | Forces HTTPS for 1 year |
| Referrer-Policy | strict-origin | Prevents URL leakage in referrer |
| Content-Security-Policy | default-src 'self' | Restricts resource loading |

**CORS Configuration:**
```javascript
app.use(cors({
  origin: [
    "https://mail-or-a.dev",
    "http://localhost:5173",    // Vite dev server
  ],
  credentials: true,            // Allows cookies cross-origin
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH"],
}));
```

### Layer 2 — Authentication

**JWT Token Flow:**
```
Login: email + password → bcrypt.compare → ✅ match
       → jwt.sign({ id: userId }, JWT_SECRET, { expiresIn: "7d" })
       → res.cookie("token", jwt, {
           httpOnly: true,      // JS can't access (XSS-proof)
           secure: isProd,      // HTTPS only in production
           sameSite: isProd ? "none" : "strict",  // Cross-site in prod
           maxAge: 7 * 24 * 60 * 60 * 1000,      // 7 days
         })
       → Return user object (WITHOUT password)
```

**Token Extraction (Dual Source):**
```javascript
// middlewares/auth.middleware.js
let token;

// Source 1: httpOnly cookie (primary — browser requests)
if (req.cookies?.token) {
  token = req.cookies.token;
}

// Source 2: Authorization header (fallback — API/mobile clients)
if (!token && req.headers.authorization?.startsWith("Bearer ")) {
  token = req.headers.authorization.split(" ")[1];
}

if (!token) return res.status(401).json({ message: "Not authenticated" });

// Verify + load user
const decoded = jwt.verify(token, process.env.JWT_SECRET);
const user = await User.findById(decoded.id);
if (!user) return res.status(401).json({ message: "User no longer exists" });

req.user = user; // Attach to request for downstream use
```

**Why httpOnly Cookies Over localStorage:**

| Attack Vector | localStorage | httpOnly Cookie |
|---|---|---|
| XSS (Cross-Site Scripting) | ❌ VULNERABLE — any JS can read | ✅ SAFE — invisible to JS |
| CSRF (Cross-Site Request Forgery) | ✅ Safe (not auto-sent) | ⚠️ Mitigated by sameSite + CORS |
| Token theft via dev tools | ❌ Visible in Storage tab | ⚠️ Visible in Cookies tab (encrypted) |
| Programmatic access | ❌ `localStorage.getItem()` | ✅ Cannot access from JS |

"I chose httpOnly cookies because XSS is a more common attack vector than CSRF. sameSite + CORS mitigate CSRF, but there's no equivalent mitigation for XSS with localStorage."

### Layer 3 — Input Validation

**Joi Schema Examples:**
```javascript
const joiSchemas = {
  signup: Joi.object({
    name: Joi.string().trim().min(1).max(100).required(),
    email: Joi.string().email().lowercase().trim().required(),
    password: Joi.string().min(6).max(128).required(),
    otp: Joi.string().pattern(/^\d{6}$/).required(),
  }),
  
  updateBasicInfo: Joi.object({
    name: Joi.string().trim().min(1).max(100).optional(),
    countryCode: Joi.string().pattern(/^\+\d{1,4}$/).optional(),
    mobileNumber: Joi.string().pattern(/^\d{6,15}$/).optional(),
    // stripUnknown removes any field NOT in this schema
    // e.g., { role: "admin", isVerified: true } → stripped
  }),
};
```

**Mass Assignment Prevention:**
```javascript
// Without Joi: attacker sends { email: "a@b.com", password: "...", isVerified: true, role: "admin" }
// These extra fields could be saved to the database!

// With Joi (stripUnknown: true): only declared fields pass through
const { error, value } = schema.validate(req.body, { stripUnknown: true });
req.body = value; // Sanitized body — no unexpected fields
```

### Layer 4 — Rate Limiting

```javascript
// 4 tiers based on endpoint sensitivity
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,     // 15 minutes
  max: 100,                      // 100 requests per window
  message: { status: "fail", message: "Too many requests" },
});

const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,                       // 10 requests per window
  // Used for: login, signup, password reset
});

const otpLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,     // 10 minutes
  max: 3,                        // 3 OTP requests per window
  // Prevents OTP spam/abuse
});

const webhookLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,      // 5 minutes
  max: 500,                      // 500 webhooks per window
  // More permissive — Gmail sends frequent notifications
});
```

**Application:**
```javascript
// auth routes
router.post("/login", sensitiveLimiter, validateBody(joiSchemas.login), controller.login);
router.post("/send-signup-otp", otpLimiter, validateBody(joiSchemas.sendSignupOtp), controller.sendSignupOtp);

// webhook routes
router.post("/gmail", webhookLimiter, webhookController.handleGmailWebhook);

// general routes (default)
app.use("/api", generalLimiter);
```

### Layer 5 — Encryption at Rest

**Password & OTP Hashing (bcrypt):**
```javascript
// Signup — hash password before storage
const hashedPassword = await bcrypt.hash(password, 10);
// Cost factor 10 = ~100ms per hash on modern hardware
// An attacker would need ~3.17 years to brute-force a 6-char password

// Login — compare plaintext against hash
const isMatch = await bcrypt.compare(password, user.password);
// bcrypt includes the salt in the hash — no separate salt storage needed

// OTP — also hashed (6-digit OTP is weak without hashing)
const hashedOtp = await bcrypt.hash(otp, 10);
// Even if DB is breached, attacker can't use stored OTP hash
```

**Email Content Encryption (AES-256-GCM):**
```
Plaintext: "Interview scheduled for May 20th at Oracle"
     │
     ▼
Random IV: crypto.randomBytes(16) → 32-char hex
     │
     ▼
Cipher: crypto.createCipheriv("aes-256-gcm", key, iv)
     │
     ├── cipher.update(plaintext, "utf8", "hex") → ciphertext
     ├── cipher.final("hex") → remaining ciphertext
     └── cipher.getAuthTag() → 32-char hex auth tag
     │
     ▼
Output: "gcm:a1b2c3d4...:e5f6g7h8...:encrypted_hex"
        prefix   IV          authTag     ciphertext
```

**Why GCM over CBC:**
- **CBC:** Provides confidentiality only. Vulnerable to padding oracle attacks where an attacker can decrypt ciphertext by observing error messages.
- **GCM:** Provides both confidentiality AND integrity (authenticated encryption). The auth tag detects any modification to the ciphertext — if someone alters a single bit, decryption fails.

**OAuth Token Encryption (Mongoose Hooks):**
```javascript
// Pre-save hook — encrypt before writing to MongoDB
connectedAccountSchema.pre("save", function (next) {
  if (this.isModified("accessToken") && !this.accessToken.startsWith("enc:")) {
    this.accessToken = "enc:" + encrypt(this.accessToken);
  }
  if (this.isModified("refreshToken") && !this.refreshToken.startsWith("enc:")) {
    this.refreshToken = "enc:" + encrypt(this.refreshToken);
  }
  next();
});

// Post-init hook — decrypt after reading from MongoDB
connectedAccountSchema.post("init", function () {
  if (this.accessToken?.startsWith("enc:")) {
    this.accessToken = decrypt(this.accessToken.slice(4));
  }
  if (this.refreshToken?.startsWith("enc:")) {
    this.refreshToken = decrypt(this.refreshToken.slice(4));
  }
});
```

**Why `isModified()` is Critical:**
Without it, every `.save()` call re-encrypts the already-encrypted token:
```
First save:  "ya29.abc123" → encrypt → "enc:gcm:iv1:tag1:cipher1"  ✅
Second save: "enc:gcm:iv1:tag1:cipher1" → encrypt → "enc:gcm:iv2:tag2:cipher2"  ❌ DOUBLE ENCRYPTED
```
The `isModified()` check ensures encryption only runs when the field actually changes.

### Layer 6 — CSRF Protection

**OAuth State Parameter:**
```javascript
// Before redirect to Google
const state = jwt.sign(
  { purpose: "gmail-connect", userId: req.user._id.toString() },
  process.env.JWT_SECRET,
  { expiresIn: "10m" }
);
// State is included in the OAuth redirect URL

// On callback, verify state
const decoded = jwt.verify(req.query.state, process.env.JWT_SECRET);
if (decoded.purpose !== "gmail-connect") {
  return res.redirect("/auth/error?reason=invalid-state");
}
// Attacker can't forge a valid state without JWT_SECRET
```

**Why JWT-signed state over random nonce:**
- Random nonce requires server-side storage (session/Redis) — adds statefulness
- JWT state is self-contained — any server instance can verify it
- Encodes purpose claim to prevent state reuse across different OAuth flows
- 10-minute expiry prevents replay attacks

### Layer 7 — Information Hiding

**Forgot Password (Anti-Enumeration):**
```javascript
exports.forgotPassword = async (req, res) => {
  const user = await User.findOne({ email });
  
  // ALWAYS return the same message — don't reveal if email exists
  if (!user) {
    return res.json({ message: "If this email is registered, a reset link has been sent." });
  }
  
  // Send reset email...
  return res.json({ message: "If this email is registered, a reset link has been sent." });
  // Attacker can't distinguish "email exists" from "email doesn't exist"
};
```

**Password Field Protection:**
```javascript
// User model
password: { type: String, select: false }
// User.find() never returns password
// Must explicitly use: User.findOne({ email }).select('+password')
```

---

## Complete Authentication Flows

### Flow 1: Email/Password Signup
```
1. POST /api/auth/send-signup-otp { email }
   → Rate limited (3 req / 10 min)
   → Validate email with Joi
   → Generate 6-digit OTP via crypto.randomInt(100000, 999999)
   → Hash OTP with bcrypt (cost 10)
   → Upsert PendingVerification { email, otp: hashedOtp, otpExpiry: now+5min }
   → Send OTP email via Nodemailer
   → Response: { message: "OTP sent" }

2. POST /api/auth/signup { name, email, password, otp }
   → Validate all fields with Joi
   → Find PendingVerification by email
   → Check OTP expiry (5 minutes)
   → bcrypt.compare(inputOtp, storedHash) — brute-force resistant
   → Hash password with bcrypt
   → User.create({ name, email, password: hashedPassword, isVerified: true })
   → Delete PendingVerification
   → Generate JWT → Set httpOnly cookie
   → Response: { user, token }
```

### Flow 2: Google OAuth Sign-In
```
1. GET /api/auth/google
   → Generate JWT-signed state: { purpose: "google-auth" }
   → Redirect to Google OAuth URL with scopes: openid, profile, email

2. GET /api/auth/google/callback?code=XXX&state=YYY
   → Verify JWT state (purpose must be "google-auth")
   → Exchange code for tokens: oAuth2Client.getToken(code)
   → Fetch user profile: oauth2.userinfo.v2.me.get()
   → Account linking logic:
     a. Find user by googleId → login existing user
     b. Find user by email → link Google ID to existing account
     c. Neither found → create new user with Google ID
   → Generate JWT → Set httpOnly cookie
   → Redirect to frontend: /auth/callback?token=JWT

3. Frontend AuthCallback component
   → Extract token from URL query
   → Call AuthContext.login(user, token)
   → Redirect to /dashboard
```

### Flow 3: Gmail Account Connection (Different Flow!)
```
1. GET /api/auth/google/gmail/connect (PROTECTED — requires JWT)
   → Generate JWT-signed state: { purpose: "gmail-connect", userId: req.user._id }
   → Redirect to Google OAuth with scopes: gmail.readonly, gmail.modify
   → Note: access_type: "offline" for refresh token
   → Note: prompt: "consent" forces consent screen (gets refresh token)

2. GET /api/auth/google/gmail/callback?code=XXX&state=YYY
   → Verify JWT state (purpose must be "gmail-connect")
   → Extract userId from state
   → Exchange code for tokens (access + refresh)
   → Fetch Gmail profile: gmail.users.getProfile()
   → Create/Update ConnectedAccount (tokens encrypted by Mongoose hook)
   → Start Gmail watch: gmail.users.watch({ labelIds: ["INBOX"] })
   → Store historyId + watchExpiry
   → Redirect to frontend: /dashboard?gmail=connected
```

---

## Security Interview Cross-Questions

**Q: Why not refresh token rotation?**
"Currently, the JWT has a fixed 7-day expiry with no refresh token. For production, I'd implement refresh token rotation: short-lived access tokens (15 min) + long-lived refresh tokens (30 days) stored in the database. On each refresh, the old refresh token is invalidated and a new one is issued. This limits the damage window if a token is stolen."

**Q: How do you handle token theft?**
"Since tokens are in httpOnly cookies, they can't be stolen via XSS. For manual logout, the server clears the cookie. For force-logout (e.g., password change), I'd add a `tokenInvalidatedAt` field to the User model — tokens issued before this timestamp are rejected. This is cheaper than maintaining a token blacklist."

**Q: What if someone finds the JWT_SECRET?**
"They can forge any JWT and impersonate any user. Mitigation: (1) JWT_SECRET is in environment variables, never in code. (2) In production, use AWS Secrets Manager or HashiCorp Vault for secret management. (3) Implement key rotation — support two secrets simultaneously during transition."

**Q: How do you prevent brute-force attacks on OTP?**
"Three layers: (1) Rate limiting — 3 OTP requests per 10 minutes per IP. (2) OTP expiry — 5 minutes. (3) bcrypt comparison — even with database access, the hashed OTP can't be reversed. Additionally, OTPs are 6 digits (1 in 900,000 chance of guessing), and the PendingVerification document is deleted after successful verification."
