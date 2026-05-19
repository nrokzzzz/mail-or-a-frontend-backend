# 2. STAR METHOD — DETAILED PROJECT EXPLANATIONS

---

## Feature 1: Real-Time Email Classification Pipeline

### Situation
When users connect their Gmail accounts, they need their incoming emails to be automatically processed, classified, and organized without any manual effort. The original v1 approach was synchronous — the Gmail webhook handler called Gemini AI inline, which meant:
- If Gemini was slow (500ms+), the webhook response was delayed
- If Gemini returned a 503 error, the email was **permanently lost**
- If multiple webhooks arrived simultaneously, they competed for Gemini API quota
- Google Pub/Sub expects a 200 response within 10 seconds, or it retries — causing duplicate processing

### Task
Design and implement a **fault-tolerant, asynchronous email processing pipeline** that:
1. Responds to webhooks instantly (< 200ms)
2. Handles Gemini API failures gracefully (no data loss)
3. Classifies emails accurately into 4 categories × 4 stages
4. Encrypts all sensitive content before storage
5. Creates deadline-based reminders automatically
6. Supports retry with backoff and dead-letter queuing

### Action

**Step 1 — Kafka Infrastructure Setup:**
I introduced Apache Kafka as a message broker between the webhook and the AI classification logic. I configured KafkaJS with a singleton producer pattern (lazy initialization — created on first use, reused for all subsequent sends) and a factory-pattern consumer creator. I defined 4 topics with 3 partitions each:

```javascript
// config/kafka.js
const TOPICS = {
  EMAIL_CLASSIFICATION: "email-classification",
  EMAIL_CLASSIFICATION_DLQ: "email-classification-dlq",
  WHATSAPP_MESSAGES: "whatsapp-messages",
  WHATSAPP_MESSAGES_DLQ: "whatsapp-messages-dlq",
};
```

**Why 3 partitions?** Each partition is consumed by one consumer in a consumer group. 3 partitions allow scaling to 3 parallel classification workers in the future. Using `userId` as the partition key ensures all emails from the same user go to the same partition, maintaining per-user ordering.

**Step 2 — Webhook Refactoring:**
The webhook controller was refactored from inline classification to Kafka-based publishing:

```javascript
// Before (v1 — fragile):
const aiResult = await classifyEmail(subject, body); // BLOCKS webhook response
await EmailModel.create(encryptedDoc);                // If this fails, email is lost

// After (v2 — fault-tolerant):
await produceEmailForClassification({ userId, subject, from, body, ... });
// Returns 200 to Pub/Sub in < 50ms — classification happens asynchronously
```

**Step 3 — Consumer with Retry Logic:**
The Kafka consumer implements a while-loop retry pattern with exponential backoff:

```javascript
while (retryCount <= MAX_RETRIES) {
  try {
    const aiResult = await classifyEmail(subject, snippet);
    // ... encrypt and store ...
    return; // Success — exit retry loop
  } catch (err) {
    retryCount++;
    if (err.code === 11000) return; // Duplicate — skip silently
    if (retryCount > MAX_RETRIES) {
      await sendToDLQ(TOPICS.EMAIL_CLASSIFICATION, payload, err.message, retryCount - 1);
      return;
    }
    const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount - 1); // 1s, 2s, 4s, 8s, 16s
    await new Promise(r => setTimeout(r, backoffMs));
  }
}
```

**Step 4 — Dead Letter Queue:**
Messages that exhaust all 5 retries are persisted in TWO locations:
1. **Kafka DLQ topic** (`email-classification-dlq`) — for potential automated reprocessing
2. **MongoDB FailedMessage collection** — for admin review via dashboard, with auto-expiry after 30 days

**Step 5 — Encryption Pipeline:**
Every field is encrypted before MongoDB storage using AES-256-GCM:

```javascript
const baseDoc = {
  subject: encrypt(subject),      // "gcm:iv:authTag:ciphertext"
  from: encrypt(from),
  snippet: encrypt(snippet),
  body: encrypt(body),
  matter: matter ? encrypt(matter) : encrypt(""),
  links: Array.isArray(links) ? links.map(l => encrypt(l)) : [],
  // Non-sensitive fields stored in plaintext for querying:
  category, aiProcessed: true, expiresAt,
};
```

