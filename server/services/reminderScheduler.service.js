/**
 * Reminder Scheduler Service
 *
 * Runs a cron job every 5 minutes that:
 * 1. Finds all Reminder documents where scheduledAt <= now AND status === "pending"
 * 2. Looks up the user's verified WhatsApp number
 * 3. Sends a formatted WhatsApp message via the WhatsApp microservice
 * 4. Marks the reminder as "sent" or "failed"
 */

const cron = require("node-cron");
const axios = require("axios");
const Reminder = require("../modules/remainder/reminder.model");
const User = require("../modules/user/user.model");

const WHATSAPP_SERVICE_URL = process.env.WHATSAPP_SERVICE_URL || "https://whatsapp.mail-or-a.dev";

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
 * Process all due reminders
 */
async function processDueReminders() {
  const now = new Date();

  // Find all pending reminders that are due
  const dueReminders = await Reminder.find({
    status: "pending",
    scheduledAt: { $lte: now },
  }).limit(50); // Process max 50 at a time to avoid overwhelming WhatsApp

  if (dueReminders.length === 0) return;

  console.log(`\n🔔 [Reminder Scheduler] Processing ${dueReminders.length} due reminder(s)...`);

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

      // Send via WhatsApp service
      const response = await axios.post(
        `${WHATSAPP_SERVICE_URL}/api/send`,
        { number: whatsappNumber, message },
        { timeout: 15000 }
      );

      if (response.data.success) {
        reminder.status = "sent";
        reminder.sentAt = new Date();
        await reminder.save();
        console.log(`  ✅ Sent [${reminder.reminderType}] to ${user.name} (${whatsappNumber})`);
      } else {
        reminder.status = "failed";
        reminder.failReason = response.data.error || "WhatsApp send failed";
        await reminder.save();
        console.log(`  ❌ Failed [${reminder.reminderType}]: ${response.data.error}`);
      }
    } catch (err) {
      reminder.status = "failed";
      reminder.failReason = err.message;
      await reminder.save();
      console.error(`  ❌ Error [${reminder.reminderType}]:`, err.message);
    }

    // Small delay between messages to avoid rate-limiting
    await new Promise((r) => setTimeout(r, 1500));
  }
}

/**
 * Start the reminder scheduler cron job.
 * Runs every 5 minutes.
 */
function startReminderScheduler() {
  console.log("🔔 Reminder Scheduler started — checking every 5 minutes");

  // Run every 5 minutes
  cron.schedule("*/5 * * * *", async () => {
    try {
      await processDueReminders();
    } catch (err) {
      console.error("❌ [Reminder Scheduler] Cron error:", err.message);
    }
  });

  // Also run once on startup (after a 10-second delay to let DB connect)
  setTimeout(async () => {
    try {
      console.log("🔔 [Reminder Scheduler] Running initial check...");
      await processDueReminders();
    } catch (err) {
      console.error("❌ [Reminder Scheduler] Initial run error:", err.message);
    }
  }, 10000);
}

module.exports = { startReminderScheduler, processDueReminders };
