// api/create-payment-link.js
// B2C only (pickup_bookings). Creates a Razorpay Payment Link and stores it on the booking doc.
// Requires env vars: RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, GOOGLE_APPLICATION_CREDENTIALS_JSON

const Razorpay = require("razorpay");
const admin = require("firebase-admin");

// ----- CORS (single-origin echo; never comma-separated) -----
const ALLOWED_ORIGINS = new Set([
  "https://fab-erp.web.app",
  "https://fab-erp.firebaseapp.com"
]);

function handleCors(req, res) {
  const origin = req.headers.origin || "";
  res.setHeader("Vary", "Origin");
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Preflight short-circuit
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return true;
  }

  // Block disallowed origins (don’t send ACAO in this case)
  if (!ALLOWED_ORIGINS.has(origin)) {
    res.status(403).json({ error: "CORS_ORIGIN_NOT_ALLOWED", origin });
    return true;
  }
  return false;
}

// ----- Firebase Admin init from env JSON -----
function initAdminOrThrow() {
  if (admin.apps.length) return admin;
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) throw new Error("SERVER_MISCONFIG: Missing GOOGLE_APPLICATION_CREDENTIALS_JSON");
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch (e) {
    throw new Error("SERVER_MISCONFIG: GOOGLE_APPLICATION_CREDENTIALS_JSON parse error");
  }
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  return admin;
}

module.exports = async (req, res) => {
  if (handleCors(req, res)) return; // CORS handled (OPTIONS or forbidden)

  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Validate env
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key_id || !key_secret) {
      return res.status(500).json({ error: "SERVER_MISCONFIG: Missing Razorpay keys" });
    }

    // Input
    const { docId } = req.body || {};
    if (!docId) return res.status(400).json({ error: "docId is required" });

    // Firestore
    const a = initAdminOrThrow();
    const db = a.firestore();

    // Read booking
    const ref = db.collection("pickup_bookings").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "booking not found" });
    const d = snap.data() || {};

    // Preconditions
    const status = String(d.status || "").trim().toLowerCase();
    if (status !== "delivered") {
      return res.status(400).json({ error: `invalid status: ${d.status}` });
    }

    const amountNumber =
      d?.pickupDetails?.totalAmount ??
      d?.totalAmount ??
      0;

    if (!amountNumber || isNaN(amountNumber)) {
      return res.status(400).json({ error: "invalid amount (pickupDetails.totalAmount or totalAmount)" });
    }

    const customerName = String(d?.Name ?? "Customer").trim();
    const mobile = String(d?.Mobile ?? "").replace(/[^\d]/g, ""); // optional

    // Razorpay client
    const rzp = new Razorpay({ key_id, key_secret });

    // Create payment link
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
      console.error("RAZORPAY_ERROR", e?.error || e);
      return res.status(500).json({ error: `RAZORPAY: ${msg}` });
    }

    // Save to Firestore
    await ref.set(
      {
        paymentStatus: "Pending",
        "razorpay.paymentLinkId": link.id,
        "razorpay.paymentLinkURL": link.short_url || link.url,
        "razorpay.amount": amountNumber
      },
      { merge: true }
    );

    // Response
    return res.status(200).json({
      paymentLinkURL: link.short_url || link.url,
      customerPhone: mobile,
      customerName,
      amount: amountNumber
    });
  } catch (e) {
    console.error("INTERNAL_ERROR", e);
    return res.status(500).json({ error: String(e.message || "internal_error") });
  }
};
