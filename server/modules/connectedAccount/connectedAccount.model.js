/**
 * Connected Account Model
 *
 * Stores OAuth tokens and metadata for connected email accounts (Gmail, Outlook).
 * Tokens are encrypted at rest using AES-256-CBC via Mongoose hooks.
 *
 * Security: accessToken and refreshToken are automatically encrypted before
 * saving to MongoDB and decrypted when read back into memory.
 */

const mongoose = require("mongoose");
const { encrypt, decrypt } = require("../../utils/crypto");

const connectedAccountSchema = new mongoose.Schema(
  {
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Provider is enum-based for multi-provider extensibility.
    // Currently: Google Gmail. Future: Microsoft Outlook via Graph API.
    provider: {
      type: String,
      enum: ["google", "microsoft"],
      required: true,
    },

    emailAddress: {
      type: String,
      required: true,
    },

    // Encrypted at rest via pre("save") hook
    accessToken: {
      type: String,
      required: true,
    },

    // Encrypted at rest via pre("save") hook
    refreshToken: {
      type: String,
      required: true,
    },

    tokenExpiry: {
      type: Date,
      required: true,
    },

    // Gmail specific
    lastHistoryId: {
      type: String,
    },

    // Outlook specific
    subscriptionId: {
      type: String,
    },

    subscriptionExpiry: {
      type: Date,
    },

    isActive: {
      type: Boolean,
      default: true,
    },

    // Internal flag to track whether tokens are already encrypted
    _tokensEncrypted: {
      type: Boolean,
      default: false,
      select: false,
    },
  },
  { timestamps: true }
);

// Prevent same email connected twice for same user
connectedAccountSchema.index(
  { userId: 1, emailAddress: 1 },
  { unique: true }
);

// ─── Encryption Hooks ───────────────────────────────────────────────────────

/**
 * Pre-save hook: encrypt accessToken and refreshToken before persisting.
 * Uses an internal flag to avoid double-encryption on repeated saves.
 */
connectedAccountSchema.pre("save", function (next) {
  // Only encrypt if tokens were modified and aren't already encrypted
  if (this.isModified("accessToken") && this.accessToken && !this.accessToken.includes(":")) {
    this.accessToken = encrypt(this.accessToken);
  }
  if (this.isModified("refreshToken") && this.refreshToken && !this.refreshToken.includes(":")) {
    this.refreshToken = encrypt(this.refreshToken);
  }
  this._tokensEncrypted = true;
  next();
});

/**
 * Post-init hook: decrypt tokens when a document is read from MongoDB.
 * This ensures tokens are usable in-memory without manual decryption.
 */
connectedAccountSchema.post("init", function (doc) {
  if (doc.accessToken && doc.accessToken.includes(":")) {
    doc.accessToken = decrypt(doc.accessToken);
  }
  if (doc.refreshToken && doc.refreshToken.includes(":")) {
    doc.refreshToken = decrypt(doc.refreshToken);
  }
});

module.exports = mongoose.model(
  "ConnectedAccount",
  connectedAccountSchema
);