**Step 6 — Reminder Creation:**
If the email has a deadline and is in stage `registration` or `inprogress`, the consumer calls `createReminders()` which creates multiple reminder documents based on time-until-deadline:

| Time Until Deadline | Reminders Created |
|---|---|
| < 3 days | immediate, 12hr, 1hr |
| ≥ 3 days | 3-day, 24hr, 12hr, 1hr |

Each reminder has a `{emailId, reminderType}` unique index to prevent duplicates on Kafka redelivery.

### Result
- Webhook response time reduced from ~2000ms to < 50ms
- **Zero email data loss** — even during Gemini API outages, messages queue in Kafka
- Classification retry success rate: ~95% of retried messages succeed within 3 attempts
- DLQ captures the remaining ~5% for manual review
- Pipeline processes emails end-to-end in < 3 seconds (webhook → Kafka → Gemini → MongoDB → Reminders)
- The system handles burst traffic from multiple Gmail accounts simultaneously without overloading Gemini

### Cross-Questions You Should Expect

**Q: Why not use Bull/BullMQ (Redis-based job queue) instead of Kafka?**
"Bull is excellent for simple job queues, but Kafka provides three advantages critical for our use case: (1) Message persistence — if the consumer crashes, Kafka retains the message and redelivers it. Bull loses jobs if Redis restarts without RDB/AOF persistence. (2) Consumer groups — I can add more classification workers without code changes; Kafka automatically rebalances. (3) Message replay — I can reprocess all emails from a specific offset for debugging or after fixing a classification bug."

**Q: Why in-process retry instead of Kafka's built-in retry mechanism?**
"Kafka doesn't have built-in retry with backoff — it relies on consumer offset management. If a message fails and we don't commit the offset, ALL subsequent messages in that partition are blocked (head-of-line blocking). Our in-process retry with `await new Promise(r => setTimeout(r, backoffMs))` allows the consumer to continue processing other messages while waiting for the backoff period."

**Q: What if the DLQ itself fails?**
"The DLQ handler has a try-catch around both the Kafka publish and MongoDB insert. If even the DLQ write fails, we log to stderr as a last resort: `logger.error('DLQ', 'CRITICAL — Failed to write to DLQ', dlqErr)`. In production, I'd add an alert on this log pattern to notify on-call engineers immediately."

---

## Feature 2: Multi-Provider OAuth with CSRF Protection

### Situation
Users needed to authenticate via three methods (Google, Microsoft, email/password), and separately connect their Gmail accounts for email monitoring. This required handling two distinct OAuth flows with different scopes and purposes, while preventing CSRF attacks and handling edge cases like account linking.

### Task
Implement a secure, multi-provider authentication system that:
1. Supports Google, Microsoft, and local email/password sign-in
2. Supports Gmail account connection (separate OAuth flow with different scopes)
3. Prevents CSRF attacks on OAuth callbacks
4. Handles account linking (e.g., user signs up with email, later logs in with Google)
5. Stores all tokens securely (encrypted at rest)

### Action

**Dual OAuth Flow Architecture:**

```
FLOW 1 — Authentication (Sign In):
  Scopes: openid, profile, email
  Purpose: Create or authenticate user account
  Callback: /api/auth/google/callback or /api/auth/microsoft/callback
  
FLOW 2 — Gmail Connection (Email Monitoring):
  Scopes: gmail.readonly, gmail.modify
  Purpose: Connect Gmail for email ingestion
  Callback: /api/auth/google/gmail/callback
  Requires: User already authenticated (JWT in cookie)
```

**CSRF Protection via JWT-Signed State:**

```javascript
// Generate state token before redirect
const state = jwt.sign(
  { purpose: "gmail-connect", userId: req.user._id },
  process.env.JWT_SECRET,
  { expiresIn: "10m" }
);
const authUrl = oAuth2Client.generateAuthUrl({
  scope: ["gmail.readonly", "gmail.modify"],
  state, // Included in the redirect URL
});

// Verify state on callback
const decoded = jwt.verify(req.query.state, process.env.JWT_SECRET);
if (decoded.purpose !== "gmail-connect") throw new Error("Invalid state");
```

**Account Linking Logic:**

```javascript
// In socialAuth.controller.js
let user = await User.findOne({ email: profile.email });

if (user) {
  // Existing user — link Google ID (don't create duplicate)
  if (!user.googleId) {
    user.googleId = profile.sub;
    await user.save();
  }
} else {
  // New user — create with Google ID
  user = await User.create({
    name: profile.name,
    email: profile.email,
    googleId: profile.sub,
    isVerified: true, // Google already verified the email
  });
}
```

