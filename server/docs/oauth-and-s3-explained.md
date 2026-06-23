# OAuth & S3 — Explained for a Fresher Backend Engineer

This guide explains two things in the Mailora server, from the ground up:

1. **OAuth authentication** — how a user logs in with Google/Microsoft, and how we
   later get permission to read their Gmail.
2. **AWS S3 file storage** — how a resume/photo travels from the browser, gets
   stored in an S3 bucket, and how we hand back a safe URL to view it.

No prior knowledge assumed. Real code from this repo is referenced throughout.

---

# Part 1 — OAuth Authentication

## 1.1 What problem does OAuth solve?

Imagine you walk into a hotel. Instead of giving you the **master key** to the whole
building, the front desk gives you a **key card** that only opens *your* room, and
only until checkout.

OAuth is the same idea for software:

- You never give Mailora your Google password.
- Instead, Google gives Mailora a **token** (the key card) that grants *limited*
  access (e.g. "read this person's email") for a *limited* time.

The technical name for the flow we use is the **Authorization Code flow**.

### The actors

| Term | Who/what it is in our app |
|------|---------------------------|
| **Resource Owner** | The end user (you) |
| **Client** | The Mailora server (wants access) |
| **Authorization Server** | Google / Microsoft login servers |
| **Resource Server** | Gmail API / Microsoft Graph API |
| **Authorization Code** | A short-lived one-time code Google sends back |
| **Access Token** | The "key card" — used to call the API |
| **Refresh Token** | A long-lived token to get a *new* access token when the old one expires |

---

## 1.2 We actually use OAuth for TWO different things

