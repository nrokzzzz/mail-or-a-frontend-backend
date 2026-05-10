/**
 * WhatsApp Message Consumer
 *
 * Consumes messages from the `whatsapp-messages` Kafka topic.
 * For each message:
 *   1. Sends the WhatsApp message via the WhatsApp microservice HTTP API
 *   2. Updates the Reminder document status in MongoDB
 *   3. On failure: retries with exponential backoff, then sends to DLQ
 */

const axios = require("axios");
const { createConsumer, TOPICS } = require("../../config/kafka");
const { sendToDLQ } = require("./dlq.handler");
const Reminder = require("../../modules/remainder/reminder.model");

const WHATSAPP_SERVICE_URL = process.env.WHATSAPP_SERVICE_URL || "https://whatsapp.mail-or-a.dev";
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000; // 1s, 2s, 4s, 8s, 16s

/**
 * Process a single WhatsApp message with retry logic.
 */
async function processWhatsAppMessage(messagePayload) {
  const {
    reminderId,
    userId,
    whatsappNumber,
    message,
    reminderType,
    userName,
  } = messagePayload;

  let retryCount = messagePayload.retryCount || 0;

  while (retryCount <= MAX_RETRIES) {
    try {
      // ─── Send via WhatsApp Service ──────────────────────────────
      const response = await axios.post(
        `${WHATSAPP_SERVICE_URL}/api/send`,
        { number: whatsappNumber, message },
        { timeout: 15000 }
      );

      if (response.data.success) {
        // ─── Update Reminder Status → sent ──────────────────────
        await Reminder.findByIdAndUpdate(reminderId, {
          status: "sent",
          sentAt: new Date(),
        });

        console.log(
          `✅ [Kafka Consumer] WhatsApp sent [${reminderType}] to ${userName} (${whatsappNumber})`
        );
        return; // Success
      } else {
        // API returned success: false — treat as a retryable error
        throw new Error(response.data.error || "WhatsApp service returned failure");
      }
    } catch (err) {
      retryCount++;

      if (retryCount > MAX_RETRIES) {
        console.error(
          `💀 [Kafka Consumer] Max retries (${MAX_RETRIES}) for WhatsApp [${reminderType}] to ${userName}`
        );

        // Update reminder status to failed
        try {
          await Reminder.findByIdAndUpdate(reminderId, {
            status: "failed",
            failReason: `Kafka DLQ after ${MAX_RETRIES} retries: ${err.message}`,
          });
        } catch (dbErr) {
          console.error("❌ Failed to update reminder status:", dbErr.message);
        }

        // Send to DLQ
        await sendToDLQ(
          TOPICS.WHATSAPP_MESSAGES,
          messagePayload,
          err.message,
          retryCount - 1
        );
        return;
      }

      // Exponential backoff
      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount - 1);
      console.warn(
        `🔄 [Kafka Consumer] WhatsApp retry ${retryCount}/${MAX_RETRIES} in ${backoffMs}ms — ${err.message}`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

/**
 * Start the WhatsApp message Kafka consumer.
 */
async function startWhatsAppMessageConsumer() {
  const consumer = createConsumer("whatsapp-messages-group");

  await consumer.connect();
  await consumer.subscribe({
    topic: TOPICS.WHATSAPP_MESSAGES,
    fromBeginning: false,
  });

  console.log("📡 [Kafka] WhatsApp message consumer started");

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const payload = JSON.parse(message.value.toString());
        await processWhatsAppMessage(payload);
      } catch (err) {
        console.error("❌ [Kafka Consumer] WhatsApp message parse/process error:", err.message);
      }
    },
  });

  return consumer;
}

module.exports = { startWhatsAppMessageConsumer };
