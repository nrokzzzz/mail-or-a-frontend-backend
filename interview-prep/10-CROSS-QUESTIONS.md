# 10. INTERVIEW CROSS-QUESTION SIMULATION

---

## Technology Choice Questions

### Q: Why didn't you use PostgreSQL?
"Our data is denormalized by design — each email document is self-contained with encrypted fields, arrays of links, and nested objects. We don't have relationships between emails that would benefit from JOINs. Specifically:

1. **Schema variability:** Registration and InProgress emails have `deadlineDate`; Registered and Confirmed don't. In PostgreSQL, we'd need nullable columns or a separate table — in MongoDB, each collection has exactly the schema it needs.
2. **Array fields:** Each email has a `links` array of encrypted URLs. In MongoDB, this is a native array. In PostgreSQL, we'd need a join table or JSONB column.
3. **TTL indexes:** MongoDB's `expireAfterSeconds` auto-deletes expired emails. PostgreSQL would need a cron job or `pg_partman` extension.
4. **Cross-collection queries:** MongoDB's `$unionWith` aggregation handles our 4-collection query pattern. PostgreSQL would use `UNION ALL`, which is functionally equivalent but requires maintaining consistent column lists across 4 tables.

That said, if we needed ACID transactions across collections (e.g., atomically creating an email AND its reminders), PostgreSQL would be a better fit. Currently, we handle this at the application level — if reminder creation fails, we log a warning but the email is still stored."

### Q: Why JWT instead of sessions?
"Three reasons:

1. **Stateless scaling:** JWT is self-contained — any server instance can verify it without querying a session store. With sessions, I'd need Redis as a shared session store, adding another infrastructure dependency and a potential SPOF.

2. **Cross-domain compatibility:** Our frontend (mail-or-a.dev) and backend (server.mail-or-a.dev) are on different subdomains. JWT in httpOnly cookies with `sameSite: none` handles this seamlessly. Session-based auth with cross-domain cookies is more complex.

3. **OAuth callback flows:** After Google OAuth redirects to our callback, we need to authenticate the user and redirect to the frontend. JWT can be passed as a URL parameter for the initial redirect, then stored as a cookie. Session IDs are harder to transfer across redirect chains.

**Acknowledged weakness:** JWT can't be revoked before expiry. For force-logout (e.g., after password change), I'd add a `tokenInvalidatedAt` timestamp to the User model — any JWT issued before this timestamp is rejected."

### Q: What happens if MongoDB crashes?
"Multiple layers of resilience:

1. **Atlas Replica Set (production):** 3-node replica set with automatic failover. If the primary goes down, a secondary becomes primary within 10-12 seconds. Reads can be directed to secondaries during failover.

