# 7. AWS / CLOUD / DEVOPS — Complete Analysis

---

## AWS S3 — Deep Dive

### Operations Implemented

**1. Upload (`uploadToS3`):**
```javascript
exports.uploadToS3 = async (filePath, originalName, mimetype, userId, folder = "resumes") => {
  const ext = path.extname(originalName);             // .pdf, .docx
  const uniqueName = `${crypto.randomUUID()}${ext}`;  // UUID prevents enumeration
  const key = `${folder}/${userId}/${uniqueName}`;    // resumes/userId/uuid.pdf
  const fileStream = fs.createReadStream(filePath);   // Stream to avoid memory bloat
  
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: fileStream,
    ContentType: mimetype,
  }));
  
  const url = `https://${BUCKET}.s3.${AWS_REGION}.amazonaws.com/${key}`;
  return { key, url };
};
```

**Security decisions:**
- UUID filename prevents enumeration (attacker can't guess `resume1.pdf`, `resume2.pdf`)
- Path includes userId for logical isolation (`resumes/user123/uuid.pdf`)
- FileStream instead of Buffer to avoid loading entire file into memory

**2. Delete (`deleteFromS3`):**
```javascript
exports.deleteFromS3 = async (key) => {
  await s3.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
};
// Called when: user replaces profile photo, user deletes resume
```

**3. Pre-Signed URL (`getPresignedUrl`):**
```javascript
exports.getPresignedUrl = async (key, expiresIn = 3600) => {
  if (!key) return null;
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: key });
  return await getSignedUrl(s3, command, { expiresIn }); // 1 hour default
};
```

**Why pre-signed URLs instead of public bucket:**
- Bucket is NOT publicly accessible — no anonymous read
- Pre-signed URLs contain a cryptographic signature + expiry timestamp
- Even if someone intercepts the URL, it expires after 1 hour
- No IAM credentials needed on the client — the URL itself grants temporary access

**Cost Analysis (at scale):**
| Component | 1K users | 100K users |
|---|---|---|
| Storage (1MB avg × 2 files per user) | 2 GB = $0.05/mo | 200 GB = $4.60/mo |
| PUT requests | 2K = $0.01 | 200K = $1.00 |
| GET requests (pre-signed) | 10K = $0.004 | 1M = $0.40 |
| **Total** | **~$0.06/mo** | **~$6/mo** |

---

## Docker Multi-Stage Builds — Deep Dive

### Server Dockerfile Analysis
```dockerfile
FROM node:20-alpine AS server
WORKDIR /app/server

# Layer 1: Dependencies (cached if package.json unchanged)
COPY server/package*.json ./
RUN npm ci --omit=dev
# npm ci = clean install (deletes node_modules first, exact versions from lock file)
# --omit=dev = excludes devDependencies (jest, nodemon) → smaller image

# Layer 2: Source code
COPY server/ ./

EXPOSE 5000

# Health check — Docker marks container "unhealthy" if this fails
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://localhost:5000/health || exit 1

CMD ["node", "server.js"]
```

**Why Alpine:** ~5MB base image vs ~350MB for Debian. No unnecessary tools.
**Why `npm ci` over `npm install`:** `ci` uses exact versions from `package-lock.json`. `install` may update versions, causing non-deterministic builds.
**Why separate COPY for package.json:** Docker caches layers. If only source code changes (not dependencies), the `npm ci` layer is cached — builds are 10x faster.

### Client Dockerfile Analysis (2-Stage)
```dockerfile
# ── Stage 1: Build ──
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci              # Install ALL deps (including devDeps for build)
COPY . .
RUN npm run build       # Vite builds to /app/dist (~5MB of optimized assets)

# ── Stage 2: Serve ──
FROM nginx:alpine AS production
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -q --spider http://localhost:80/ || exit 1
CMD ["nginx", "-g", "daemon off;"]
```

**Image size comparison:**
| Stage | Image | Size |
|---|---|---|
| Build (discarded) | node:20-alpine + deps + source | ~900 MB |
| **Production** | nginx:alpine + dist folder | **~25 MB** |

**Why Nginx over `npx serve`:** Nginx handles static files 10x more efficiently, supports gzip compression, caching headers, and SPA routing natively.

---

## Docker Compose Orchestration

### Service Dependencies
```yaml
services:
  zookeeper:  # Must start first
  kafka:
    depends_on:
      zookeeper:
        condition: service_healthy
  mongodb:    # Independent
  server:
    depends_on:
      kafka:
        condition: service_healthy
      mongodb:
        condition: service_healthy
  client:     # Independent (static files)
  whatsapp:
    depends_on:
      kafka:
        condition: service_healthy
  serpapi:
    depends_on:
      mongodb:
        condition: service_healthy
