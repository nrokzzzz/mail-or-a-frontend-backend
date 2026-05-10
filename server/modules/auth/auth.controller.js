const User = require("../user/user.model");
const PendingVerification = require("./pendingVerification.model");
const bcrypt = require("bcryptjs");
const { generateToken, setAuthCookie } = require("../../utils/auth");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const { sendSignupOtpEmail, sendResetPasswordEmail, sendChangePasswordEmail } = require("../../services/otp.email.service");
const { getPresignedUrl } = require("../../services/s3.service");
const { encrypt, decrypt } = require("../../utils/crypto");
const { validateEmail, validatePassword, validateOtp } = require("../../utils/validators");
const logger = require("../../utils/logger");

// ─── Step 1: Send Signup OTP ──────────────────────────────────────────────────
// POST /api/auth/send-signup-otp
// Body: { email }
// Sends OTP to email — no user created yet
exports.sendSignupOtp = async (req, res) => {
  try {
    const { email } = req.body;

    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) {
      return res.status(400).json({ message: emailCheck.message });
    }

    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already in use." });
    }

    const otp       = String(Math.floor(100000 + Math.random() * 900000));
    const hashedOtp = await bcrypt.hash(otp, 10);
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 min

    // Upsert — resend if user requests OTP again for the same email
    await PendingVerification.findOneAndUpdate(
      { email },
      { hashedOtp, expiresAt },
      { upsert: true }
    );

    await sendSignupOtpEmail(email, otp);

    res.json({ message: "OTP sent to your email. It is valid for 10 minutes." });
  } catch (error) {
    logger.error("Auth", "Send signup OTP error", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ─── Step 2: Signup (OTP verified → User created) ────────────────────────────
// POST /api/auth/signup
// Body: { name, email, password, otp }
// User is only created in DB if OTP is valid
exports.signup = async (req, res) => {
  try {
    const { name, email, password, otp } = req.body;

    if (!name || !email || !password || !otp) {
      return res.status(400).json({ message: "Name, email, password and OTP are required." });
    }

    const emailCheck = validateEmail(email);
    if (!emailCheck.valid) {
      return res.status(400).json({ message: emailCheck.message });
    }

    const pwdCheck = validatePassword(password);
    if (!pwdCheck.valid) {
      return res.status(400).json({ message: pwdCheck.message });
    }

    const otpCheck = validateOtp(otp);
    if (!otpCheck.valid) {
      return res.status(400).json({ message: otpCheck.message });
    }

    // Check OTP record exists
    const pending = await PendingVerification.findOne({ email });
    if (!pending) {
      return res.status(400).json({ message: "No OTP found for this email. Please request one first." });
    }

    if (pending.expiresAt < new Date()) {
      await PendingVerification.deleteOne({ email });
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }

    const isMatch = await bcrypt.compare(otp, pending.hashedOtp);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid OTP." });
    }

    // OTP valid — check email not registered in the time since OTP was sent
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ message: "Email already in use." });
    }

    // Create user only after OTP verified
    const hashed = await bcrypt.hash(password, 10);
    const user   = await User.create({ name, email, password: hashed });

    // Clean up pending record
    await PendingVerification.deleteOne({ email });

    res.status(201).json({
      message: "Account created successfully.",
      user: {
        _id:   user._id,
        name:  user.name,
        email: user.email,
      },
    });
  } catch (error) {
    logger.error("Auth", "Signup error", error);
    res.status(500).json({ message: "Internal server error" });
  }
};



exports.login = async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ message: "Please provide email and password" });
    }

    const user = await User.findOne({ email }).select("+password");
    if (!user) return res.status(400).json({ message: "Invalid credentials" });

    // Block Google/Microsoft OAuth accounts from using password login
    if (user.authProvider !== "local") {
      return res.status(400).json({
        message: `This account uses ${user.authProvider} sign-in. Please log in with ${user.authProvider}.`,
      });
    }

    if (!user.password) {
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ message: "Invalid credentials" });

    const token = generateToken(user._id);

    setAuthCookie(res, token);

    const photoUrl = user.photoS3Key ? await getPresignedUrl(user.photoS3Key) : user.photoUrl || "";

    res.json({
      message: "Login successful",
      token,
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        photo: photoUrl,
      },
    });
  } catch (error) {
    logger.error("Auth", "Login error", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ─── Logout ──────────────────────────────────────────────────────────────────
// POST /api/auth/logout
// Clears the httpOnly JWT cookie so the user is fully logged out
exports.logout = (req, res) => {
  res.clearCookie("token", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: process.env.NODE_ENV === "production" ? "none" : "strict",
  });
  res.json({ message: "Logged out successfully" });
};

// ─── Forgot Password ─────────────────────────────────────────────────────────
// POST /api/auth/forgot-password
// Body: { email }
// Sends a link to frontend with otp + encrypted email as query params
exports.forgotPassword = async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ message: "Please provide your email." });
    }

    const user = await User.findOne({ email });
    if (!user) {
      return res.json({ message: "If this email exists, a reset link has been sent." });
    }

    // Generate 6-digit OTP
    const otp = String(Math.floor(100000 + Math.random() * 900000));

    // Hash OTP before storing
    const hashedOtp = await bcrypt.hash(otp, 10);

    user.passwordResetOtp = hashedOtp;
    user.passwordResetOtpExpiry = new Date(Date.now() + 5 * 60 * 1000); // 5 min
    await user.save();

    // Encrypt email for URL — hides plain email in the link
    const encryptedEmail = encodeURIComponent(encrypt(email));

    const resetLink  = `${process.env.FRONTEND_URL}/change-password?otp=${otp}&email=${encryptedEmail}`;

    await sendResetPasswordEmail(user.email, resetLink);

    res.json({ message: "If this email exists, a reset link has been sent." });
  } catch (error) {
    logger.error("Auth", "Forgot password error", error);
    res.status(500).json({ message: "Internal server error" });
  }
};


