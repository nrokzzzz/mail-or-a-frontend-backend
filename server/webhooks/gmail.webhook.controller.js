// webhooks/gmail.webhook.controller.js

const ConnectedAccount = require("../modules/connectedAccount/connectedAccount.model");
const RegistrationEmail = require("../modules/email/registration.model");
const RegisteredEmail = require("../modules/email/registered.model");
const InProgressEmail = require("../modules/email/inprogress.model");
const ConfirmedEmail = require("../modules/email/confirmed.model");
const { refreshGoogleTokenIfNeeded, getGmailClient } = require("../services/google.service");
const { encrypt } = require("../utils/crypto");
const { classifyEmail } = require("../services/emailAI.service");
const { createReminders } = require("../services/reminderCreator.service");

const THREE_MONTHS_MS = 90 * 24 * 60 * 60 * 1000;

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

const VALID_CATEGORIES = ["job", "internship", "hackathon", "workshop"];

/**
 * Route stage → correct model
 */
function getModelForStage(stage) {
  if (stage === "registration") return RegistrationEmail;
  if (stage === "registered") return RegisteredEmail;
  if (stage === "inprogress") return InProgressEmail;
  if (stage === "confirmed") return ConfirmedEmail;
  return null; // "other" stage — skip
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

          // Extract full body — recursive MIME traversal
          const emailBody = extractBody(fullMessage.data.payload, snippet);

          // 1️⃣ Classify FIRST — determines category + stage
          const aiResult = await classifyEmail(subject, snippet);
          const { category, stage, deadline, matter, links } = aiResult;

          console.log(`🤖 Classified as: [${category}] stage: [${stage}]`);

          // Skip if category is "other" (not a tracked opportunity type)
          if (!VALID_CATEGORIES.includes(category)) {
            console.log(`⏭️ Skipping — category: ${category}`);
            continue;
          }

          // Skip if stage is "other" (no meaningful action)
          const Model = getModelForStage(stage);
          if (!Model) {
            console.log(`⏭️ Skipping — stage: ${stage}`);
            continue;
          }

          const expiresAt = new Date(Date.now() + THREE_MONTHS_MS);

          const baseDoc = {
            userId: account.userId,
            connectedAccountId: account._id,
            provider: "google",
            providerMessageId: msg.id,
            subject: encrypt(subject),
            from: encrypt(from),
            snippet: encrypt(snippet),
            body: encrypt(emailBody),   // full body, encrypted
            matter: matter ? encrypt(matter) : encrypt(""),
            links: Array.isArray(links) ? links.map(l => encrypt(l)) : [],
            receivedAt: new Date(parseInt(fullMessage.data.internalDate)),
            category,                                 // job | internship | hackathon | workshop
            aiProcessed: true,
            expiresAt,
          };

          // 2️⃣ Store in the correct stage schema
          if (stage === "registration") {
            let deadlineDate = deadline ? new Date(deadline) : null;
            if (!deadlineDate || isNaN(deadlineDate.getTime())) {
              deadlineDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
            }
            const savedEmail = await RegistrationEmail.create({ ...baseDoc, deadlineDate });

            // Schedule WhatsApp reminders
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

          console.log(`✅ Stored [${category} / ${stage}]:`, subject);

        } catch (err) {
          if (err.code === 11000) {
            console.log("⚠️ Duplicate skipped:", msg.id);
          } else {
            console.error("❌ Email processing error:", err.message);
          }
        }
      }
    }

    account.lastHistoryId = newHistoryId;
    await account.save();

  } catch (error) {
    console.error("❌ fetchNewEmails error:", error);
  }
}
