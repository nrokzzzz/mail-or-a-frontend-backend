/**
 * Crypto Utility — AES-256-CBC Encryption / Decryption
 *
 * Provides field-level encryption at rest for sensitive email content
 * and OAuth tokens. Uses AES-256-CBC with random IVs.
 *
 * Also provides a cryptographically secure OTP generator.
 *
 * SECURITY: The server will refuse to start if EMAIL_ENCRYPTION_KEY is missing.
 */

const crypto = require("crypto");
const logger = require("./logger");

const algorithm = "aes-256-cbc";
const ivLength = 16;

// ─── Encryption Key (REQUIRED — no silent fallback) ─────────────────────────
if (!process.env.EMAIL_ENCRYPTION_KEY) {
  console.error("FATAL: EMAIL_ENCRYPTION_KEY is not defined in environment variables!");
  console.error("       The server cannot start without an encryption key.");
  console.error("       Set EMAIL_ENCRYPTION_KEY in your .env file and restart.");
  process.exit(1);
}

const key = crypto
  .createHash("sha256")
  .update(process.env.EMAIL_ENCRYPTION_KEY)
  .digest();

// ─── Encrypt ────────────────────────────────────────────────────────────────
exports.encrypt = (text) => {
  try {
    if (!text) return text;
    const iv = crypto.randomBytes(ivLength);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    return iv.toString("hex") + ":" + encrypted;
  } catch (err) {
    logger.error("Crypto", "Encryption error", err);
    throw err;
  }
};

// ─── Decrypt ────────────────────────────────────────────────────────────────
exports.decrypt = (text) => {
  try {
    if (!text || typeof text !== "string" || !text.includes(":")) return text;
    const parts = text.split(":");
    const iv = Buffer.from(parts.shift(), "hex");
    const encryptedText = parts.join(":");

    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    logger.warn("Crypto", "Decryption error", err.message);
    return "Error decrypting text";
  }
};

// ─── Secure OTP Generator ───────────────────────────────────────────────────
/**
 * Generate a cryptographically secure 6-digit OTP.
 * Uses crypto.randomInt() instead of Math.random() for security.
 * @returns {string} A 6-digit OTP string (e.g., "042931")
 */
exports.generateOtp = () => {
  return String(crypto.randomInt(100000, 999999));
};