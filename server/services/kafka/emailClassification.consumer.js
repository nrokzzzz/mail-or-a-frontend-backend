/**
 * Email Classification Consumer
 *
 * Consumes messages from the `email-classification` Kafka topic.
 * For each message:
 *   1. Calls Gemini AI to classify the email
 *   2. Stores the classified email in the correct MongoDB collection
 *   3. Creates WhatsApp reminders if the email has a deadline
 *   4. On failure: retries with exponential backoff, then sends to DLQ
 */

const { createConsumer, TOPICS } = require("../../config/kafka");
const { classifyEmail } = require("../emailAI.service");
const { createReminders } = require("../reminderCreator.service");
const { encrypt } = require("../../utils/crypto");
const { sendToDLQ } = require("./dlq.handler");

// Models
const RegistrationEmail = require("../../modules/email/registration.model");
const RegisteredEmail = require("../../modules/email/registered.model");
const InProgressEmail = require("../../modules/email/inprogress.model");
const ConfirmedEmail = require("../../modules/email/confirmed.model");

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
const VALID_CATEGORIES = ["job", "internship", "hackathon", "workshop"];
const MAX_RETRIES = 5;
const BASE_BACKOFF_MS = 1000; // 1s, 2s, 4s, 8s, 16s

function getModelForStage(stage) {
  if (stage === "registration") return RegistrationEmail;
  if (stage === "registered") return RegisteredEmail;
  if (stage === "inprogress") return InProgressEmail;
  if (stage === "confirmed") return ConfirmedEmail;
  return null;
}

/**
 * Process a single email classification message with retry logic.
 */
async function processEmailMessage(messagePayload) {
  const {
    userId,
    connectedAccountId,
    provider,
    messageId,
    subject,
    from,
    snippet,
    body,
    internalDate,
  } = messagePayload;

  let retryCount = messagePayload.retryCount || 0;

  while (retryCount <= MAX_RETRIES) {
    try {
      // ─── Step 1: AI Classification ──────────────────────────────
      const aiResult = await classifyEmail(subject, snippet);
      const { category, stage, deadline, matter, links } = aiResult;

      console.log(`🤖 [Kafka Consumer] Classified [${category}/${stage}]: ${subject?.substring(0, 60)}`);

      // Skip non-tracked categories
      if (!VALID_CATEGORIES.includes(category)) {
        console.log(`⏭️  Skipped — category: ${category}`);
        return; // Successfully processed (just not stored)
      }

      // Skip unknown stages
      const Model = getModelForStage(stage);
      if (!Model) {
        console.log(`⏭️  Skipped — stage: ${stage}`);
        return;
      }

      // ─── Step 2: Store in MongoDB ───────────────────────────────
      const expiresAt = new Date(Date.now() + THREE_MONTHS_MS);

      const baseDoc = {
        userId,
        connectedAccountId,
        provider,
        providerMessageId: messageId,
        subject: encrypt(subject),
        from: encrypt(from),
        snippet: encrypt(snippet),
        body: encrypt(body),
        matter: matter ? encrypt(matter) : encrypt(""),
        links: Array.isArray(links) ? links.map((l) => encrypt(l)) : [],
        receivedAt: new Date(parseInt(internalDate)),
        category,
        aiProcessed: true,
        expiresAt,
      };

      if (stage === "registration") {
        let deadlineDate = deadline ? new Date(deadline) : null;
        if (!deadlineDate || isNaN(deadlineDate.getTime())) {
          deadlineDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
        }
        const savedEmail = await RegistrationEmail.create({ ...baseDoc, deadlineDate });

        // ─── Step 3: Create WhatsApp Reminders ──────────────────
        try {
          await createReminders({
            userId,
            emailId: savedEmail._id,
            emailModel: "RegistrationEmail",
            emailSubject: subject,
            emailCategory: category,
            emailMatter: matter || "",
            deadlineDate,
          });
        } catch (reminderErr) {
          console.error("⚠️ Reminder creation failed (non-blocking):", reminderErr.message);
        }
      } else if (stage === "inprogress") {
        let deadlineDate = deadline ? new Date(deadline) : null;
        if (!deadlineDate || isNaN(deadlineDate.getTime())) {
          deadlineDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
        }
        const savedEmail = await InProgressEmail.create({ ...baseDoc, deadlineDate });

        try {
          await createReminders({
            userId,
            emailId: savedEmail._id,
            emailModel: "InProgressEmail",
            emailSubject: subject,
            emailCategory: category,
            emailMatter: matter || "",
            deadlineDate,
          });
        } catch (reminderErr) {
          console.error("⚠️ Reminder creation failed (non-blocking):", reminderErr.message);
        }
      } else {
        await Model.create(baseDoc);
      }

      console.log(`✅ [Kafka Consumer] Stored [${category}/${stage}]: ${subject?.substring(0, 60)}`);
      return; // Success — exit retry loop

    } catch (err) {
      retryCount++;

      if (err.code === 11000) {
        // Duplicate email — not an error, just skip
        console.log(`⚠️ [Kafka Consumer] Duplicate skipped: ${messageId}`);
        return;
      }

      if (retryCount > MAX_RETRIES) {
        console.error(
          `💀 [Kafka Consumer] Max retries (${MAX_RETRIES}) exceeded for: ${subject?.substring(0, 50)}`
        );
        await sendToDLQ(
          TOPICS.EMAIL_CLASSIFICATION,
          messagePayload,
          err.message,
          retryCount - 1
        );
        return;
      }

      // Exponential backoff
      const backoffMs = BASE_BACKOFF_MS * Math.pow(2, retryCount - 1);
      console.warn(
        `🔄 [Kafka Consumer] Retry ${retryCount}/${MAX_RETRIES} in ${backoffMs}ms — ${err.message}`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    }
  }
}

/**
 * Start the email classification Kafka consumer.
 */
async function startEmailClassificationConsumer() {
  const consumer = createConsumer("email-classification-group");

  await consumer.connect();
  await consumer.subscribe({
    topic: TOPICS.EMAIL_CLASSIFICATION,
    fromBeginning: false,
  });

  console.log("📡 [Kafka] Email classification consumer started");

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      try {
        const payload = JSON.parse(message.value.toString());
        await processEmailMessage(payload);
      } catch (err) {
        console.error("❌ [Kafka Consumer] Message parse/process error:", err.message);
      }
    },
  });

  return consumer;
}

module.exports = { startEmailClassificationConsumer };