**OAuth Token Encryption (Mongoose Hooks):**
```javascript
// In connectedAccount.model.js
connectedAccountSchema.pre("save", function (next) {
  if (this.isModified("accessToken") && !this.accessToken.startsWith("enc:")) {
    this.accessToken = "enc:" + encrypt(this.accessToken);
  }
  // Same for refreshToken
  next();
});

connectedAccountSchema.post("init", function () {
  if (this.accessToken?.startsWith("enc:")) {
    this.accessToken = decrypt(this.accessToken.slice(4));
  }
});
```

### Result
- Three authentication providers work seamlessly
- CSRF protection via JWT-signed state tokens — not vulnerable to session fixation
- Account linking works correctly — no duplicate accounts when switching providers
- OAuth tokens are transparently encrypted/decrypted via Mongoose lifecycle hooks
- The `isModified()` check prevents double-encryption bugs

### Cross-Questions

**Q: Why JWT-signed state instead of a random nonce stored in session?**
"A random nonce requires server-side session storage — we'd need Redis or database storage for the nonce. JWT-signed state is self-contained and stateless — it encodes the purpose, userId, and expiry. Any server instance can verify it without shared state. The 10-minute expiry prevents replay attacks."

**Q: What if someone creates an account with email/password, then tries Google sign-in with a different email?**
"The system creates a new account with the Google email. Each user is uniquely identified by email. The account linking only triggers when the Google profile email matches an existing user's email."

---

## Feature 3: Kafka-Backed WhatsApp Reminder System

### Situation
The original reminder system used direct HTTP calls from the cron scheduler to the WhatsApp service. This had critical reliability issues:
- If the WhatsApp service was down during a cron cycle, all reminders for that cycle were **lost**
- No retry mechanism — failed reminders were simply marked as "failed" in the database
- The cron scheduler was blocked waiting for HTTP responses, limiting throughput
- Network timeouts could cause duplicate sends (retry without idempotency)

### Task
Redesign the reminder delivery pipeline to guarantee message delivery even during WhatsApp service outages, using event-driven architecture for decoupling and reliability.

### Action

**Architecture Refactoring:**

```
BEFORE (v1 — Fragile):
  Cron → Query DB → HTTP POST to WhatsApp → Update DB
  Problem: If HTTP fails, reminder is lost permanently

AFTER (v2 — Kafka-Backed):
  Cron → Query DB → Kafka produce → Update status to "queued"
  WhatsApp Consumer → Send message → Update status to "sent"
  If send fails → Retry 5x with backoff → DLQ → Status "failed"
```

**Reminder Scheduling Rules:**

```
RULE 1 — Deadline < 3 days away:
  1. Remind IMMEDIATELY (scheduledAt = now)
  2. Remind 12 hours before deadline
  3. Remind 1 hour before deadline

RULE 2 — Deadline ≥ 3 days away:
  1. Remind 3 days before deadline
  2. Remind 24 hours after first reminder (= 2 days before)
  3. Remind 12 hours before deadline
  4. Remind 1 hour before deadline
```

**Cron Scheduler (every 5 minutes):**

```javascript
const dueReminders = await Reminder.find({
  status: "pending",
  scheduledAt: { $lte: now },
}).limit(50); // Process max 50 per cycle to avoid overloading

for (const reminder of dueReminders) {
  // Check user preferences, mobile verification, etc.
  if (!user.isMobileVerified || user.reminderPreferences?.whatsapp === false) {
    reminder.status = "skipped";
    reminder.failReason = "Mobile not verified";
    await reminder.save();
    continue;
  }
  
  await produceWhatsAppMessage({ reminderId, userId, whatsappNumber, message, ... });
  reminder.status = "queued"; // Kafka consumer will update to "sent" or "failed"
  await reminder.save();
  
  await new Promise(r => setTimeout(r, 500)); // 500ms delay between messages
}
```

**WhatsApp Message Formatting:**

