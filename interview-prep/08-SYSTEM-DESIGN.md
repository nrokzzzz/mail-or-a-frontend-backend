# 8. SYSTEM DESIGN QUESTIONS — Amazon SDE-1 Level

---

## Q1: How would your system handle 1 million users?

### Current Bottlenecks (Honest Assessment)
| Component | Current | Bottleneck At | Solution |
|---|---|---|---|
| MongoDB | Single instance | ~10K concurrent writes | Sharded cluster |
| Kafka | Single broker, 3 partitions | ~100K msgs/sec (OK) | Multi-broker cluster |
| Express Server | Single instance | ~5K concurrent connections | ALB + Auto Scaling |
| Rate Limiting | In-memory (express-rate-limit) | Multiple instances lose state | Redis-backed |
| Gemini API | Sequential per partition | ~100 classifications/sec | Batch + caching |

### Scaling Plan

**Database Scaling:**
```
Current:  Single MongoDB → mongoUri="mongodb://localhost:27017/mailora"
Scaled:   MongoDB Atlas M30 (sharded cluster)
          Shard key: userId (hashed) — distributes users across shards
          Read replicas: 2 secondary nodes per shard
          Connection pooling: maxPoolSize=50 per server instance
```

**Why `userId` as shard key:**
- All of a user's emails are on the same shard → no cross-shard queries for per-user operations
- Hashed sharding distributes evenly (prevents hot spots from power users)
- The `getAllEmails` aggregation with `$unionWith` works within a single shard

**Kafka Scaling:**
```
Current:  1 broker, 3 partitions per topic
Scaled:   3 brokers, 12 partitions per topic
          Replication factor: 3 (every message on 3 brokers)
          min.insync.replicas: 2 (at least 2 replicas must acknowledge)
          
Consumer scaling:
  email-classification: 4 consumer instances (3 partitions each)
  whatsapp-messages: 4 consumer instances
  
Throughput:
  3 brokers × 4 partitions × ~1000 msgs/sec/partition = ~12K msgs/sec
  More than enough for 1M users (avg ~5 emails/user/day = ~58 msgs/sec)
```

**Server Scaling:**
```
Current:  1 Express server on port 5000
Scaled:   AWS ALB → Auto Scaling Group (3-10 instances)
          Health check: GET /health (returns MongoDB + Kafka status)
          Scale-up trigger: CPU > 70% or response time > 500ms
          Scale-down trigger: CPU < 30% for 10 minutes
          
Stateless design:
  ✅ JWT auth — any instance can verify tokens
  ✅ Kafka — any instance can produce messages
  ❌ Rate limiting — needs Redis (in-memory state is per-instance)
```

**Caching Layer:**
```
Redis cluster with 3 tiers:
  L1 (Hot):  Rate limit counters, active sessions — TTL: 15 min
  L2 (Warm): User profiles, ConnectedAccount lookups — TTL: 5 min
  L3 (Cold): S3 pre-signed URLs — TTL: 50 min (URL expires in 60 min)
  
Cache invalidation:
  User.save() → delete cache key "user:{userId}"
  ConnectedAccount.save() → delete cache key "account:{accountId}"
  Email stored → publish event → invalidate email count cache
```

### Follow-up: What's the bottleneck?

**The Gemini AI API.** It has rate limits (~1000 RPM on free tier, ~10K RPM on paid) and ~500ms latency per classification.

**Mitigation strategies:**
1. **Batch classification:** Instead of 1 email per Gemini call, batch 5-10 emails in a single prompt. Response is a JSON array.
2. **Result caching:** Hash `subject + snippet` → check Redis before calling Gemini. Similar emails (e.g., LinkedIn job alerts) produce identical classifications.
3. **Local fallback model:** Train a lightweight TensorFlow.js model on historical classifications. Use for common patterns, escalate ambiguous cases to Gemini.
4. **Priority queue:** Create a high-priority Kafka topic for time-sensitive emails (inprogress stage), low-priority for newsletters.