```

### Startup Order (enforced by health checks):
```
1. Zookeeper (port 2181)    — Kafka coordination
2. MongoDB (port 27017)     — Database (independent of Kafka)
3. Kafka (port 9092)        — After Zookeeper is healthy
4. Server (port 5000)       — After Kafka + MongoDB are healthy
5. WhatsApp (port 5002)     — After Kafka is healthy
6. SerpAPI (port 5001)      — After MongoDB is healthy
7. Client (port 80)         — Independent (Nginx + static files)
```

---

## Gmail Watch Renewal System

### Problem
Gmail Pub/Sub watch subscriptions expire after **exactly 7 days**. If not renewed, the system silently stops receiving email notifications — users don't get new emails classified, and no one knows until they manually check.

### Solution: `watchRenewal.service.js`
```javascript
// Runs every 6 hours
const CRON_SCHEDULE = "0 */6 * * *";
const RENEWAL_BUFFER_HOURS = 24; // Renew 24 hours before expiry

async function processWatchRenewals() {
  const renewalThreshold = new Date(Date.now() + 24 * 60 * 60 * 1000);
  
  // Find accounts expiring within 24 hours OR without expiry set
  const accounts = await ConnectedAccount.find({
    provider: "google",
    isActive: true,
    $or: [
      { watchExpiry: { $lt: renewalThreshold } },
      { watchExpiry: { $exists: false } },
      { watchExpiry: null },
    ],
  });
  
  for (const account of accounts) {
    const oauthClient = await refreshGoogleTokenIfNeeded(account);
    const gmail = getGmailClient(oauthClient);
    
    const watchResponse = await gmail.users.watch({
      userId: "me",
      requestBody: { topicName: GOOGLE_PUBSUB_TOPIC, labelIds: ["INBOX"] },
    });
    
    account.lastHistoryId = watchResponse.data.historyId;
    account.watchExpiry = new Date(parseInt(watchResponse.data.expiration));
    await account.save();
    
    await new Promise(r => setTimeout(r, 1000)); // 1s delay between renewals
  }
}
```

### Timeline Protection
```
Day 0: Watch created → expiry = Day 7
Day 6: Cron detects expiry within 24h → renews → new expiry = Day 13
Day 12: Cron detects again → renews → new expiry = Day 19
...forever
```

---

## Graceful Shutdown (Production-Grade)

```javascript
async function shutdown(signal) {
  logger.info("Server", `${signal} — initiating graceful shutdown`);
  
  // 1. Stop HTTP — no new requests
  server.close();
  
  // 2. Stop Kafka consumers — finish current message, don't pick up new ones
  if (emailConsumer) await emailConsumer.disconnect();
  if (whatsappConsumer) await whatsappConsumer.disconnect();
  
  // 3. Stop Kafka producer — no more messages to broker
  await disconnectProducer();
  
  // 4. Close MongoDB — last, because consumers may need DB during drain
  await mongoose.connection.close();
  
  process.exit(0);
}

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
```

**Why this matters for interviews:**
- Shows you understand container lifecycle (Docker sends SIGTERM before SIGKILL)
- Kubernetes rolling updates send SIGTERM → pod has 30s to shut down gracefully
- Without graceful shutdown, in-flight Kafka messages could be lost or double-processed

---

## Nginx Production Configuration

```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    # Gzip — reduces transfer size by ~70%
    gzip on;
    gzip_types text/plain text/css application/json application/javascript
               text/xml application/xml text/javascript image/svg+xml;
    gzip_min_length 256;

    # Cache static assets — Vite adds content hashes to filenames
    location ~* \.(js|css|png|jpg|jpeg|gif|ico|svg|webp|woff|woff2|ttf|eot)$ {
        expires 1y;
        add_header Cache-Control "public, immutable";
        # "immutable" tells browsers: don't even make conditional requests
    }

    # SPA fallback — all routes serve index.html
    location / {
        try_files $uri $uri/ /index.html;
        # /dashboard → not a file → serve index.html → React Router handles it
    }
}
```

---

## Production Readiness Gaps & Migration Plans

| Gap | Current State | Production Fix | Effort |
|---|---|---|---|
| Redis | Config exists, not connected | Connect for rate limiting + caching | 1 day |
| CI/CD | Tests exist, no pipeline | GitHub Actions: lint → test → build → deploy | 2 days |
| Monitoring | Structured logs only | DataDog/CloudWatch + alerting on DLQ volume | 2 days |
| Load Balancing | Single instance | AWS ALB + Auto Scaling Group | 1 day |
| Secret Management | .env files | AWS Secrets Manager or Vault | 1 day |
| Kubernetes | Docker Compose only | Helm charts + K8s manifests | 3 days |
| CDN | Direct Nginx | CloudFront for static assets | 1 day |
| Database HA | Single instance | MongoDB Atlas M10+ (3-node replica set) | Config change |
