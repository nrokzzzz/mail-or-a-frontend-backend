/**
 * Server Entry Point
 *
 * Initializes the database connection, Kafka consumers, and
 * the WhatsApp reminder cron scheduler. Includes graceful
 * shutdown handling for production reliability.
 */

require("dotenv").config();
const app = require("./app");
const connectDB = require("./config/db");
const logger = require("./utils/logger");
const { startReminderScheduler } = require("./services/reminderScheduler.service");
const { ensureTopics, TOPICS, disconnectKafka } = require("./config/kafka");
const { startEmailClassificationConsumer } = require("./services/kafka/emailClassification.consumer");
const { startWhatsAppMessageConsumer } = require("./services/kafka/whatsappMessage.consumer");
const mongoose = require("mongoose");

// ─── Global Error Safety Net ────────────────────────────────────────────────

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Process", "Unhandled Rejection", reason);
});

process.on("uncaughtException", (error) => {
  logger.error("Process", "Uncaught Exception — shutting down", error);
  process.exit(1);
});

// ─── Kafka Consumer References (for graceful shutdown) ──────────────────────
let emailConsumer = null;
let whatsappConsumer = null;

// ─── Boot Sequence ──────────────────────────────────────────────────────────

connectDB();

const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, async () => {
  logger.info("Server", `Mailora server v2.0.0 running on port ${PORT}`);

  // ─── Kafka Setup ────────────────────────────────────────────
  try {
    await ensureTopics([
      TOPICS.EMAIL_CLASSIFICATION,
      TOPICS.EMAIL_CLASSIFICATION_DLQ,
      TOPICS.WHATSAPP_MESSAGES,
      TOPICS.WHATSAPP_MESSAGES_DLQ,
    ]);

    emailConsumer = await startEmailClassificationConsumer();
    whatsappConsumer = await startWhatsAppMessageConsumer();

    logger.info("Kafka", "All Kafka consumers are running");
  } catch (kafkaErr) {
    logger.error("Kafka", "Kafka setup failed — server running WITHOUT Kafka", kafkaErr);
  }

  // Start the WhatsApp reminder cron (checks every 5 minutes)
  startReminderScheduler();
});

// ─── Graceful Shutdown ──────────────────────────────────────────────────────

/**
 * Gracefully shut down all connections and resources.
 * Triggered by SIGTERM (Docker/K8s) or SIGINT (Ctrl+C).
 *
 * Shutdown order:
 *   1. Stop accepting new HTTP connections
 *   2. Disconnect Kafka consumers (stop processing messages)
 *   3. Disconnect Kafka producer
 *   4. Close MongoDB connection
 *   5. Exit process
 */
async function gracefulShutdown(signal) {
  logger.info("Server", `${signal} received — starting graceful shutdown...`);

  // 1. Stop accepting new connections
  server.close(() => {
    logger.info("Server", "HTTP server closed");
  });

  try {
    // 2. Disconnect Kafka consumers
    if (emailConsumer) {
      await emailConsumer.disconnect();
      logger.info("Kafka", "Email classification consumer disconnected");
    }
    if (whatsappConsumer) {
      await whatsappConsumer.disconnect();
      logger.info("Kafka", "WhatsApp message consumer disconnected");
    }

    // 3. Disconnect Kafka producer
    await disconnectKafka();
    logger.info("Kafka", "Producer disconnected");

    // 4. Close MongoDB
    await mongoose.connection.close();
    logger.info("MongoDB", "Connection closed");

    logger.info("Server", "Graceful shutdown complete");
    process.exit(0);
  } catch (err) {
    logger.error("Server", "Error during shutdown", err);
    process.exit(1);
  }
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));