```
🚨 *Mail-or-a Deadline Reminder*

URGENT — Deadline approaching fast!

💼 *Category:* JOB
📄 *Subject:* Oracle SDE-1 Coding Assessment
⏳ *Deadline:* 20/05/2025, 11:59:00 pm
⏱️ *Time Left:* 2h

💡 *Summary:* Complete the HackerRank coding assessment for Oracle...

—
_Open Mail-or-a to take action before it's too late!_
```

**Dual Consumer Architecture:**
The WhatsApp microservice runs its own Kafka consumer that invokes the WhatsApp client directly (no HTTP hop):

```
Main Server Consumer:
  → Receives from Kafka → HTTP POST to WhatsApp service
  → Circuit breaker protected → Updates Reminder status

WhatsApp Service Consumer (Production Path):
  → Receives from Kafka → Direct sendMessage() call (no HTTP)
  → More reliable — eliminates network hop
```

### Result
- Reminder delivery reliability improved from ~85% to ~99%
- **Zero message loss** during WhatsApp service restarts
- Messages queue in Kafka and are processed when the service recovers
- 500ms inter-message delay prevents API throttling
- 50-reminder-per-cycle limit prevents the cron job from running too long
- Circuit breaker prevents cascading failures during extended outages
- Users can disable WhatsApp reminders via preferences (checked before queuing)

---

## Feature 4: AI-Powered Resume Extraction

### Situation
Users were manually filling profile fields (skills, education, experience, projects) — a tedious process with high abandonment rates. The profile page had 7 sections to complete, and most users gave up after filling 2-3 sections.

### Task
Automate profile population by extracting structured data from uploaded resumes, with a fallback mechanism for AI service outages.

### Action

**Upload Pipeline:**
```
User uploads PDF/DOCX → Multer validates type + size (5MB limit)
→ File saved to OS temp dir → Parse text (pdf-parse / mammoth)
→ Gemini AI extracts structured JSON → Merge with existing profile
→ Upload original file to S3 → Clean up temp file → Return updated profile
```

**Gemini Extraction Prompt (Actual from codebase):**
```
Analyze the following resume text and extract all relevant profile data.
Return a STRICT JSON object with exactly the following structure:
{
  "role": "Detected Job Title or Role",
  "about": "Short bio (max 3 sentences)",
  "skills": ["Skill 1", "Skill 2"],
  "achievements": "Notable awards as a single string",
  "experience": [{ "role": "...", "company": "...", "duration": "...", "description": "..." }],
  "education": [{ "degree": "...", "institution": "...", "year": "..." }],
  "projects": [{ "title": "...", "description": "...", "link": "" }],
  "certifications": [{ "name": "...", "issuer": "...", "year": "..." }]
}
```

**Intelligent Merge Logic:**
```javascript
// Only fill empty fields — don't overwrite user's manual edits
if (!user.role && extracted.role) user.role = extracted.role;
if (!user.about && extracted.about) user.about = extracted.about;

// Deduplicate skills using Set
if (extracted.skills?.length) {
  const existing = new Set(user.skills.map(s => s.toLowerCase()));
  const newSkills = extracted.skills.filter(s => !existing.has(s.toLowerCase()));
  user.skills = [...user.skills, ...newSkills];
}
```

**Keyword-Based Fallback:**
```javascript
const SKILL_KEYWORDS = [
  "JavaScript", "Python", "React", "Node.js", "MongoDB",
  "SQL", "AWS", "Docker", "TypeScript", "Java", "C++",
  // ... 25 total keywords
];

function fallbackSkillExtraction(text) {
  return SKILL_KEYWORDS.filter(skill =>
    text.toLowerCase().includes(skill.toLowerCase())
  );
}
```

### Result
- Profile completion time reduced from ~15 minutes (manual) to ~10 seconds (AI-extracted)
- Fallback mechanism ensures the feature works even during Gemini outages
- Intelligent merge prevents overwriting user's manual edits
- S3 upload with UUID filenames prevents enumeration attacks
- Pre-signed URLs expire after 1 hour for security

---

## Feature 5: Field-Level Encryption at Rest (AES-256-GCM)

### Situation
Email content stored in MongoDB contains highly sensitive PII — email subjects, sender addresses, body text, and application details. A database breach (unauthorized access to MongoDB Atlas, leaked connection string, or compromised backup) would expose all user communications.

