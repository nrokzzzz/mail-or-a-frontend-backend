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
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  try {
    const { code, state } = req.query;

    if (!code || !state) {
      return res.redirect(`${frontendUrl}/profile?gmail=error&msg=Authorization+code+missing`);
    }

    let decoded;
    try {
        decoded = jwt.verify(state, process.env.JWT_SECRET || "fallback_secret");
    } catch (err) {
        return res.redirect(`${frontendUrl}/profile?gmail=error&msg=Session+expired`);
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

    // Check if this email is already connected by this user
    const existingAccount = await ConnectedAccount.findOne({ userId, emailAddress });

    if (existingAccount) {
      // Update tokens
      existingAccount.accessToken = tokens.access_token;
      if (tokens.refresh_token) existingAccount.refreshToken = tokens.refresh_token;
      existingAccount.tokenExpiry = tokens.expiry_date
        ? new Date(tokens.expiry_date)
        : new Date(Date.now() + 3600 * 1000);
      existingAccount.isActive = true;

      // Re-watch
      const watchResponse = await gmail.users.watch({
        userId: "me",
        requestBody: {
          topicName: process.env.GOOGLE_PUBSUB_TOPIC,
          labelIds: ["INBOX"],
        },
      });
      existingAccount.lastHistoryId = watchResponse.data.historyId;
      await existingAccount.save();

      return res.redirect(`${frontendUrl}/profile?gmail=success&email=${encodeURIComponent(emailAddress)}`);
    }

    // Limit to max 3 accounts
    const accountCount = await ConnectedAccount.countDocuments({ userId });

    if (accountCount >= 3) {
      return res.redirect(`${frontendUrl}/profile?gmail=error&msg=Maximum+3+accounts+allowed`);
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
        : new Date(Date.now() + 3600 * 1000),
      lastHistoryId: watchResponse.data.historyId,
      isActive: true,
    });

    res.redirect(`${frontendUrl}/profile?gmail=success&email=${encodeURIComponent(emailAddress)}`);
  } catch (error) {
    console.error("Google callback error:", error);
    res.redirect(`${frontendUrl}/profile?gmail=error&msg=Connection+failed`);
  }
};