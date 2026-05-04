// modules/auth/google.controller.js

const { google } = require("googleapis");
const jwt = require("jsonwebtoken");
const ConnectedAccount = require("../connectedAccount/connectedAccount.model");
const {
  getGoogleOAuthClient,
  getGmailClient,
} = require("../../services/google.service");

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

/**
 * Step 1: Redirect user to Google
 */
exports.googleAuth = async (req, res) => {
  try {
    const oauthClient = getGoogleOAuthClient();

    const stateToken = jwt.sign({ userId: req.user._id.toString() }, process.env.JWT_SECRET || "fallback_secret", {
        expiresIn: "10m",
    });

    const authUrl = oauthClient.generateAuthUrl({
      access_type: "offline",
      scope: SCOPES,
      prompt: "consent",
      state: stateToken, // pass userId as a signed JWT
    });

    res.redirect(authUrl);
  } catch (error) {
    console.error("Google auth error:", error);
    res.status(500).json({ message: "Google auth failed" });
  }
};

/**
 * Step 2: Handle callback
 */
exports.googleCallback = async (req, res) => {
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.status(400).json({ message: "Authorization code or state missing" });
    }

    let decoded;
    try {
        decoded = jwt.verify(state, process.env.JWT_SECRET || "fallback_secret");
    } catch (err) {
        return res.status(400).json({ message: "Invalid or expired state" });
    }

    const userId = decoded.userId;

    const oauthClient = getGoogleOAuthClient();

    // Exchange code for tokens
    const { tokens } = await oauthClient.getToken(code);

    oauthClient.setCredentials(tokens);

    const gmail = getGmailClient(oauthClient);

    // Get Gmail profile
    const profile = await gmail.users.getProfile({
      userId: "me",
    });

    const emailAddress = profile.data.emailAddress;

    // Limit to max 3 accounts
    const accountCount = await ConnectedAccount.countDocuments({
      userId,
    });

    if (accountCount >= 3) {
      return res.status(400).json({
        message: "Maximum 3 connected email accounts allowed",
      });
    }

    // Start Gmail watch()
    const watchResponse = await gmail.users.watch({
      userId: "me",
      requestBody: {
        topicName: process.env.GOOGLE_PUBSUB_TOPIC,
        labelIds: ["INBOX"],
      },
    });

    // Save in DB
    await ConnectedAccount.create({
      userId,
      provider: "google",
      emailAddress,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenExpiry: tokens.expiry_date
        ? new Date(tokens.expiry_date)
        : new Date(Date.now() + 3600 * 1000), // default 1 hour if Google doesn't provide it
      lastHistoryId: watchResponse.data.historyId,
      isActive: true,
    });

    res.json({
      message: "Gmail connected successfully",
      email: emailAddress,
    });
  } catch (error) {
    console.error("Google callback error:", error);
    res.status(500).json({ message: "Google connection failed" });
  }
};