2. **Kafka buffering:** During the MongoDB outage, the email classification consumer can't store classified emails. The consumer's retry logic keeps the message in Kafka (it's not committed). When MongoDB recovers, processing resumes automatically from the last committed offset.

3. **Health endpoint:** `GET /health` returns MongoDB connection status. Load balancers check this endpoint and route traffic away from instances with failed DB connections.

4. **Graceful degradation:** The server doesn't crash if MongoDB disconnects — it returns 503 for database-dependent endpoints while still serving cached data and static health checks.

5. **Graceful shutdown:** On SIGTERM, the server closes MongoDB connections cleanly, preventing corrupted write operations."

### Q: How do you prevent a Kafka message from being processed twice?
"Idempotent processing at the database level. Kafka provides at-least-once delivery — a message might be delivered twice if the consumer crashes after processing but before committing the offset. Our defense:

1. **Compound unique index:** `{providerMessageId, provider}` on all email collections. If the same email is processed twice, the second `Model.create()` throws MongoDB error code 11000 (duplicate key).

2. **Error handling:** The consumer explicitly catches error 11000 and returns silently — no retry, no DLQ. This is expected behavior during redelivery.

```javascript
if (err.code === 11000) {
  logger.debug('KafkaConsumer', `Duplicate skipped: ${messageId}`);
  return; // Not an error — just a redelivery
}
```

3. **Reminder deduplication:** Same principle — `{emailId, reminderType}` unique index prevents duplicate reminders.

4. **Producer-side:** The producer includes `retryCount: 0` in the initial message. If the consumer retries internally and fails, it increments `retryCount`. This prevents confusion between Kafka redelivery (same retryCount) and application-level retry (incremented retryCount)."

---

## Architecture Questions

### Q: Why not use WebSockets for real-time email updates?
"WebSockets would provide true real-time updates but add significant complexity for marginal user benefit:

1. **Connection management:** Need to handle connection lifecycle — connect, disconnect, reconnect, heartbeat. With multiple server instances, need sticky sessions or a shared state layer (Redis Pub/Sub).

2. **State synchronization:** When a new email is classified (by the Kafka consumer), we'd need to emit a WebSocket event to the correct user's connection. This requires a mapping of userId → WebSocket connection, shared across all server instances.

3. **Current latency:** Our Kafka pipeline processes emails in < 3 seconds. The dashboard can poll every 30 seconds (or use long-polling) for near-real-time updates without WebSocket complexity.

4. **Future plan:** If we add WebSockets, I'd use Socket.io with a Redis adapter:
   - Kafka consumer stores email → publishes event to Redis channel
   - All Socket.io instances subscribed to Redis → emit to connected users
   - Only the instance holding the user's connection delivers the message"

### Q: Why not use WebSockets instead of WhatsApp for reminders?
"Different use case entirely. WebSockets only work when the user has the app open in a browser tab. The whole point of WhatsApp reminders is reaching users when they're NOT using the app — when they're commuting, in class, or doing other things. WhatsApp notifications appear on their phone lock screen; WebSocket messages don't."

### Q: How do you handle Gemini API rate limits?
"Three layers of protection, each addressing a different failure mode:

1. **Kafka natural throttling:** Each Kafka partition is consumed sequentially — one message at a time. With 3 partitions, we process at most 3 emails simultaneously. This inherently limits our Gemini API call rate.

2. **Circuit breaker:** If Gemini returns 5 consecutive errors (429 rate limit, 503 service unavailable, or timeout), the circuit breaker opens for 30 seconds. During this window, ALL classification attempts fail immediately — no API calls are made. This prevents us from burning through rate limits during an outage.

3. **Exponential backoff:** Within the retry loop, each failure waits longer before retrying:
   - Retry 1: 1 second
   - Retry 2: 2 seconds
   - Retry 3: 4 seconds
   - Retry 4: 8 seconds
   - Retry 5: 16 seconds
   - Total max wait: 31 seconds

4. **DLQ fallback:** If all 5 retries fail, the message goes to the DLQ. It's not lost — an admin can review it and trigger reprocessing when the rate limit resets."

### Q: Why 4 separate collections instead of one with a `stage` field?
"Separation of concerns and schema precision:

1. **Schema differences:** `registration` and `inprogress` have `deadlineDate` (Date type, indexed). `registered` and `confirmed` don't have this field at all. A single collection would need a nullable `deadlineDate` that's only used by 50% of documents — wasting index space.

2. **Per-stage indexing:** Each collection has indexes optimized for its specific query patterns. The `registration` collection has an additional index on `deadlineDate` for reminder queries; the `confirmed` collection doesn't need this index.

3. **TTL flexibility:** Currently all collections use 3-month TTL. In the future, we might want `confirmed` emails (offer letters) to persist longer than `registration` emails. Separate collections make this trivial.

4. **Query performance:** When a user views their 'Registration' tab, the query hits only the `registrationemails` collection (~25% of total documents). A single collection would scan all documents with a filter.

5. **Cross-collection aggregation:** For the 'All Emails' view, MongoDB's `$unionWith` aggregation efficiently combines all 4 collections with database-level sorting and pagination. Performance is comparable to a single-collection query with a `stage` filter."

### Q: What if the encryption key is compromised?
"This is the worst-case scenario — all encrypted data becomes readable. Our mitigation strategy:

1. **Key storage:** The key is in environment variables, never in source code. In production, it should be in AWS Secrets Manager or HashiCorp Vault with access logging.

2. **Key rotation strategy:**
   ```
   Phase 1: Deploy new code that supports TWO keys (old + new)
   Phase 2: New encryptions use the new key
   Phase 3: On read, try new key first, fall back to old key
   Phase 4: After successful old-key decryption, re-encrypt with new key and save
   Phase 5: Eventually, all data migrates to the new key (lazy migration)
   Phase 6: Remove old key support
   ```

3. **Detection:** The GCM authentication tag detects tampering. If an attacker modifies the ciphertext (e.g., tries to inject data), decryption fails with an authentication error. This doesn't prevent reading (if they have the key), but it prevents undetected modification.

4. **Audit trail:** In production, I'd add an `encryptedAt` timestamp and `keyVersion` field to each document. This enables tracking which documents were encrypted with which key version during rotation."

---

## Failure Scenario Questions

### Q: What happens if Kafka goes down?
"Different impacts depending on which component fails:

**Kafka broker down (messages can't be produced):**
- Webhook controller's `produceEmailForClassification()` throws → caught by error handler
- Webhook returns 200 to Pub/Sub (we always return 200)
- Emails are NOT queued — they're lost for this webhook cycle
- BUT: Google Pub/Sub will retry the webhook delivery (with exponential backoff)
- When Kafka recovers, the retried webhook will succeed
- **Net effect:** Delayed processing, no data loss (thanks to Pub/Sub retry)

**Kafka consumer crashes:**
- Messages accumulate in the topic (Kafka persists them)
- When consumer restarts, it resumes from the last committed offset
- All accumulated messages are processed
- **Net effect:** Delayed processing, no data loss

**Zookeeper down (Kafka can't coordinate):**
- Kafka stops accepting new connections
- Existing consumers keep working until they need to rebalance
- Producers fail to send → same as broker down scenario
- **Net effect:** System degrades until Zookeeper recovers"

### Q: What happens if a user deletes their Gmail account?
"The webhook would still fire (Google Pub/Sub doesn't know about account deletion), but:

1. The webhook decodes the emailAddress from the Pub/Sub message
2. `ConnectedAccount.findOne({ emailAddress })` still returns the stored account
3. `refreshGoogleTokenIfNeeded()` fails because the OAuth tokens are invalid
4. Error is caught → logged as warning → webhook returns 200
5. The ConnectedAccount remains in our database with `isActive: true`

**Improvement needed:** Add a daily health check that tries to call `gmail.users.getProfile()` for each active account. If it returns 401/403, mark the account as `isActive: false` and notify the user."

### Q: What if two webhooks arrive for the same email simultaneously?
"Handled by our idempotent processing:

1. Both webhooks decode the same `historyId` and email
2. Both publish the same `messageId` to Kafka
3. Even if both are processed by different consumer instances, the compound unique index `{providerMessageId, provider}` ensures only one insert succeeds
4. The second insert throws error 11000 → caught and skipped
5. **Net effect:** Email is stored exactly once, reminders created exactly once"