---

## Q2: How would you reduce API latency?

### Current Latency Breakdown
| Operation | Latency | Location |
|---|---|---|
| JWT verification | ~1ms | Auth middleware |
| User.findById() | ~5-10ms | MongoDB (indexed) |
| Email decryption (per field) | ~0.5ms | crypto.js |
| Gemini AI classification | ~500-2000ms | External API |
| S3 pre-signed URL generation | ~50-100ms | AWS SDK |
| MongoDB aggregation (pagination) | ~20-50ms | MongoDB |

### Optimization Strategies

**1. Cache User lookups:**
```javascript
// Before: Every request → User.findById()
const user = await User.findById(decoded.id);

// After: Redis cache with 5-min TTL
let user = await redis.get(`user:${decoded.id}`);
if (!user) {
  user = await User.findById(decoded.id);
  await redis.set(`user:${decoded.id}`, JSON.stringify(user), "EX", 300);
}
```

**2. Cache S3 pre-signed URLs:**
```javascript
// Pre-signed URLs are valid for 1 hour
// Cache for 50 minutes to avoid serving expired URLs
const cacheKey = `s3url:${key}`;
let url = await redis.get(cacheKey);
if (!url) {
  url = await getPresignedUrl(key);
  await redis.set(cacheKey, url, "EX", 3000); // 50 min
}
```

**3. Connection pooling:**
```javascript
// MongoDB: Default pool size = 5 → increase to 20
mongoose.connect(uri, { maxPoolSize: 20, minPoolSize: 5 });

// Kafka: Producer already uses singleton pattern (single connection)
// S3: AWS SDK v3 uses keep-alive by default
```

**4. Email decryption batching:**
```javascript
// Currently: Decrypt each field individually (6 decrypt calls per email)
// Optimized: Batch decrypt in a worker thread to not block event loop
const { Worker } = require("worker_threads");
// For large result sets (50+ emails), offload decryption to worker
```

---

## Q3: How would you handle duplicate emails?

### 4-Layer Deduplication Strategy

```
Layer 1: Gmail History API
  └── startHistoryId → only fetches NEW messages since last sync
      No re-fetching of previously processed emails

Layer 2: Kafka Partition Key
  └── key: userId → all emails from same user go to same partition
      Same consumer processes them → sequential, no race conditions

Layer 3: MongoDB Compound Unique Index
  └── { providerMessageId: 1, provider: 1 } (unique)
      If Kafka redelivers → Model.create() throws error 11000 → caught and skipped

Layer 4: Reminder Deduplication
  └── { emailId: 1, reminderType: 1 } (unique)
      If email processed twice → reminders already exist → error 11000 → skipped
```

**Code implementation:**
```javascript
// In emailClassification.consumer.js
try {
  await Model.create(doc);
} catch (err) {
  if (err.code === 11000) {
    // Duplicate — this is EXPECTED during Kafka redelivery
    logger.debug("KafkaConsumer", `Duplicate skipped: ${messageId}`);
    return; // Don't retry, don't DLQ — just skip
  }
  throw err; // Other errors get retried
}
```

---

## Q4: How would you avoid single points of failure?

### Current SPOFs and Mitigation

| Component | SPOF? | Mitigation |
|---|---|---|
| MongoDB | Yes (single) | Atlas replica set (3 nodes, auto-failover) |
| Kafka broker | Yes (single) | 3-broker cluster, replication factor 3 |
| Express server | Yes (single) | ALB + Auto Scaling Group |
| WhatsApp service | **Yes (hard)** | Replace with WhatsApp Business API |
| SerpAPI service | Yes but non-critical | Cached results serve during outage |
| Gemini AI | External (managed) | Circuit breaker + DLQ (already implemented) |
| DNS | External | Route 53 with health checks |

