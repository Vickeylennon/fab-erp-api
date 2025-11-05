// api/ping.js
const ALLOWED_ORIGINS = new Set([
  "https://fab-erp.web.app",
  "https://fab-erp.firebaseapp.com"
]);

module.exports = (req, res) => {
  const origin = req.headers.origin || "";
  res.setHeader("Vary", "Origin");
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: "CORS_ORIGIN_NOT_ALLOWED", origin });
  return res.status(200).json({ ok: true });
};
