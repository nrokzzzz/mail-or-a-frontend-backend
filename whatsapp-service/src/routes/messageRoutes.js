const express = require("express");
const router = express.Router();
const messageController = require("../controllers/messageController");
const apiKeyAuth = require("../middleware/apiKeyAuth");

// ─── API Routes ─────────────────────────────────────────────────────────────

// POST /api/send       → Send a single WhatsApp message (protected)
router.post("/send", apiKeyAuth, messageController.send);

// POST /api/send-bulk  → Send bulk WhatsApp messages (2s delay between each) (protected)
router.post("/send-bulk", apiKeyAuth, messageController.sendBulk);

// GET  /health         → Health check (public — no key, so proxies/uptime checks work)
router.get("/health", messageController.healthCheck);

module.exports = router;