### Task
Implement encryption at rest for all sensitive email fields without:
- Impacting query performance (non-sensitive fields must remain queryable)
- Adding significant application complexity
- Breaking existing features
- Requiring database-level encryption (which doesn't protect against application-level access)

### Action

**Algorithm Choice — AES-256-GCM vs AES-256-CBC:**

| Feature | AES-256-CBC (v1) | AES-256-GCM (v2) |
|---|---|---|
| Confidentiality | ✅ Yes | ✅ Yes |
| Integrity (tamper detection) | ❌ No | ✅ Yes (auth tag) |
| Padding oracle attack | ⚠️ Vulnerable | ✅ Immune |
| Performance | Slightly slower (padding) | Slightly faster (stream cipher) |

**Encryption Implementation:**
```javascript
exports.encrypt = (text) => {
  if (!text) return text;
  const iv = crypto.randomBytes(16);                  // Random IV per encryption
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const authTag = cipher.getAuthTag().toString("hex"); // Integrity tag
  
  return `gcm:${iv.toString("hex")}:${authTag}:${encrypted}`;
  // Format: "gcm:<32-char-iv>:<32-char-authTag>:<ciphertext>"
};
```

**Backward-Compatible Decryption:**
```javascript
exports.decrypt = (text) => {
  if (!text || typeof text !== "string") return text;
  
  // GCM format: "gcm:iv:authTag:ciphertext"
  if (text.startsWith("gcm:")) {
    // ... GCM decryption with auth tag verification ...
  }
  
  // Legacy CBC format: "iv:ciphertext"
  if (text.includes(":")) {
    // ... CBC decryption for backward compatibility ...
  }
  
  return text; // Not encrypted — return as-is
};
```

**What's Encrypted vs. What's Queryable:**

| Field | Encrypted? | Why? |
|---|---|---|
| subject | ✅ Yes | PII — contains company names, offer details |
| from | ✅ Yes | PII — sender email address |
| body | ✅ Yes | PII — full email content |
| snippet | ✅ Yes | PII — email preview text |
| matter | ✅ Yes | AI summary may contain sensitive info |
| links | ✅ Yes (each link) | Application URLs are sensitive |
| category | ❌ No | Needed for filtering queries |
| stage | ❌ No (implicit by collection) | Determined by collection name |
| userId | ❌ No | Needed for access control queries |
| receivedAt | ❌ No | Needed for sorting/pagination |
| providerMessageId | ❌ No | Needed for duplicate detection |
| expiresAt | ❌ No | Needed for TTL index |

**Key Management:**
```javascript
// Server REFUSES to start without encryption key
if (!process.env.EMAIL_ENCRYPTION_KEY) {
  console.error("FATAL: EMAIL_ENCRYPTION_KEY is not defined!");
  process.exit(1);
}

// Key derived via SHA-256 to ensure exactly 32 bytes
const key = crypto.createHash("sha256")
  .update(process.env.EMAIL_ENCRYPTION_KEY)
  .digest(); // 256-bit key
```

### Result
- All email content encrypted at rest with AES-256-GCM
- Authentication tag prevents ciphertext tampering
- Random IV per encryption prevents identical plaintexts from producing identical ciphertexts
- Backward compatibility with legacy CBC ciphertext (auto-detected by prefix)
- Server refuses to boot without encryption key — fail-safe design
- Non-sensitive fields remain queryable — no performance impact on filters/pagination
- OAuth tokens transparently encrypted via Mongoose hooks

### Cross-Questions

**Q: Why not use MongoDB Client-Side Field Level Encryption (CSFLE)?**
"MongoDB CSFLE uses the MongoDB driver's built-in encryption, which is excellent but requires MongoDB Enterprise or Atlas with specific driver versions. Our approach is database-agnostic — it works with any MongoDB deployment and gives us full control over the encryption algorithm, key management, and migration path."

**Q: What if two identical emails produce different ciphertexts?**
"That's by design. Each encryption uses a random IV (`crypto.randomBytes(16)`), so encrypting 'Hello' twice produces completely different ciphertexts. This is a security feature — it prevents frequency analysis attacks where an attacker could deduce content by comparing ciphertext patterns."

**Q: How would you rotate the encryption key?**
"Lazy re-encryption: (1) Store the new key alongside the old key. (2) On read, try decrypting with the new key first, then fall back to the old key. (3) After successful decryption with the old key, re-encrypt with the new key and save. (4) Eventually, all data migrates to the new key. This avoids a bulk migration that would be expensive and risky."
