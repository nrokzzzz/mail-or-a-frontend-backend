// modules/connectedAccount/sync.controller.js
//
// On-demand Gmail sync — polls Gmail API directly instead of relying on Pub/Sub webhooks.
// Refactored to use Kafka for fault-tolerant email classification.
// Raw email data is published to the `email-classification` Kafka topic.

const ConnectedAccount = require("./connectedAccount.model");
const { refreshGoogleTokenIfNeeded, getGmailClient } = require("../../services/google.service");
const { extractBody } = require("../../utils/emailParser");
const { produceEmailForClassification } = require("../../services/kafka/emailClassification.producer");

/**
 * POST /api/accounts/:id/sync
 * Manually sync emails from a connected Gmail account.
 * Fetches recent inbox messages and publishes them to Kafka for classification.
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

    let queuedCount = 0;
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
              if (result === "queued") queuedCount++;
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
          queuedCount = result.queued;
          skippedCount = result.skipped;
        } else {
          throw histErr;
        }
      }
    } else {
      // No history ID — fetch recent messages
      const result = await syncRecentMessages(gmail, account);
      queuedCount = result.queued;
      skippedCount = result.skipped;
    }

    console.log(`✅ Sync complete: ${queuedCount} queued to Kafka, ${skippedCount} skipped`);

    res.json({
      message: "Sync complete — emails queued for AI classification",
      queued: queuedCount,
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
  let queued = 0;
  let skipped = 0;

  const listResponse = await gmail.users.messages.list({
    userId: "me",
    labelIds: ["INBOX"],
    maxResults: 20,
  });

  if (!listResponse.data.messages) {
    return { queued: 0, skipped: 0 };
  }

  for (const msg of listResponse.data.messages) {
    const result = await processMessage(gmail, msg.id, account);
    if (result === "queued") queued++;
    else skipped++;
  }

  // Update history ID from the profile
  const profile = await gmail.users.getProfile({ userId: "me" });
  account.lastHistoryId = profile.data.historyId;
  await account.save();

  return { queued, skipped };
}

/**
 * Process a single Gmail message: extract data and publish to Kafka for classification.
 * Classification, storage, and reminder creation happen in the Kafka consumer.
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

    // ─── Publish to Kafka for async classification ─────────────
    await produceEmailForClassification({
      userId: account.userId.toString(),
      connectedAccountId: account._id.toString(),
      provider: "google",
      messageId,
      subject,
      from,
      snippet,
      body: emailBody,
      internalDate: fullMessage.data.internalDate,
    });

    console.log(`📡 [Sync] Queued for classification: ${subject.substring(0, 60)}`);
    return "queued";

  } catch (err) {
    console.error("❌ Process message error:", err.message);
    return "error";
  }
}
