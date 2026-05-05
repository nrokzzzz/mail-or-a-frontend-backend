require("dotenv").config();

const app = require("./src/app");
const client = require("./src/config/whatsapp");

const PORT = process.env.PORT || 3000;

// ─── Boot Sequence ──────────────────────────────────────────────────────────
// 1. Initialize WhatsApp client FIRST
// 2. Start Express server only AFTER WhatsApp is ready

console.log("🚀 Starting WhatsApp Service...\n");

client.initialize();

client.once("ready", () => {
  // WhatsApp is connected → now start the HTTP server
  app.listen(PORT, () => {
    console.log(`\n🌐 API server running on http://localhost:${PORT}`);
    console.log(`   POST /api/send       → Send single message`);
    console.log(`   POST /api/send-bulk  → Send bulk messages`);
    console.log(`   GET  /health         → Health check\n`);
  });
});
