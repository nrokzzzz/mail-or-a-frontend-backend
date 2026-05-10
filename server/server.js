require("dotenv").config();
const app = require("./app");
const connectDB = require("./config/db");
const { startReminderScheduler } = require("./services/reminderScheduler.service");
const { ensureTopics, TOPICS } = require("./config/kafka");
const { startEmailClassificationConsumer } = require("./services/kafka/emailClassification.consumer");
const { startWhatsAppMessageConsumer } = require("./services/kafka/whatsappMessage.consumer");

connectDB();

const PORT = process.env.PORT || 5000;

app.listen(PORT, async () => {
  console.log(`Server running on port ${PORT}`);

  // ─── Kafka Setup ────────────────────────────────────────────
  try {
    // Ensure all required Kafka topics exist
    await ensureTopics([
      TOPICS.EMAIL_CLASSIFICATION,
      TOPICS.EMAIL_CLASSIFICATION_DLQ,
      TOPICS.WHATSAPP_MESSAGES,
      TOPICS.WHATSAPP_MESSAGES_DLQ,
    ]);

    // Start Kafka consumers
    await startEmailClassificationConsumer();
    await startWhatsAppMessageConsumer();

    console.log("📡 All Kafka consumers are running");
  } catch (kafkaErr) {
    console.error("❌ Kafka setup failed:", kafkaErr.message);
    console.error("⚠️ Server is running WITHOUT Kafka — messages will fail to queue");
  }

  // Start the WhatsApp reminder cron (checks every 5 minutes)
  startReminderScheduler();
});