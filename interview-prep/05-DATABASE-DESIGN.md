# 5. DATABASE DESIGN ANALYSIS

---

## Why MongoDB (Evidence-Based)

### 1. Document Model Matches Email Structure
Each classified email is a **self-contained document** with nested objects and arrays:
```javascript
{
  userId: ObjectId("..."),                          // Reference
  subject: "gcm:iv:authTag:ciphertext",             // Encrypted string
  from: "gcm:iv:authTag:ciphertext",                // Encrypted string
  body: "gcm:iv:authTag:ciphertext",                // Encrypted string (large)
  links: ["gcm:iv:...", "gcm:iv:..."],              // Encrypted array
  matter: "gcm:iv:authTag:ciphertext",              // Encrypted string
  category: "job",                                   // Queryable enum
  deadlineDate: ISODate("2025-05-20T00:00:00Z"),    // Date (only in registration/inprogress)
  receivedAt: ISODate("2025-05-10T14:30:00Z"),      // Sortable date
  expiresAt: ISODate("2025-08-10T14:30:00Z"),       // TTL field
  aiProcessed: true,                                 // Boolean flag
}
```
In PostgreSQL, this would require:
- `emails` table + `email_links` join table (for arrays)
- Nullable `deadlineDate` column (unused for 2 of 4 stages)
- JSON column for `links` (loses type safety)
- Separate encryption/decryption logic per column

### 2. TTL Indexes for Automatic Data Expiry
```javascript
// Emails auto-expire after 3 months — zero application code needed
schema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// MongoDB checks every 60 seconds and deletes expired documents

// DLQ messages auto-expire after 30 days (unresolved only)
failedMessageSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60,
    partialFilterExpression: { resolved: false } }
);
```
**PostgreSQL equivalent:** Requires a cron job or `pg_partman` extension — not built-in.

### 3. Cross-Collection Aggregation with `$unionWith`
```javascript
// getAllEmails — query across 4 collections in a single pipeline
RegistrationEmail.aggregate([
  { $match: { userId: ObjectId(userId) } },
  { $addFields: { stage: "registration" } },
  { $unionWith: { coll: "registeredemails", pipeline: [
    { $match: { userId: ObjectId(userId) } },
    { $addFields: { stage: "registered" } }
  ]}},
  { $unionWith: { coll: "inprogressemails", pipeline: [...] } },
  { $unionWith: { coll: "confirmedemails", pipeline: [...] } },
  { $facet: {
    data: [{ $sort: { receivedAt: -1 } }, { $skip: skip }, { $limit: limit }],
    total: [{ $count: "count" }],
  }},
]);
```
This is equivalent to PostgreSQL's `UNION ALL` + `LIMIT/OFFSET`, but executed entirely within MongoDB.

---

## Complete Collection Schema Reference

### 1. Users Collection
```javascript
const userSchema = {
  // ── Identity ──
  name:           { type: String, required: true, trim: true },
  email:          { type: String, required: true, unique: true, lowercase: true },
  password:       { type: String, select: false }, // NEVER returned by default
  
  // ── OAuth IDs (sparse unique — null allowed) ──
  googleId:       { type: String, unique: true, sparse: true },
  microsoftId:    { type: String, unique: true, sparse: true },
  
  // ── Profile ──
  role:           String,                // "Full Stack Developer"
  about:          String,                // Bio
  skills:         [String],              // ["JavaScript", "React", "Node.js"]
  achievements:   String,                // Award descriptions
  education:      [{ degree, institution, year }],
  experience:     [{ role, company, duration, description }],
  projects:       [{ title, description, link }],
  certifications: [{ name, issuer, year }],
  
  // ── Resume & Photo (S3) ──
  resumeKey:      String,                // S3 object key
  resumeUrl:      String,                // S3 URL (pre-signed generated on request)
  photoKey:       String,
  photoUrl:       String,
  
  // ── Mobile (WhatsApp) ──
  countryCode:    String,                // "+91"
  mobileNumber:   String,                // "9876543210"
  isMobileVerified: { type: Boolean, default: false },
  mobileOtp:      String,               // bcrypt-hashed OTP
  mobileOtpExpiry: Date,
  
  // ── Preferences ──
  reminderPreferences: {
    whatsapp: { type: Boolean, default: true },
  },
  
  // ── Auth Flags ──
  isVerified:     { type: Boolean, default: false },
};
// Timestamps: createdAt, updatedAt (auto-managed by Mongoose)
```

