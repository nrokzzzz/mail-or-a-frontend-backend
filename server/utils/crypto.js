const crypto = require("crypto");

const algorithm = "aes-256-cbc";

// Added a fallback and warning if ENCRYPTION_KEY is missing
if (!process.env.EMAIL_ENCRYPTION_KEY) {
  console.warn("⚠️ EMAIL_ENCRYPTION_KEY is not defined in environment variables!");
}

const key = process.env.EMAIL_ENCRYPTION_KEY
  ? crypto.createHash("sha256").update(process.env.EMAIL_ENCRYPTION_KEY).digest()
  : Buffer.alloc(32);

const ivLength = 16;

exports.encrypt = (text) => {
  try {
    if (!text) return text;
    const iv = crypto.randomBytes(ivLength);
    const cipher = crypto.createCipheriv(algorithm, key, iv);
    let encrypted = cipher.update(text, "utf8", "hex");
    encrypted += cipher.final("hex");

    return iv.toString("hex") + ":" + encrypted;
  } catch (err) {
    console.error("Encryption error:", err.message);
    throw err;
  }
};

exports.decrypt = (text) => {
  try {
    if (!text || typeof text !== 'string' || !text.includes(":")) return text;
    const parts = text.split(":");
    const iv = Buffer.from(parts.shift(), "hex");
    const encryptedText = parts.join(":");

    const decipher = crypto.createDecipheriv(algorithm, key, iv);
    let decrypted = decipher.update(encryptedText, "hex", "utf8");
    decrypted += decipher.final("utf8");

    return decrypted;
  } catch (err) {
    console.warn("⚠️ Decryption error:", err.message);
    return "Error decrypting text";
  }
};