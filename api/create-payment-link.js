// api/create-payment-link.js
// Creates a Razorpay Payment Link for a pickup_bookings doc
// Env: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, GOOGLE_APPLICATION_CREDENTIALS_JSON

// ---------- Strict CORS (single origin echo; allow no-origin for testing/tools) ----------
const ALLOWED_ORIGINS = new Set([
  "https://fab-erp.web.app",
  "https://fab-erp.firebaseapp.com",
  "https://fab-erp-api.vercel.app" // allow direct tests from the API domain if needed
]);

function setCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Vary", "Origin");

  if (!origin) {
    // No Origin header (direct browser hit, curl, server-to-server). Allow and respond with '*'.
    res.setHeader("Access-Control-Allow-Origin", "*");
  } else if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true; // handled
  }

  if (origin && !ALLOWED_ORIGINS.has(origin)) {
    // Block disallowed browser origins (don’t send ACAO in this case)
    res.status(403).json({ error: "CORS_ORIGIN_NOT_ALLOWED", origin });
    return true;
  }
  return false;
}

module.exports = async (req, res) => {
  // 1) Always set CORS first
  if (setCors(req, res)) return;

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Lazy imports (so CORS headers are already set if something fails)
    let Razorpay, admin;
    try {
      Razorpay = require("razorpay");
      admin = require("firebase-admin");
    } catch (e) {
      return res.status(500).json({
        error: "SERVER_MISCONFIG: Missing dependencies (razorpay or firebase-admin)"
      });
    }

    // Env checks
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    const rawCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
    if (!key_id || !key_secret) {
      return res.status(500).json({ error: "SERVER_MISCONFIG: Missing Razorpay keys" });
    }
    if (!rawCreds) {
      return res.status(500).json({ error: "SERVER_MISCONFIG: Missing GOOGLE_APPLICATION_CREDENTIALS_JSON" });
    }

    // Admin init
    let creds;
    try { creds = JSON.parse(rawCreds); }
    catch { return res.status(500).json({ error: "SERVER_MISCONFIG: GOOGLE_APPLICATION_CREDENTIALS_JSON parse error" }); }
    if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(creds) });
    const db = admin.firestore();

    // Input
    const { docId } = req.body || {};
    if (!docId) return res.status(400).json({ error: "docId is required" });

    // Read booking
    const ref = db.collection("pickup_bookings").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "booking not found" });
    const d = snap.data() || {};

    // Preconditions
    const status = String(d.status || "").trim().toLowerCase();
    if (status !== "delivered") return res.status(400).json({ error: `invalid status: ${d.status}` });

    const amountNumber = d?.pickupDetails?.totalAmount ?? d?.totalAmount ?? 0;
    if (!amountNumber || isNaN(amountNumber)) {
      return res.status(400).json({ error: "invalid amount (pickupDetails.totalAmount or totalAmount)" });
    }

    const customerName = String(d?.Name ?? "Customer").trim();
    const mobile = String(d?.Mobile ?? "").replace(/[^\d]/g, ""); // optional

    // Razorpay
    const rzp = new require("razorpay")({ key_id, key_secret });
    const amountPaise = Math.round(Number(amountNumber) * 100);
    const referenceId = `pickup:${docId}`;

    let link;
    try {
      link = await rzp.paymentLink.create({
        amount: amountPaise,
        currency: "INR",
        reference_id: referenceId,
        description: `Fab Revive Laundry - ${referenceId}`,
        notes: { source: "pickup", docId },
        customer: { name: customerName, contact: mobile || undefined },
        notify: { sms: false, email: false },
        reminder_enable: true,
        callback_method: "get"
      });
    } catch (e) {
      const msg = e?.error?.description || e?.message || "razorpay_error";
      return res.status(500).json({ error: `RAZORPAY: ${msg}` });
    }

    // Save
    await ref.set({
      paymentStatus: "Pending",
      "razorpay.paymentLinkId": link.id,
      "razorpay.paymentLinkURL": link.short_url || link.url,
      "razorpay.amount": amountNumber
    }, { merge: true });

    // Response
    return res.status(200).json({
      paymentLinkURL: link.short_url || link.url,
      customerPhone: mobile,
      customerName,
      amount: amountNumber
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || "internal_error") });
  }
};
