/**
 * API-key guard for the serpapi refresh endpoint.
 *
 * Enforced ONLY when JOBS_API_KEY is set. The read endpoints (/search, /roles)
 * stay public; only POST /refresh — which spends SerpAPI credits — is protected
 * so a public deployment (searapi.mail-or-a.dev) can't be abused to drain them.
 * The main server forwards the matching `x-api-key` header on its refresh proxy.
 */
module.exports = function apiKeyAuth(req, res, next) {
  const required = process.env.JOBS_API_KEY;
  if (!required) return next(); // auth disabled (private/dev)

  const provided = req.get("x-api-key");
  if (provided && provided === required) return next();

  return res.status(401).json({ success: false, message: "Unauthorized" });
};