This trips people up, so let's be explicit. Mailora uses Google OAuth in **two
separate flows** with **different scopes** (a "scope" = what permission you're asking for):

| Flow | Goal | Scopes requested | Where it lives |
|------|------|------------------|----------------|
| **A. Social Sign-In** | Just log the user in ("Sign in with Google/Microsoft") | `openid profile email` | [socialAuth.controller.js](../modules/auth/socialAuth.controller.js) |
| **B. Connect Gmail** | Get permission to *read* the user's inbox | `gmail.readonly`, `gmail.modify` | [google.controller.js](../modules/auth/google.controller.js) |

Flow A asks for almost nothing (just who you are). Flow B asks for a lot (your email),
so it's a deliberate, separate step the user does *after* signing in.

---

## 1.3 Flow A — Social Sign-In (login)

This is the "Sign in with Google" button. Goal: identify the user and give them a
Mailora session.

### Step-by-step (Google)

```
Browser                  Mailora server               Google
  |                            |                          |
  | 1. GET /api/auth/google    |                          |
  |--------------------------->|                          |
  |                            | 2. build auth URL +      |
  |                            |    signed "state"        |
  |   3. redirect to Google <--|                          |
  |------------------------------------------------------>|
  |                            |        4. user logs in & consents
  |   5. redirect back with ?code=...&state=...           |
  |<------------------------------------------------------|
  | 6. GET /api/auth/google/callback?code=...&state=...   |
  |--------------------------->|                          |
  |                            | 7. exchange code--------->|
  |                            |    for tokens <-----------|
  |                            | 8. fetch profile -------->|
  |                            |    (name,email) <---------|
  |                            | 9. find/create user      |
  |                            | 10. issue OUR JWT cookie  |
  |  11. redirect to frontend  |                          |
  |    /auth/callback?token=.. |                          |
  |<---------------------------|                          |
```

### The code, mapped to those steps

**Steps 1–3 — `googleSignIn`** ([socialAuth.controller.js:17](../modules/auth/socialAuth.controller.js#L17)):

```js
const oauthClient = getGoogleOAuthClient(process.env.GOOGLE_AUTH_REDIRECT_URI);

// "state" = a signed token we send to Google and get back unchanged.
// It proves the callback really came from a request WE started (anti-CSRF).
const state = jwt.sign({ purpose: "google-auth" }, process.env.JWT_SECRET, { expiresIn: "10m" });

const authUrl = oauthClient.generateAuthUrl({
  access_type: "offline",     // also give a refresh token
  scope: ["openid", "profile", "email"],
  prompt: "select_account",
  state,
});
res.redirect(authUrl);        // send the browser to Google
```

> **Why `state`?** Without it, an attacker could trick your browser into hitting our
> callback URL with *their* code (a CSRF attack). Because `state` is a JWT we signed
> with our secret, we can verify in the callback that we issued it.

**Steps 6–11 — `googleCallback`** ([socialAuth.controller.js:43](../modules/auth/socialAuth.controller.js#L43)):

```js
const { code, state } = req.query;

// Verify the state JWT — rejects forged/expired callbacks
const decoded = jwt.verify(state, process.env.JWT_SECRET);
if (decoded.purpose !== "google-auth") throw new Error();

// 7. Exchange the one-time code for tokens
const { tokens } = await oauthClient.getToken(code);
oauthClient.setCredentials(tokens);

// 8. Use the token to fetch the user's basic profile
const oauth2 = google.oauth2({ version: "v2", auth: oauthClient });
const { data: profile } = await oauth2.userinfo.get();   // { id, name, email, picture }

// 9. Find or create the user in our DB
let user = await User.findOne({ googleId: profile.id });
if (!user) {
  user = await User.findOne({ email: profile.email });   // maybe they signed up locally before
  if (user) { user.googleId = profile.id; user.authProvider = "google"; await user.save(); }
  else      { user = await User.create({ name: profile.name, email: profile.email, googleId: profile.id, authProvider: "google" }); }
}

// 10. Issue OUR OWN session token (not Google's) and set it as a cookie
const token = generateToken(user._id);
setAuthCookie(res, token);

// 11. Send the browser back to the frontend
res.redirect(`${process.env.FRONTEND_URL}/auth/callback?token=${token}&provider=google`);
```

**Microsoft is the same shape**, just different endpoints — see `microsoftSignIn` /
`microsoftCallback` in the same file. Instead of Google's SDK it calls the Microsoft
token endpoint and the Graph API `/me` to get the profile
([microsoft.service.js](../services/microsoft.service.js)).

### "Find or create" logic — why three branches?

1. **User exists with this `googleId`** → returning user, just log them in.
2. **No `googleId`, but email exists** → they previously signed up with email/password;
   we *link* Google to that account so they're not duplicated.
3. **Neither** → brand-new user, create the account.

---

## 1.4 What is "our own JWT", and why a cookie?

Google's token proves *to Google* who you are. But for *our* app's day-to-day requests,
we issue our **own** session token — a JWT — so we don't have to call Google on every request.

**Generating it** ([utils/auth.js](../utils/auth.js)):

```js
const generateToken = (id) => jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: "7d" });
```

It's just a signed statement: *"this is user `<id>`, valid for 7 days"*. Signed with
`JWT_SECRET`, so nobody can forge one without our secret.

**Storing it in a cookie** ([utils/auth.js](../utils/auth.js)):

```js
res.cookie("token", token, {
  httpOnly: true,                                   // JS in the browser CANNOT read it → safe from XSS theft
  secure: process.env.NODE_ENV === "production",    // only sent over HTTPS in prod
  sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  maxAge: 7 * 24 * 60 * 60 * 1000,                  // 7 days
});
```

- `httpOnly` is the key security property: even if an attacker injects JavaScript,
  they can't read the token.
- We *also* return the token in the redirect URL so the frontend can store it and send
  it as an `Authorization: Bearer ...` header if it prefers — see the next section.

---

## 1.5 How protected routes use the token

Every protected route runs the `protect` middleware first
([auth.middleware.js](../middlewares/auth.middleware.js)):

```js
exports.protect = async (req, res, next) => {
  // Accept the token from EITHER the cookie OR an Authorization header
  let token = req.cookies.token;
  if (!token && req.headers.authorization?.startsWith("Bearer ")) {
    token = req.headers.authorization.split(" ")[1];
  }
  if (!token) return res.status(401).json({ message: "Not authenticated" });

  const decoded = jwt.verify(token, process.env.JWT_SECRET);  // throws if invalid/expired
  const user = await User.findById(decoded.id);
  if (!user) return res.status(401).json({ message: "User not found" });

  req.user = user;   // now every downstream handler can use req.user
  next();
};
```

So a route like `router.post("/upload-resume", protect, upload.single("file"), controller.uploadResume)`
only runs the controller **after** `protect` has confirmed who the user is and attached
`req.user`.

---

## 1.6 Flow B — Connecting a Gmail account (reading email)

This is different from sign-in. The user is **already logged in** and now clicks
"Connect Gmail" so Mailora can read their inbox and create deadline reminders.

Key differences from Flow A:

- **Bigger scopes:** `gmail.readonly` + `gmail.modify`.
- **`prompt: "consent"` + `access_type: "offline"`** → forces Google to return a
  **refresh token** (we need long-term access, since the user won't be present when
  new email arrives).
- We store the tokens in a **`ConnectedAccount`** document, not on the user session.
- We register a Gmail **`watch`** so Google pushes notifications when new mail arrives.

**Step 1 — `googleAuth`** ([google.controller.js:20](../modules/auth/google.controller.js#L20)):

```js
const oauthClient = getGoogleOAuthClient();
// state carries the logged-in user's id (signed), so the callback knows whose account this is
const stateToken = jwt.sign({ userId: req.user._id.toString() }, process.env.JWT_SECRET, { expiresIn: "10m" });

const authUrl = oauthClient.generateAuthUrl({
  access_type: "offline",
  scope: ["https://www.googleapis.com/auth/gmail.readonly", "https://www.googleapis.com/auth/gmail.modify"],
  prompt: "consent",        // force the consent screen → guarantees a refresh_token
  state: stateToken,
});
res.redirect(authUrl);
```

**Step 2 — `googleCallback`** ([google.controller.js:45](../modules/auth/google.controller.js#L45)):

```js
const { code, state } = req.query;
const decoded = jwt.verify(state, process.env.JWT_SECRET);   // who started this?
const userId = decoded.userId;

const { tokens } = await oauthClient.getToken(code);         // access + refresh tokens
oauthClient.setCredentials(tokens);

const gmail = getGmailClient(oauthClient);
const profile = await gmail.users.getProfile({ userId: "me" });
const emailAddress = profile.data.emailAddress;

// Subscribe to inbox changes → Google will push notifications to our Pub/Sub topic
const watchResponse = await gmail.users.watch({
  userId: "me",
  requestBody: { topicName: process.env.GOOGLE_PUBSUB_TOPIC, labelIds: ["INBOX"] },
});

// Save the connection (tokens, expiry, and the historyId from the watch)
await ConnectedAccount.create({
  userId, provider: "google", emailAddress,
  accessToken: tokens.access_token,
  refreshToken: tokens.refresh_token,
  tokenExpiry: tokens.expiry_date ? new Date(tokens.expiry_date) : new Date(Date.now() + 3600 * 1000),
  lastHistoryId: watchResponse.data.historyId,
  isActive: true,
});
```

(There's also logic to *update* an already-connected account and a **max of 3 accounts**
per user.)

### Access token vs refresh token

- **Access token** is short-lived (~1 hour). It's what actually calls the Gmail API.
- **Refresh token** is long-lived. When the access token expires, we use the refresh
  token to silently get a new one — no user involvement.

That refresh happens in [google.service.js](../services/google.service.js):

```js
exports.refreshGoogleTokenIfNeeded = async (account) => {
  const oauthClient = exports.getGoogleOAuthClient();
  oauthClient.setCredentials({ access_token: account.accessToken, refresh_token: account.refreshToken });

  if (!account.tokenExpiry || new Date() >= account.tokenExpiry) {  // expired?
    const { credentials } = await oauthClient.refreshAccessToken();  // get a fresh one
    account.accessToken = credentials.access_token;
    if (credentials.expiry_date) account.tokenExpiry = new Date(credentials.expiry_date);
    await account.save();                                            // persist it
  }
  return oauthClient;
};
```

---

## 1.7 OAuth security checklist (what this code gets right)

- ✅ **`state` parameter** signed as a JWT → blocks CSRF on the callback.
- ✅ **`httpOnly` cookie** → session token can't be stolen by injected JavaScript.
- ✅ **`secure` + `sameSite`** tuned per environment.
- ✅ **Our own JWT**, so we don't depend on Google for every request.
- ✅ **Refresh tokens stored server-side** in `ConnectedAccount`, never exposed to the browser.
- ✅ **Tokens encrypted at rest.** `accessToken`/`refreshToken` are AES-encrypted before
  saving and decrypted on read via Mongoose `pre("save")` / `post("init")` hooks in
  [connectedAccount.model.js](../modules/connectedAccount/connectedAccount.model.js). An
  `"enc:"` prefix marks encrypted values so repeated saves never double-encrypt.
- ⚠️ Caveat: decryption happens in the `post("init")` hook, so it only applies to
  documents loaded the normal way. A `.lean()` query skips hooks and would return the raw
  `"enc:"`-prefixed ciphertext — keep that in mind before optimizing a query with `.lean()`.

---

# Part 2 — AWS S3 File Storage

## 2.1 What is S3?

**S3 (Simple Storage Service)** is Amazon's file storage in the cloud. Think of it as
an infinite hard drive you talk to over HTTPS. Key vocabulary:

| Term | Meaning |
|------|---------|
| **Bucket** | A top-level container for files (ours: `S3_BUCKET_NAME`) |
| **Object** | A single stored file |
| **Key** | The object's full "path" inside the bucket, e.g. `resumes/<userId>/<uuid>.pdf` |
| **Presigned URL** | A temporary, signed link that grants time-limited access to a private object |

Our bucket is **private** — files are *not* publicly readable. That matters for the
"how do we show the file" part below.

---

## 2.2 The journey of an uploaded file

```
[Browser]                 [Mailora server]                       [AWS S3]
   |                            |                                    |
   | multipart/form-data        |                                    |
   |  (the PDF/photo) ----------> multer saves to OS temp dir         |
   |                            |  (req.file.path)                    |
   |                            | controller reads the temp file      |
   |                            | (parse text, AI-extract skills…)    |
   |                            | uploadToS3(streams the file) ------> PutObject (private)
   |                            |                          key, url <--|
   |                            | delete temp file                    |
   |                            | save key+url on the User doc        |
   |                            | getPresignedUrl(key) --------------> sign a GET URL
   |   { resumeUrl } <----------|                  presigned URL <----|
   |  (open this link to view)  |                                    |
```

There are **3 layers** involved, and it helps to keep them straight:

1. **multer** — receives the HTTP upload, writes a *temporary* file to disk.
2. **the controller** — orchestrates: validate → process → upload → save → respond.
3. **s3.service** — the only place that actually talks to AWS.

---

## 2.3 Layer 1 — multer (receiving the upload)

[upload.middleware.js](../middlewares/upload.middleware.js) configures **multer**, the
library that parses `multipart/form-data` (how browsers send files):

```js
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, os.tmpdir()),                    // OS temp folder
  filename:    (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`),
});

// Resume uploader: PDF/DOCX only, max 5 MB
const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"];
    allowed.includes(file.mimetype) ? cb(null, true) : cb(new Error("Only PDF and DOCX allowed"), false);
  },
});
```

Why save to a **temp file** first instead of straight to S3?
- We need to **read the file** for other work (extract resume text, run AI) *before*
  deciding to keep it.
- It keeps memory usage low — big files stream from disk rather than sitting in RAM.

The route wires multer in *before* the controller
([user.routes.js](../modules/user/user.routes.js)):

```js
router.post("/upload-resume", protect, upload.single("file"),    controller.uploadResume);
router.post("/upload-photo",  protect, photoUpload.single("photo"), controller.uploadPhoto);
```

So by the time `uploadResume` runs, the file is on disk and described by `req.file`
(`.path`, `.originalname`, `.mimetype`, …).

---

## 2.4 Layer 3 — s3.service (talking to AWS)

[s3.service.js](../services/s3.service.js) is the only file that imports the AWS SDK.
It creates one client using the env credentials:

```js
const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.S3_BUCKET_NAME;
```

### Upload — `uploadToS3`

```js
exports.uploadToS3 = async (filePath, originalName, mimetype, userId, folder = "resumes") => {
  const ext = path.extname(originalName);                 // ".pdf"
  const uniqueName = `${crypto.randomUUID()}${ext}`;       // "3f9c...-uuid.pdf"
  const key = `${folder}/${userId}/${uniqueName}`;         // "resumes/<userId>/<uuid>.pdf"
  const fileStream = fs.createReadStream(filePath);        // stream from temp file

  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fileStream,
    ContentType: mimetype,
  }));

  const url = `https://${BUCKET}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;
  return { key, url };
};
```

**Why the key looks like `resumes/<userId>/<uuid>.pdf`:**
- `resumes/` groups all resumes (vs `photos/` for pictures).
- `<userId>/` isolates each user's files — easy to find/delete a user's data.
- `<uuid>` guarantees uniqueness so two uploads never overwrite each other.

> **Important nuance:** the returned `url` is the *raw* S3 address. Because our bucket is
> **private**, opening that raw URL directly returns "Access Denied". The durable thing
> we rely on is the **`key`** — the raw `url` is essentially a record, and we generate a
> working link on demand (next section).

### Read — `getPresignedUrl`

```js
exports.getPresignedUrl = async (key, expiresIn = 3600) => {   // 3600s = 1 hour
  if (!key) return null;
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return await getSignedUrl(s3, command, { expiresIn });
};
```

A **presigned URL** is a normal-looking HTTPS link with a cryptographic signature baked
into the query string. It says: *"whoever holds this link may GET this one object, until
it expires."* This is how we let a private file be viewed in the browser **without making
the bucket public**. After ~1 hour the link stops working — so we generate a fresh one
each time the profile is loaded.

### Delete — `deleteFromS3`

```js
exports.deleteFromS3 = async (key) => {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
};
```

Used to remove the *old* file when a user replaces their resume/photo, so we don't pile
up orphaned objects.

---

## 2.5 Layer 2 — the controller (putting it together)

`uploadResume` ([user.controller.js:202](../modules/user/user.controller.js#L202)) is the
real-world orchestration. Annotated:

```js
exports.uploadResume = asyncHandler(async (req, res) => {
  if (!req.file) return sendError(res, 400, "Please upload a PDF or DOCX file.");

  const fileBuffer = fs.readFileSync(req.file.path);     // read the temp file
  const user = await User.findById(req.user._id);        // req.user came from `protect`

  // 1) Remove the previous resume from S3 (avoid orphans). Failure here is non-fatal.
  if (user.resumeS3Key) {
    try { await deleteFromS3(user.resumeS3Key); }
    catch (e) { logger.warn("User", "Failed to delete old resume from S3", e.message); }
  }

  // 2) Extract text (PDF → pdf-parse, DOCX → mammoth)
  let extractedText;
  if (req.file.mimetype === "application/pdf") extractedText = (await pdfParse(fileBuffer)).text;
  else extractedText = (await mammoth.extractRawText({ buffer: fileBuffer })).value;

  // 3) Ask Gemini AI to structure the resume (skills, role, education…). Falls back to keyword matching.
  let extractedData = {};
  try { extractedData = await extractProfileData(extractedText); }
  catch (e) { /* fallback keyword scan */ }

  // 4) Upload the actual file to S3
  const { url, key } = await uploadToS3(req.file.path, req.file.originalname, req.file.mimetype, req.user._id.toString());

  // 5) Clean up the temp file (we no longer need it locally)
  fs.unlinkSync(req.file.path);

  // 6) Persist the references + merged profile data
  user.resumeUrl = url;
  user.resumeS3Key = key;            // <-- the key is what we use to read it later
  user.extractedSkills = extractedData.skills || [];
  // ...merge skills/role/education/experience...
  await user.save();

  // 7) Return a presigned URL the browser can actually open
  const presignedUrl = await getPresignedUrl(key);
  sendSuccess(res, 200, "Resume processed and uploaded", { resumeUrl: presignedUrl, /* profileData... */ });
});
```

### How the file is later shown

When the profile is fetched, we **don't** trust the stored raw URL — we re-sign from the
stored key ([user.controller.js:31-32](../modules/user/user.controller.js#L31)):

```js
const photoUrl  = user.photoS3Key  ? await getPresignedUrl(user.photoS3Key)  : user.photoUrl  || "";
const resumeUrl = user.resumeS3Key ? await getPresignedUrl(user.resumeS3Key) : user.resumeUrl || null;
```

So the pattern is: **store the key permanently, mint a presigned URL on every read.**

---

## 2.6 S3 environment variables

From `server/.env`:

```bash
AWS_ACCESS_KEY_ID=...        # IAM credentials with S3 access
AWS_SECRET_ACCESS_KEY=...
AWS_REGION=ap-south-1        # the bucket's region (Mumbai)
S3_BUCKET_NAME=mailora-resumes-...   # the target bucket
```

> 🔒 Treat these like passwords. An exposed `AWS_ACCESS_KEY_ID`/secret lets anyone use
> your AWS account. In production prefer **IAM roles** over static keys when possible, and
> scope the IAM policy to *only* this bucket and *only* the actions used here
> (`PutObject`, `GetObject`, `DeleteObject`).

---

# Quick Mental Model (TL;DR)

**OAuth login:**
> Redirect to Google → user consents → Google sends back a `code` → we swap the `code`
> for tokens → read the user's profile → find/create the user → set **our own** JWT
> cookie. The `state` param protects the round-trip from forgery.

**Connect Gmail (separate, bigger permission):**
> Same dance but with Gmail scopes + a **refresh token**, stored in `ConnectedAccount`,
> plus a `watch` subscription so Google pushes new-mail notifications.

**S3 upload:**
> Browser → multer temp file → controller processes it → `uploadToS3` (private object,
> keyed `resumes/<userId>/<uuid>`) → save the **key** → return a **presigned URL** to view it.

**S3 read:**
> Look up the saved **key** → `getPresignedUrl` → hand the browser a 1-hour signed link.