// ─── Reset Password ───────────────────────────────────────────────────────────
// POST /api/auth/reset-password
// Body: { encryptedEmail, otp, newPassword }
// Use when user does NOT know their old password
exports.resetPassword = async (req, res) => {
  try {
    const { encryptedEmail, otp, newPassword } = req.body;

    if (!encryptedEmail || !otp || !newPassword) {
      return res.status(400).json({ message: "Email, OTP and new password are required." });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "Password must be at least 6 characters." });
    }

    // Decrypt email from URL param
    let email;
    try {
      email = decrypt(decodeURIComponent(encryptedEmail));
    } catch {
      return res.status(400).json({ message: "Invalid request." });
    }

    const user = await User.findOne({ email }).select("+passwordResetOtp +passwordResetOtpExpiry");

    if (!user || !user.passwordResetOtp || !user.passwordResetOtpExpiry) {
      return res.status(400).json({ message: "Invalid or expired OTP." });
    }

    if (user.passwordResetOtpExpiry < new Date()) {
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }

    const isMatch = await bcrypt.compare(otp, user.passwordResetOtp);
    if (!isMatch) {
      return res.status(400).json({ message: "Invalid OTP." });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.passwordResetOtp = undefined;
    user.passwordResetOtpExpiry = undefined;
    await user.save();

    res.json({ message: "Password reset successful. You can now log in." });
  } catch (error) {
    logger.error("Auth", "Reset password error", error);
    res.status(500).json({ message: "Internal server error" });
  }
};

// ─── Change Password ──────────────────────────────────────────────────────────
// POST /api/auth/change-password
// Body: { encryptedEmail, otp, oldPassword, newPassword }
// Use when user KNOWS their old password
exports.changePassword = async (req, res) => {
  try {
    const { encryptedEmail, otp, oldPassword, newPassword } = req.body;

    if (!encryptedEmail || !otp || !oldPassword || !newPassword) {
      return res.status(400).json({ message: "Email, OTP, old password and new password are required." });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ message: "New password must be at least 6 characters." });
    }

    // Decrypt email from URL param
    let email;
    try {
      email = decrypt(decodeURIComponent(encryptedEmail));
    } catch {
      return res.status(400).json({ message: "Invalid request." });
    }

    const user = await User.findOne({ email }).select("+password +passwordResetOtp +passwordResetOtpExpiry");

    if (!user || !user.passwordResetOtp || !user.passwordResetOtpExpiry) {
      return res.status(400).json({ message: "Invalid or expired OTP." });
    }

    if (user.passwordResetOtpExpiry < new Date()) {
      return res.status(400).json({ message: "OTP has expired. Please request a new one." });
    }

    const isOtpMatch = await bcrypt.compare(otp, user.passwordResetOtp);
    if (!isOtpMatch) {
      return res.status(400).json({ message: "Invalid OTP." });
    }

    const isPasswordMatch = await bcrypt.compare(oldPassword, user.password);
    if (!isPasswordMatch) {
      return res.status(400).json({ message: "Old password is incorrect." });
    }

    if (oldPassword === newPassword) {
      return res.status(400).json({ message: "New password must be different from the old password." });
    }

    user.password = await bcrypt.hash(newPassword, 10);
    user.passwordResetOtp = undefined;
    user.passwordResetOtpExpiry = undefined;
    await user.save();

    res.json({ message: "Password changed successfully." });
  } catch (error) {
    logger.error("Auth", "Change password error", error);
    res.status(500).json({ message: "Internal server error" });
  }
};