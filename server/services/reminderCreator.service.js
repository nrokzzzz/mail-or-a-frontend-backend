/**
 * Reminder Creator Service
 *
 * Called after an email with a deadline is classified and stored.
 * Creates multiple Reminder documents in MongoDB based on the rules:
 *
 * RULE 1 — deadline < 3 days away:
 *   • Remind immediately
 *   • Remind 12 hours before deadline
 *   • Remind 1 hour before deadline
 *
 * RULE 2 — deadline >= 3 days away:
 *   • Remind 3 days before deadline
 *   • Remind 24 hours after first reminder (i.e., 2 days before)
 *   • Remind 12 hours before deadline
 *   • Remind 1 hour before deadline
 */

const Reminder = require("../modules/remainder/reminder.model");

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * Create reminder entries for an email with a deadline.
 *
 * @param {Object} params
 * @param {string} params.userId        - User's ObjectId
 * @param {string} params.emailId       - Stored email's ObjectId
 * @param {string} params.emailModel    - "RegistrationEmail" or "InProgressEmail"
 * @param {string} params.emailSubject  - Plaintext subject (already decrypted by caller)
 * @param {string} params.emailCategory - "job", "internship", etc.
 * @param {string} params.emailMatter   - Plaintext summary
 * @param {Date}   params.deadlineDate  - The email's deadline
 */
async function createReminders({
  userId,
  emailId,
  emailModel,
  emailSubject,
  emailCategory,
  emailMatter,
  deadlineDate,
}) {
  const now = new Date();
  const deadline = new Date(deadlineDate);
  const timeUntilDeadline = deadline.getTime() - now.getTime();

  // If deadline is already past, skip
  if (timeUntilDeadline <= 0) {
    console.log(`⏭️  Skipping reminders — deadline already passed for: ${emailSubject}`);
    return;
  }

  const threeDaysMs = 3 * DAY_MS;
  const remindersToCreate = [];

  const baseDoc = {
    userId,
    emailId,
    emailModel,
    emailSubject,
    emailCategory,
    emailMatter,
    deadlineDate: deadline,
  };

  if (timeUntilDeadline < threeDaysMs) {
    // ──────────────────────────────────────────────────────────
    // RULE 1: Deadline < 3 days away
    // ──────────────────────────────────────────────────────────

    // 1) Remind immediately
    remindersToCreate.push({
      ...baseDoc,
      scheduledAt: now,
      reminderType: "immediate",
    });

    // 2) Remind 12 hours before deadline
    const twelveHrsBefore = new Date(deadline.getTime() - 12 * HOUR_MS);
    if (twelveHrsBefore > now) {
      remindersToCreate.push({
        ...baseDoc,
        scheduledAt: twelveHrsBefore,
        reminderType: "12hrs",
      });
    }

    // 3) Remind 1 hour before deadline
    const oneHrBefore = new Date(deadline.getTime() - 1 * HOUR_MS);
    if (oneHrBefore > now) {
      remindersToCreate.push({
        ...baseDoc,
        scheduledAt: oneHrBefore,
        reminderType: "1hr",
      });
    }
  } else {
    // ──────────────────────────────────────────────────────────
    // RULE 2: Deadline >= 3 days away
    // ──────────────────────────────────────────────────────────

    // 1) Remind 3 days before deadline
    const threeDaysBefore = new Date(deadline.getTime() - 3 * DAY_MS);
    remindersToCreate.push({
      ...baseDoc,
      scheduledAt: threeDaysBefore > now ? threeDaysBefore : now,
      reminderType: "3days",
    });

    // 2) Remind 24 hours after first reminder (= 2 days before deadline)
    const twoDaysBefore = new Date(deadline.getTime() - 2 * DAY_MS);
    if (twoDaysBefore > now) {
      remindersToCreate.push({
        ...baseDoc,
        scheduledAt: twoDaysBefore,
        reminderType: "24hrs",
      });
    }

    // 3) Remind 12 hours before deadline
    const twelveHrsBefore = new Date(deadline.getTime() - 12 * HOUR_MS);
    if (twelveHrsBefore > now) {
      remindersToCreate.push({
        ...baseDoc,
        scheduledAt: twelveHrsBefore,
        reminderType: "12hrs",
      });
    }

    // 4) Remind 1 hour before deadline
    const oneHrBefore = new Date(deadline.getTime() - 1 * HOUR_MS);
    if (oneHrBefore > now) {
      remindersToCreate.push({
        ...baseDoc,
        scheduledAt: oneHrBefore,
        reminderType: "1hr",
      });
    }
  }

  // Bulk insert, skip duplicates (same emailId + reminderType)
  let created = 0;
  for (const doc of remindersToCreate) {
    try {
      await Reminder.create(doc);
      created++;
    } catch (err) {
      if (err.code === 11000) {
        // Duplicate — already scheduled, skip silently
        continue;
      }
      console.error(`❌ Failed to create reminder [${doc.reminderType}]:`, err.message);
    }
  }

  if (created > 0) {
    console.log(`🔔 Created ${created} reminder(s) for: "${emailSubject}" (deadline: ${deadline.toISOString()})`);
  }
}

module.exports = { createReminders };
