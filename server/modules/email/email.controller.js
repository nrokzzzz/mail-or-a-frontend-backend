/**
 * Email Controller
 *
 * Handles CRUD operations for classified emails across all 4 stage collections.
 * Uses a factory pattern to eliminate repetitive stage-specific handlers.
 * Supports pagination via ?page=N&limit=N query params (defaults: page=1, limit=20).
 */

const RegistrationEmail = require("./registration.model");
const RegisteredEmail   = require("./registered.model");
const InProgressEmail   = require("./inprogress.model");
const ConfirmedEmail    = require("./confirmed.model");
const Reminder          = require("../reminder/reminder.model");
const { decrypt }       = require("../../utils/crypto");
const logger            = require("../../utils/logger");

// ─── Model Registry ─────────────────────────────────────────────────────────
const MODELS = [
  { model: RegistrationEmail, type: "registration" },
  { model: RegisteredEmail,   type: "registered"   },
  { model: InProgressEmail,   type: "inprogress"   },
  { model: ConfirmedEmail,    type: "confirmed"     },
];

const MODEL_MAP = Object.fromEntries(MODELS.map((m) => [m.type, m]));

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Decrypt all encrypted fields on an email document.
 * @param {object} email - Mongoose document
 * @param {string} type  - Email stage type
 * @returns {object} Decrypted plain object
 */
function decryptEmail(email, type) {
  return {
    ...email._doc,
    type,
    subject: decrypt(email.subject),
    from:    decrypt(email.from),
    snippet: decrypt(email.snippet),
    body:    decrypt(email.body),
    matter:  email.matter ? decrypt(email.matter) : "",
    links:   Array.isArray(email.links) ? email.links.map(l => decrypt(l)) : [],
  };
}

/**
 * Parse pagination params from query string with sensible defaults.
 * @param {object} query - req.query
 * @returns {{ page: number, limit: number, skip: number }}
 */
function parsePagination(query) {
  const page  = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 20));
  const skip  = (page - 1) * limit;
  return { page, limit, skip };
}

// ─── Factory: Stage-Specific Email Handler ──────────────────────────────────

/**
 * Factory function that creates a handler for fetching emails by stage.
 * Eliminates the need for 4 nearly-identical exported functions.
 *
 * @param {string} type - One of "registration", "registered", "inprogress", "confirmed"
 * @returns {Function} Express route handler
 */
function getEmailsByStage(type) {
  const entry = MODEL_MAP[type];
  if (!entry) throw new Error(`Invalid email stage type: ${type}`);

  return async (req, res) => {
    try {
      const { page, limit, skip } = parsePagination(req.query);

      const [emails, total] = await Promise.all([
        entry.model
          .find({ userId: req.user._id })
          .sort({ receivedAt: -1 })
          .skip(skip)
          .limit(limit),
        entry.model.countDocuments({ userId: req.user._id }),
      ]);

      res.json({
        emails: emails.map((e) => decryptEmail(e, type)),
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (err) {
      logger.error("Email", `Error fetching ${type} emails`, err);
      res.status(500).json({ message: "Server error" });
    }
  };
}

// ─── Exported Handlers ──────────────────────────────────────────────────────

// GET /api/emails — all emails for the user across all categories
exports.getAllEmails = async (req, res) => {
  try {
    const { page, limit, skip } = parsePagination(req.query);

    const results = await Promise.all(
      MODELS.map(({ model, type }) =>
        model
          .find({ userId: req.user._id })
          .sort({ receivedAt: -1 })
          .then((docs) => docs.map((doc) => decryptEmail(doc, type)))
      )
    );

    const all = results
      .flat()
      .sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));

    // Apply pagination on the merged result
    const total = all.length;
    const paginated = all.slice(skip, skip + limit);

    res.json({
      emails: paginated,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    logger.error("Email", "Error fetching all emails", err);
    res.status(500).json({ message: "Server error" });
  }
};

// Stage-specific handlers — generated via factory
exports.getRegistrationEmails = getEmailsByStage("registration");
exports.getRegisteredEmails   = getEmailsByStage("registered");
exports.getInProgressEmails   = getEmailsByStage("inprogress");
exports.getConfirmedEmails    = getEmailsByStage("confirmed");

// DELETE /api/emails/:type/:id — delete a single email and its pending reminders
exports.deleteEmail = async (req, res) => {
  try {
    const { type, id } = req.params;

    const modelEntry = MODEL_MAP[type];
    if (!modelEntry) {
      return res.status(400).json({ message: `Invalid email type: ${type}` });
    }

    // Only allow deleting own emails
    const email = await modelEntry.model.findOne({ _id: id, userId: req.user._id });
    if (!email) {
      return res.status(404).json({ message: "Email not found" });
    }

    // Delete the email
    await modelEntry.model.deleteOne({ _id: id });

    // Also cancel any pending reminders linked to this email
    await Reminder.deleteMany({ emailId: id, status: "pending" });

    logger.info("Email", `Deleted ${type} email ${id} and associated reminders`);
    res.json({ success: true, message: "Email deleted successfully" });
  } catch (err) {
    logger.error("Email", "Error deleting email", err);
    res.status(500).json({ message: "Server error" });
  }
};