**WhatsApp Service — The Hardest SPOF:**
whatsapp-web.js runs a headless Chromium browser with a single authenticated session. You can't run two instances because WhatsApp allows only one active web session per phone number.

**Options:**
1. **WhatsApp Business API (Cloud)** — Official Meta API, supports multiple instances, no browser needed. Costs ~$0.05 per message.
2. **Twilio WhatsApp** — Managed API, handles session management, supports templates.
3. **Fallback channel** — If WhatsApp fails, send reminder via email (Nodemailer is already configured).

---

## Q5: How would you scale file uploads?

### Current Flow (Server-Side Upload)
```
Client → Express (Multer) → temp disk → S3 → cleanup
Problem: Server is a bottleneck for large files. Blocks request handler.
```

### Improved Flow (Client-Side Upload)
```
1. Client requests pre-signed PUT URL from server
   POST /api/upload/presign { filename, contentType }
   
2. Server generates pre-signed PUT URL (no file transfer)
   const url = await getSignedUrl(s3, new PutObjectCommand({
     Bucket: BUCKET,
     Key: `resumes/${userId}/${uuid}.pdf`,
     ContentType: "application/pdf",
   }), { expiresIn: 300 }); // 5-minute upload window
   
3. Client uploads DIRECTLY to S3 (bypasses server completely)
   await fetch(presignedUrl, { method: "PUT", body: file });
   
4. Client notifies server with S3 key
   POST /api/profile/resume { key: "resumes/userId/uuid.pdf" }
   
5. Server processes (AI extraction) asynchronously via Kafka
```

**Benefits:**
- Server handles metadata only (< 1KB), not file content (up to 5MB)
- S3 handles upload bandwidth — auto-scales to thousands of concurrent uploads
- AI extraction runs asynchronously — upload response is instant

---

## Q6: How would you implement caching?

### Cache Architecture
```
┌──────────┐     ┌─────────┐     ┌──────────┐
│  Client   │────▶│  Server  │────▶│  Redis   │
│  (React)  │     │ (Express)│     │  Cache   │
└──────────┘     └─────────┘     └──────────┘
                       │                │
                       ├── Cache HIT ──▶│ Return cached data (< 1ms)
                       │                │
                       ├── Cache MISS ─▶│ Query MongoDB (5-50ms)
                       │                │ Store in Redis with TTL
                       │                │ Return fresh data
                       └────────────────┘
```

### Cache-Aside Pattern (Implementation)
```javascript
async function getUserProfile(userId) {
  const cacheKey = `user:${userId}`;
  
  // 1. Try cache first
  const cached = await redis.get(cacheKey);
  if (cached) return JSON.parse(cached);
  
  // 2. Cache miss → query database
  const user = await User.findById(userId);
  
  // 3. Store in cache with TTL
  await redis.set(cacheKey, JSON.stringify(user), "EX", 300); // 5 min
  
  return user;
}

// Invalidation: on any write to user
async function updateUser(userId, updates) {
  await User.findByIdAndUpdate(userId, updates);
  await redis.del(`user:${userId}`); // Invalidate cache
}
```

### What to Cache (and What NOT to Cache)

| Data | Cache? | TTL | Reason |
|---|---|---|---|
| User profile | ✅ Yes | 5 min | Read-heavy, rarely updated |
| ConnectedAccount | ✅ Yes | 5 min | Checked on every webhook |
| Email list (paginated) | ⚠️ Maybe | 1 min | Changes when new emails arrive |
| S3 pre-signed URLs | ✅ Yes | 50 min | Expensive to generate, valid for 60 min |
| Gemini classification | ✅ Yes | 24 hr | Same subject/snippet = same result |
| Rate limit counters | ✅ Yes (Redis native) | Window size | Must be shared across instances |
| OAuth tokens | ❌ No | — | Already encrypted in DB, too sensitive for cache |
| Email content (decrypted) | ❌ No | — | PII should not be in cache |
