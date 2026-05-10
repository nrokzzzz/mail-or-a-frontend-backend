const mongoose = require("mongoose");

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

    accessToken: {
      type: String,
      required: true,
    },

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
  },
  { timestamps: true }
);

// Prevent same email connected twice for same user
connectedAccountSchema.index(
  { userId: 1, emailAddress: 1 },
  { unique: true }
);

module.exports = mongoose.model(
  "ConnectedAccount",
  connectedAccountSchema
);