**Key Design Decisions:**
- `password: { select: false }` — prevents accidental exposure in API responses. Must explicitly use `.select('+password')` when needed for login verification.
- `googleId` and `microsoftId` use **sparse unique indexes** — allows multiple users without OAuth (null values) while enforcing uniqueness for those who do have it.
- `skills` is a plain array — simple `$addToSet` for dedup, no join table needed.
- `mobileOtp` is bcrypt-hashed — even database access doesn't reveal the OTP.

### 2. PendingVerifications Collection
```javascript
const pendingSchema = {
  email:      { type: String, required: true },  // Upsert target
  name:       String,
  password:   String,       // bcrypt-hashed
  otp:        String,       // bcrypt-hashed
  otpExpiry:  Date,         // 5 minutes from creation
  otpAttempts: { type: Number, default: 0 },  // Brute-force protection
};
```
**Purpose:** Temporary storage during signup flow. User enters email → OTP sent → user enters OTP → if valid, User is created and PendingVerification is deleted.

**Why a separate collection?** Prevents creating User documents for unverified signups. If the user never completes OTP verification, no User document exists.

### 3. ConnectedAccounts Collection
```javascript
const connectedAccountSchema = {
  userId:        { type: ObjectId, ref: "User", required: true },
  provider:      { type: String, enum: ["google", "microsoft"], required: true },
  emailAddress:  { type: String, required: true },
  
  // OAuth tokens (encrypted via Mongoose pre-save / post-init hooks)
  accessToken:   { type: String, required: true },   // Encrypted: "enc:gcm:..."
  refreshToken:  { type: String, required: true },   // Encrypted: "enc:gcm:..."
  tokenExpiry:   Date,
  
  // Gmail watch state
  lastHistoryId: String,     // For incremental email fetching
  watchExpiry:   Date,       // When the Pub/Sub watch expires
  
  isActive:      { type: Boolean, default: true },
};
// Compound unique: { userId: 1, emailAddress: 1 }
```

**Token Encryption Flow:**
```
Write path:  plaintext → pre("save") hook → isModified? → encrypt → add "enc:" prefix → MongoDB
Read path:   MongoDB → post("init") hook → starts with "enc:"? → remove prefix → decrypt → plaintext
```

### 4-7. Email Stage Collections (4 separate collections)

**Registration Emails** — emails with a CTA to apply/register:
```javascript
{
  userId, connectedAccountId, provider, providerMessageId,
  subject, from, snippet, body, matter, links,  // ALL ENCRYPTED
  category,     // "job" | "internship" | "hackathon" | "workshop"
  deadlineDate, // Date — extracted by Gemini AI
  receivedAt,   // Date — from Gmail internalDate
  aiProcessed,  // Boolean
  expiresAt,    // Date — 3 months from ingestion (TTL)
}
```

**Registered Emails** — confirmation of receipt:
```javascript
// Same as above but WITHOUT deadlineDate
```

**InProgress Emails** — interview/assessment emails:
```javascript
// Same as Registration — HAS deadlineDate
```

**Confirmed Emails** — offer letters, acceptance:
```javascript
// Same as Registered — NO deadlineDate
```

**Why 4 Collections Instead of 1?**

| Approach | Pros | Cons |
|---|---|---|
| 1 collection + `stage` field | Simpler queries, single index | Wasted nullable fields, mixed indexes |
| **4 collections (our choice)** | Per-stage indexes, clean schemas | Needs `$unionWith` for cross-stage queries |

Specific advantages:
1. **Schema precision:** Registration and InProgress have `deadlineDate`; Registered and Confirmed do not. No wasted nullable columns.
2. **Independent indexing:** Each collection has indexes optimized for its query patterns.
3. **Future flexibility:** Different TTL policies per stage (e.g., confirmed offers kept longer).
4. **Separation of concerns:** Stage-specific business logic stays clean.

### 8. Reminders Collection
```javascript
const reminderSchema = {
  userId:         { type: ObjectId, ref: "User", required: true, index: true },
  emailId:        { type: ObjectId, required: true },
  emailModel:     { type: String, enum: ["RegistrationEmail", "InProgressEmail"] },
  
  emailSubject:   String,    // PLAINTEXT (for WhatsApp message — not encrypted)
  emailCategory:  String,    // "job" | "internship" | "hackathon" | "workshop"
  emailMatter:    String,    // PLAINTEXT summary
  
  deadlineDate:   { type: Date, required: true },
  scheduledAt:    { type: Date, required: true, index: true },
  reminderType:   { type: String, enum: ["immediate","3days","24hrs","12hrs","1hr"] },
  
  status:         { type: String, enum: ["pending","queued","sent","failed","skipped"],
                    default: "pending", index: true },
  failReason:     { type: String, default: "" },
  sentAt:         Date,
};
// Compound indexes:
// { status: 1, scheduledAt: 1 } — for cron query
// { emailId: 1, reminderType: 1 } — unique (prevents duplicates)
```

