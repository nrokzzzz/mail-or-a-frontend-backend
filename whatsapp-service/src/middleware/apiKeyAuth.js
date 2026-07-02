/**
 * API-key guard for the WhatsApp send endpoints.
 *
 * Enforced ONLY when WHATSAPP_API_KEY is set in the environment. This keeps
 * private/dev deployments (no key) working unchanged, while a public deployment
 * (whatsapp.mail-or-a.dev) can require the shared secret so that only the main
 * server — which sends the matching `x-api-key` header — can trigger sends.
 */
module.exports = function apiKeyAuth(req, res, next) {
  const required = process.env.WHATSAPP_API_KEY;
  if (!required) return next(); // auth disabled (private/dev)

  const provided = req.get("x-api-key");
  if (provided && provided === required) return next();

  return res.status(401).json({ success: false, error: "Unauthorized" });
};
