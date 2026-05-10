// webhooks/gmail.webhook.controller.js
//
// Refactored to use Kafka for fault-tolerant email classification.
// Instead of calling Gemini AI inline, raw email data is published
// to the `email-classification` Kafka topic. The Kafka consumer
// handles classification, storage, and reminder creation with retries.

const ConnectedAccount = require("../modules/connectedAccount/connectedAccount.model");
const { refreshGoogleTokenIfNeeded, getGmailClient } = require("../services/google.service");
const { produceEmailForClassification } = require("../services/kafka/emailClassification.producer");

/**
 * Recursively walk MIME parts and extract the full body text.
 * Priority: text/plain → text/html → first part with data
 * Falls back to snippet if nothing is found.
 */
function extractBody(payload, snippet = "") {
  if (!payload) return snippet;

  // Direct body (simple non-multipart message)
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, "base64url").toString("utf8");
  }

  if (!payload.parts || payload.parts.length === 0) return snippet;

  // Recursively collect all parts into a flat list
  function collectParts(parts) {
    const flat = [];
    for (const part of parts) {
      if (part.parts) {
        flat.push(...collectParts(part.parts));
      } else {
        flat.push(part);
      }
    }
    return flat;
  }

  const allParts = collectParts(payload.parts);

  // Prefer plain text
  const plainPart = allParts.find((p) => p.mimeType === "text/plain" && p.body?.data);
  if (plainPart) {
    return Buffer.from(plainPart.body.data, "base64url").toString("utf8");
  }

  // Fall back to HTML
  const htmlPart = allParts.find((p) => p.mimeType === "text/html" && p.body?.data);
  if (htmlPart) {
    return Buffer.from(htmlPart.body.data, "base64url").toString("utf8");
  }

  // Last resort: first part with any data
  const anyPart = allParts.find((p) => p.body?.data);
  if (anyPart) {
    return Buffer.from(anyPart.body.data, "base64url").toString("utf8");
  }

  return snippet;
}

/**
 * Main webhook handler
 */
exports.handleGmailWebhook = async (req, res) => {
  try {
    console.log("📩 Gmail webhook received");

    if (process.env.WEBHOOK_SECRET && req.query.token !== process.env.WEBHOOK_SECRET) {
      console.log("❌ Unauthorized webhook access");
      return res.sendStatus(403);
    }

    const message = req.body.message;

    if (!message || !message.data) {
      return res.sendStatus(200);
    }

    // Decode Pub/Sub message
    const decodedData = JSON.parse(
      Buffer.from(message.data, "base64").toString("utf-8")
    );

    const { emailAddress, historyId } = decodedData;

    console.log("Email:", emailAddress);
    console.log("New HistoryId:", historyId);

    const account = await ConnectedAccount.findOne({
      emailAddress,
      provider: "google",
      isActive: true,
    });

    if (!account) {
      console.log("❌ No connected account found");
      return res.sendStatus(200);
    }

    await fetchNewEmails(account, historyId);

    res.sendStatus(200);
  } catch (error) {
    console.error("❌ Gmail webhook error:", error);
    res.sendStatus(200); // always 200 for Pub/Sub
  }
};

/**
 * Fetch new emails using Gmail History API
 * Now publishes to Kafka instead of inline classification.
 */
async function fetchNewEmails(account, newHistoryId) {
  try {
    // Guard: lastHistoryId must exist — set during watch() in google.controller.js
    if (!account.lastHistoryId) {
      console.warn("⚠️ No lastHistoryId on account, skipping history fetch");
      account.lastHistoryId = newHistoryId;
      await account.save();
      return;
    }

    const oauthClient = await refreshGoogleTokenIfNeeded(account);
    const gmail = getGmailClient(oauthClient);

    const historyResponse = await gmail.users.history.list({
      userId: "me",
      startHistoryId: account.lastHistoryId,
    });

    if (!historyResponse.data.history) {
      account.lastHistoryId = newHistoryId;
      await account.save();
      return;
    }

    for (const record of historyResponse.data.history) {
      if (!record.messagesAdded) continue;

      for (const msgObj of record.messagesAdded) {
        const msg = msgObj.message;

        // Only process INBOX messages
        if (!msg.labelIds || !msg.labelIds.includes("INBOX")) continue;

        try {
          const fullMessage = await gmail.users.messages.get({
            userId: "me",
            id: msg.id,
          });

          const headers = fullMessage.data.payload.headers;
          const subject = headers.find((h) => h.name === "Subject")?.value || "";
          const from = headers.find((h) => h.name === "From")?.value || "";
          const snippet = fullMessage.data.snippet || "";
          const emailBody = extractBody(fullMessage.data.payload, snippet);

          // ─── Publish to Kafka for async classification ─────────
          await produceEmailForClassification({
            userId: account.userId.toString(),
            connectedAccountId: account._id.toString(),
            provider: "google",
            messageId: msg.id,
            subject,
            from,
            snippet,
            body: emailBody,
            internalDate: fullMessage.data.internalDate,
          });

          console.log(`📡 [Webhook] Queued for classification: ${subject.substring(0, 60)}`);

        } catch (err) {
          console.error("❌ Email queuing error:", err.message);
        }
      }
    }

    account.lastHistoryId = newHistoryId;
    await account.save();

  } catch (error) {
    console.error("❌ fetchNewEmails error:", error);
  }
}