**Reminder Lifecycle:**
```
Created → "pending"
    │
    ├──→ Cron picks up → Kafka produce → "queued"
    │                                        │
    │                    ├──→ WhatsApp sent → "sent" (sentAt = now)
    │                    └──→ Max retries  → "failed" (failReason = "...")
    │
    └──→ User not verified / WhatsApp disabled → "skipped" (failReason = "reason")
```

### 9. FailedMessages Collection (DLQ)
```javascript
const failedMessageSchema = {
  topic:      { type: String, enum: [...], index: true },
  payload:    { type: Mixed, required: true },        // Original Kafka message
  lastError:  { type: String, default: "" },
  retryCount: { type: Number, default: 0 },
  resolved:   { type: Boolean, default: false, index: true },
  userId:     { type: ObjectId, ref: "User", index: true },
  resolvedAt: Date,
  resolvedBy: String,
};
// TTL: Auto-expire unresolved entries after 30 days
// partialFilterExpression: { resolved: false }
```

**Why dual persistence (Kafka DLQ topic + MongoDB)?**
- **Kafka DLQ:** For automated reprocessing (a separate consumer could retry DLQ messages)
- **MongoDB:** For admin dashboard review, manual resolution, analytics on failure patterns

---

## Indexing Strategy (Complete)

| Collection | Index | Type | Purpose |
|---|---|---|---|
| users | `email` | Unique | Login lookup, duplicate prevention |
| users | `googleId` | Sparse Unique | OAuth lookup (null OK for local users) |
| users | `microsoftId` | Sparse Unique | OAuth lookup |
| connectedaccounts | `{userId, emailAddress}` | Compound Unique | Prevent duplicate connections |
| registration/registered/inprogress/confirmed emails | `{providerMessageId, provider}` | Compound Unique | Idempotent email processing |
| all email collections | `{userId, receivedAt}` | Compound | Primary query: user's emails sorted by date |
| all email collections | `expiresAt` | TTL | Auto-expire after 3 months |
| reminders | `{status, scheduledAt}` | Compound | Cron query: pending + due reminders |
| reminders | `{emailId, reminderType}` | Compound Unique | Prevent duplicate reminders |
| failedmessages | `topic` | Single | Filter by origin topic |
| failedmessages | `resolved` | Single | Filter unresolved for admin review |
| failedmessages | `createdAt` | TTL (partial) | Auto-expire unresolved after 30 days |
| jobs (serpapiservice) | `{role, jobType}` | Compound | Primary search: jobs by role and type |

### Query Pattern Coverage

**Most frequent query: User's emails by category with pagination**
```javascript
// Index used: { userId: 1, receivedAt: -1 }
RegistrationEmail.find({ userId, category })
  .sort({ receivedAt: -1 })
  .skip(skip).limit(limit);
// This is a covered query — index handles filter + sort + pagination
```

**Cron query: Due reminders**
```javascript
// Index used: { status: 1, scheduledAt: 1 }
Reminder.find({ status: "pending", scheduledAt: { $lte: now } }).limit(50);
// Compound index matches both fields — efficient range scan on scheduledAt
```

**Duplicate detection:**
```javascript
// Index used: { providerMessageId: 1, provider: 1 } (unique)
// When Kafka consumer tries to insert a duplicate:
try {
  await Model.create(doc);
} catch (err) {
  if (err.code === 11000) return; // Silently skip — already processed
}
```

---

## Data Consistency Guarantees

### Idempotent Email Processing
1. **Gmail History API** → `startHistoryId` ensures only new messages are fetched
2. **Kafka at-least-once** → consumer may receive the same message twice on rebalance
3. **Compound unique index** → `{providerMessageId, provider}` catches duplicates at DB level
4. **Error code 11000 handling** → consumer catches and skips (no retry, no DLQ)

### Reminder Deduplication
1. **Unique index** → `{emailId, reminderType}` prevents creating duplicate reminders
2. **insertMany with ordered:false** → individual failures don't block other inserts
3. **Error code 11000** → caught and skipped in the loop

### OAuth Token Consistency
1. **`isModified()` check** → prevents re-encrypting already-encrypted tokens on `.save()`
2. **`enc:` prefix marker** → explicit flag prevents false-positive encryption detection
3. **Mongoose hooks** → transparent encrypt/decrypt on every read/write operation
