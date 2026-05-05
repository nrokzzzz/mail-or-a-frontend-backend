const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode-terminal");

// ─── WhatsApp Client Configuration ──────────────────────────────────────────
// LocalAuth persists the session in .wwebjs_auth/ so QR scan is only
// required on the very first run. Every subsequent restart reuses the
// saved session automatically.
const client = new Client({
  authStrategy: new LocalAuth({
    clientId: "whatsapp-service",
    dataPath: "./.wwebjs_auth",
  }),
  puppeteer: {
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  },
});

// ─── Client Event Handlers ──────────────────────────────────────────────────

// Display QR code in the terminal (first run only)
client.on("qr", (qr) => {
  console.log("\n╔════════════════════════════════════════════╗");
  console.log("║   Scan QR code below with WhatsApp app    ║");
  console.log("╚════════════════════════════════════════════╝\n");
  qrcode.generate(qr, { small: true });
});

// Session has been saved/restored successfully
client.on("authenticated", () => {
  console.log("✅ WhatsApp session authenticated & saved.");
});

// Client is fully ready to send/receive messages
client.on("ready", () => {
  console.log("🟢 WhatsApp client is ready!");
});

// Authentication failed (session corrupt, revoked, etc.)
client.on("auth_failure", (msg) => {
  console.error("❌ WhatsApp auth failure:", msg);
});

// Client got disconnected
client.on("disconnected", (reason) => {
  console.warn("⚠️  WhatsApp disconnected:", reason);
});

module.exports = client;
