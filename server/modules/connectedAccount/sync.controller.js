// modules/connectedAccount/sync.controller.js
// On-demand Gmail sync — polls Gmail API directly instead of relying on Pub/Sub webhooks.
// This is essential for local development where Google can't reach localhost.

const ConnectedAccount = require("./connectedAccount.model");
const RegistrationEmail = require("../email/registration.model");
const RegisteredEmail = require("../email/registered.model");
const InProgressEmail = require("../email/inprogress.model");
const ConfirmedEmail = require("../email/confirmed.model");
const { refreshGoogleTokenIfNeeded, getGmailClient } = require("../../services/google.service");
const { encrypt } = require("../../utils/crypto");
const { classifyEmail } = require("../../services/emailAI.service");
const { createReminders } = require("../../services/reminderCreator.service");

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;
const VALID_CATEGORIES = ["job", "internship", "hackathon", "workshop"];

function getModelForStage(stage) {
  if (stage === "registration") return RegistrationEmail;
  if (stage === "registered") return RegisteredEmail;
  if (stage === "inprogress") return InProgressEmail;
  if (stage === "confirmed") return ConfirmedEmail;
  return null;
}

/**
 * Extract body text from MIME parts (same as webhook controller)
 */
function extractBody(payload, snippet = "") {
  if (!payload) return snippet;
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }
  if (!payload.parts || payload.parts.length === 0) return snippet;

  function collectParts(parts) {
    const flat = [];
    for (const part of parts) {
      if (part.parts) flat.push(...collectParts(part.parts));
      else flat.push(part);
    }
    return flat;
  }

  const allParts = collectParts(payload.parts);
  const plainPart = allParts.find(p => p.mimeType === "text/plain" && p.body?.data);
  if (plainPart) return Buffer.from(plainPart.body.data, "base64url").toString("utf8");
  const htmlPart = allParts.find(p => p.mimeType === "text/html" && p.body?.data);
  if (htmlPart) return Buffer.from(htmlPart.body.data, "base64url").toString("utf8");
  const anyPart = allParts.find(p => p.body?.data);
  if (anyPart) return Buffer.from(anyPart.body.data, "base64url").toString("utf8");
  return snippet;
}

/**
 * POST /api/accounts/:id/sync
 * Manually sync emails from a connected Gmail account.
 * Fetches recent inbox messages and processes them through the AI classifier.
 */
exports.syncAccount = async (req, res) => {
  try {
    const account = await ConnectedAccount.findOne({
      _id: req.params.id,
      userId: req.user._id,
      isActive: true,
    });

    if (!account) {
      return res.status(404).json({ message: "Connected account not found" });
    }

    console.log(`🔄 Manual sync started for: ${account.emailAddress}`);

    const oauthClient = await refreshGoogleTokenIfNeeded(account);
    const gmail = getGmailClient(oauthClient);

    let processedCount = 0;
    let skippedCount = 0;

    // Strategy: Use history API if we have a lastHistoryId, else fetch recent messages
    if (account.lastHistoryId) {
      // Try history-based sync first
      try {
        const historyResponse = await gmail.users.history.list({
          userId: "me",
          startHistoryId: account.lastHistoryId,
          historyTypes: ["messageAdded"],
        });

        if (historyResponse.data.history) {
          for (const record of historyResponse.data.history) {
            if (!record.messagesAdded) continue;
            for (const msgObj of record.messagesAdded) {
              const msg = msgObj.message;
              if (!msg.labelIds || !msg.labelIds.includes("INBOX")) continue;
              const result = await processMessage(gmail, msg.id, account);
              if (result === "stored") processedCount++;
              else skippedCount++;
            }
          }
        }

        // Update historyId
        if (historyResponse.data.historyId) {
          account.lastHistoryId = historyResponse.data.historyId;
          await account.save();
        }
      } catch (histErr) {
        // If historyId is too old, fall back to listing recent messages
        if (histErr.code === 404 || histErr.message?.includes("historyId")) {
          console.log("⚠️ History expired, falling back to recent messages");
          const result = await syncRecentMessages(gmail, account);
          processedCount = result.processed;
          skippedCount = result.skipped;
        } else {
          throw histErr;
        }
      }
    } else {
      // No history ID — fetch recent messages
      const result = await syncRecentMessages(gmail, account);
      processedCount = result.processed;
      skippedCount = result.skipped;
    }

    console.log(`✅ Sync complete: ${processedCount} processed, ${skippedCount} skipped`);

    res.json({
      message: "Sync complete",
      processed: processedCount,
      skipped: skippedCount,
      email: account.emailAddress,
    });
  } catch (err) {
    console.error("❌ Manual sync error:", err);
    res.status(500).json({ message: "Sync failed: " + (err.message || "Unknown error") });
  }
};

/**
 * Fetch the 20 most recent INBOX messages and process them
 */
async function syncRecentMessages(gmail, account) {
  let processed = 0;
  let skipped = 0;

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults: 20,
  });

  if (!listResponse.data.messages) {
    return { processed: 0, skipped: 0 };
  }

  for (const msg of listResponse.data.messages) {
    const result = await processMessage(gmail, msg.id, account);
    if (result === "stored") processed++;
    else skipped++;
  }

  // Update history ID from the profile
  const profile = await gmail.users.getProfile({ userId: "me" });
  account.lastHistoryId = profile.data.historyId;
  await account.save();

  return { processed, skipped };
}

/**
 * Process a single Gmail message: classify + store
 */
async function processMessage(gmail, messageId, account) {
  try {
    const fullMessage = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
    });

    const headers = fullMessage.data.payload.headers;
    const subject = headers.find(h => h.name === "Subject")?.value || "";
    const from = headers.find(h => h.name === "From")?.value || "";
    const snippet = fullMessage.data.snippet || "";
    const emailBody = extractBody(fullMessage.data.payload, snippet);

    // AI Classification
    const aiResult = await classifyEmail(subject, snippet);
    const { category, stage, deadline, matter, links } = aiResult;

    console.log(`🤖 [${category}/${stage}]: ${subject.substring(0, 60)}`);

    if (!VALID_CATEGORIES.includes(category)) return "skipped";

    const Model = getModelForStage(stage);
    if (!Model) return "skipped";

    const expiresAt = new Date(Date.now() + THREE_MONTHS_MS);

    const baseDoc = {
      userId: account.userId,
      connectedAccountId: account._id,
      provider: "google",
      providerMessageId: messageId,
      subject: encrypt(subject),
      from: encrypt(from),
      snippet: encrypt(snippet),
      body: encrypt(emailBody),
      matter: matter ? encrypt(matter) : encrypt(""),
      links: Array.isArray(links) ? links.map(l => encrypt(l)) : [],
      receivedAt: new Date(parseInt(fullMessage.data.internalDate)),
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

      // Schedule WhatsApp reminders for this deadline
      try {
        await createReminders({
          userId: account.userId,
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
      // InProgress emails (interviews, assessments) also get deadlines
      let deadlineDate = deadline ? new Date(deadline) : null;
      if (!deadlineDate || isNaN(deadlineDate.getTime())) {
        deadlineDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
      }
      const savedEmail = await InProgressEmail.create({ ...baseDoc, deadlineDate });

      try {
        await createReminders({
          userId: account.userId,
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

    return "stored";
  } catch (err) {
    if (err.code === 11000) {
      return "duplicate";
    }
    console.error("❌ Process message error:", err.message);
    return "error";
  }
}
