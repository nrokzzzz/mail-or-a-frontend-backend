/**
 * Reminder Scheduler Service
 *
 * Runs a cron job every 5 minutes that:
 * 1. Finds all Reminder documents where scheduledAt <= now AND status === "pending"
 * 2. Looks up the user's verified WhatsApp number
 * 3. Publishes a formatted WhatsApp message to Kafka `whatsapp-messages` topic
 * 4. The Kafka consumer handles actual delivery with retry + DLQ fallback
 *
 * Refactored: Direct HTTP calls to WhatsApp service replaced with Kafka producer.
 * This ensures failed messages are retried automatically and not lost.
 */

const cron = require("node-cron");
const Reminder = require("../modules/reminder/reminder.model");
const User = require("../modules/user/user.model");
const { produceWhatsAppMessage } = require("./kafka/whatsappMessage.producer");
const logger = require("../utils/logger");

/**
 * Format a WhatsApp reminder message
 */
function formatReminderMessage(reminder) {
  const deadline = new Date(reminder.deadlineDate);
  const now = new Date();
  const hoursLeft = Math.max(0, Math.round((deadline - now) / (60 * 60 * 1000)));
  const daysLeft = Math.floor(hoursLeft / 24);
  const remainingHours = hoursLeft % 24;

  let urgencyEmoji = "📋";
  let urgencyLabel = "";

  switch (reminder.reminderType) {
    case "immediate":
      urgencyEmoji = "🚨";
      urgencyLabel = "URGENT — Deadline approaching fast!";
      break;
    case "1hr":
      urgencyEmoji = "⏰";
      urgencyLabel = "FINAL REMINDER — Only ~1 hour left!";
      break;
    case "12hrs":
      urgencyEmoji = "⚠️";
      urgencyLabel = "Reminder — ~12 hours remaining";
      break;
    case "24hrs":
      urgencyEmoji = "📌";
      urgencyLabel = "Follow-up — ~2 days remaining";
      break;
    case "3days":
      urgencyEmoji = "🔔";
      urgencyLabel = "Heads-up — 3 days until deadline";
      break;
  }

  let timeLeftStr = "";
  if (daysLeft > 0) {
    timeLeftStr = `${daysLeft}d ${remainingHours}h`;
  } else {
    timeLeftStr = `${remainingHours}h`;
  }

  const categoryIcon = {
    job: "💼",
    internship: "🎓",
    hackathon: "🏆",
    workshop: "🛠️",
  }[reminder.emailCategory] || "📧";

  const lines = [
    `${urgencyEmoji} *Mail-or-a Deadline Reminder*`,
    ``,
    `${urgencyLabel}`,
    ``,
    `${categoryIcon} *Category:* ${(reminder.emailCategory || "").toUpperCase()}`,
    `📄 *Subject:* ${reminder.emailSubject}`,
    `⏳ *Deadline:* ${deadline.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}`,
    `⏱️ *Time Left:* ${timeLeftStr}`,
  ];

  if (reminder.emailMatter) {
    lines.push(``, `💡 *Summary:* ${reminder.emailMatter}`);
  }

  lines.push(
    ``,
    `—`,
    `_Open Mail-or-a to take action before it's too late!_`
  );

  return lines.join("\n");
}

/**
 * Process all due reminders — publish to Kafka instead of direct HTTP.
 */
async function processDueReminders() {
  const now = new Date();

  // Find all pending reminders that are due
  const dueReminders = await Reminder.find({
    status: "pending",
    scheduledAt: { $lte: now },
  }).limit(50); // Process max 50 at a time

  if (dueReminders.length === 0) return;

  logger.info("Scheduler", `Processing ${dueReminders.length} due reminder(s)...`);

  for (const reminder of dueReminders) {
    try {
      // Look up user's verified mobile number
      const user = await User.findById(reminder.userId).select(
        "name countryCode mobileNumber isMobileVerified reminderPreferences"
      );

      if (!user) {
        reminder.status = "skipped";
        reminder.failReason = "User not found";
        await reminder.save();
        continue;
      }

      // Check if WhatsApp reminders are enabled
      if (user.reminderPreferences && user.reminderPreferences.whatsapp === false) {
        reminder.status = "skipped";
        reminder.failReason = "User disabled WhatsApp reminders";
        await reminder.save();
        continue;
      }

      // Check if mobile is verified
      if (!user.isMobileVerified || !user.mobileNumber) {
        reminder.status = "skipped";
        reminder.failReason = "Mobile not verified";
        await reminder.save();
        continue;
      }

      // Build the WhatsApp number (strip the + from country code)
      const whatsappNumber = `${user.countryCode.replace("+", "")}${user.mobileNumber}`;

      // Build message
      const message = formatReminderMessage(reminder);

      // ─── Publish to Kafka instead of direct HTTP ──────────────
      await produceWhatsAppMessage({
        reminderId: reminder._id.toString(),
        userId: reminder.userId.toString(),
        whatsappNumber,
        message,
        reminderType: reminder.reminderType,
        userName: user.name,
      });

      // Mark as "queued" — the Kafka consumer will update to "sent" or "failed"
      reminder.status = "queued";
      await reminder.save();

      logger.info("Scheduler", `Queued [${reminder.reminderType}] for ${user.name} (${whatsappNumber})`);

    } catch (err) {
      reminder.status = "failed";
      reminder.failReason = `Kafka produce error: ${err.message}`;
      await reminder.save();
      logger.error("Scheduler", `Error [${reminder.reminderType}]`, err);
    }

    // Small delay between messages to avoid overwhelming Kafka
    await new Promise((r) => setTimeout(r, 500));
  }
}

/**
 * Start the reminder scheduler cron job.
 * Runs every 5 minutes.
 */
function startReminderScheduler() {
  logger.info("Scheduler", "Reminder Scheduler started — checking every 5 minutes (Kafka-backed)");

  // Run every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      await processDueReminders();
    } catch (err) {
      logger.error("Scheduler", "Cron error", err);
    }
  });

  // Also run once on startup (after a 10-second delay to let DB + Kafka connect)
  setTimeout(async () => {
    try {
      logger.info("Scheduler", "Running initial check...");
      await processDueReminders();
    } catch (err) {
      logger.error("Scheduler", "Initial run error", err);
    }
  }, 10000);
}

module.exports = { startReminderScheduler, processDueReminders };
