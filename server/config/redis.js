/**
 * Redis Configuration
 *
 * Provides a Redis client singleton for:
 * - Rate limiting store (express-rate-limit with Redis backing)
 * - Session caching
 * - Distributed locks
 *
 * Currently uses in-memory rate limiting via express-rate-limit's default store.
 * When deploying multi-instance, enable Redis by setting REDIS_URL in env.
 *
 * TODO: When scaling to multi-instance production:
 *   1. Install: npm install rate-limit-redis ioredis
 *   2. Set REDIS_URL in .env (e.g., redis://localhost:6379)
 *   3. Uncomment the code below
 *   4. Update rateLimiter.middleware.js to use RedisStore
 */

// const Redis = require("ioredis");
// const logger = require("../utils/logger");
//
// let redisClient = null;
//
// function getRedisClient() {
//   if (!redisClient) {
//     const url = process.env.REDIS_URL || "redis://localhost:6379";
//     redisClient = new Redis(url, {
//       maxRetriesPerRequest: 3,
//       retryStrategy: (times) => Math.min(times * 200, 5000),
//     });
//
//     redisClient.on("connect", () => logger.info("Redis", "Connected"));
//     redisClient.on("error", (err) => logger.error("Redis", "Connection error", err));
//   }
//   return redisClient;
// }
//
// module.exports = { getRedisClient };

// Placeholder export — safe to import without Redis installed
module.exports = {
  getRedisClient: () => {
    throw new Error(
      "Redis is not configured. Set REDIS_URL in .env and install ioredis to enable Redis features."
    );
  },
};
