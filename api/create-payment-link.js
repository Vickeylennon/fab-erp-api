// B2C only: pickup_bookings
// POST /api/create-payment-link  { docId: "..." }

import Razorpay from "razorpay";
import admin from "firebase-admin";

// --- CORS: handle preflight reliably (dev-safe) ---
function cors(res, origin) {
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
  res.setHeader("Access-Control-Max-Age", "86400");

  // Allow your production origins explicitly:
  const ALLOWED = new Set([
    "https://fab-erp.firebaseapp.com",
    "https://fab-erp.web.app",
    "https://fab-erp-lf3sxmdku-vigneshs-projects-ae914a48.vercel.app",
    // add your ERP domain(s) below if different:
    // "https://your-erp-domain.com"
  ]);

  // During setup, also allow null/unknown (file://, some previews)
  if (!origin || origin === "null" || ALLOWED.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
}

function initAdminOrThrow() {
  if (admin.apps.length) return admin;
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) throw new Error("ADMIN_INIT: Missing GOOGLE_APPLICATION_CREDENTIALS_JSON");
  let creds;
  try { creds = JSON.parse(raw); }
  catch (e) { throw new Error("ADMIN_INIT: Service account JSON invalid"); }
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  return admin;
}

export default async function handler(req, res) {
  cors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { docId } = req.body || {};
    if (!docId) return res.status(400).json({ error: "docId is required" });

    // ---- Firebase Admin
    let a;
    try { a = initAdminOrThrow(); }
    catch (e) { console.error(e); return res.status(500).json({ error: String(e.message || e) }); }
    const db = a.firestore();

    // ---- Razorpay
    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key_id || !key_secret) {
      return res.status(500).json({ error: "RAZORPAY: Keys not set in env" });
    }
    const rzp = new Razorpay({ key_id, key_secret });

    // ---- Fetch booking (B2C only)
    const ref = db.collection("pickup_bookings").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "booking not found" });
    const d = snap.data() || {};

    // ---- Validate fields
    const amountNumber = d?.pickupDetails?.totalAmount ?? d?.totalAmount ?? 0;
    if (!amountNumber || isNaN(amountNumber)) {
      return res.status(400).json({ error: "invalid amount (pickupDetails.totalAmount or totalAmount)" });
    }
    const status = String(d.status || "").trim().toLowerCase();
    if (status !== "delivered") {
      return res.status(400).json({ error: `invalid status: ${d.status}` });
    }

    const customerName = String(d?.Name ?? "Customer").trim();
    const mobile = String(d?.Mobile ?? "").replace(/[^\d]/g, ""); // 91XXXXXXXXXX preferred

    const amountPaise = Math.round(Number(amountNumber) * 100);
    const referenceId = `pickup:${docId}`;

    const payload = {
      amount: amountPaise,
      currency: "INR",
      reference_id: referenceId,
      description: `Fab Revive Laundry - ${referenceId}`,
      notes: { source: "pickup", docId },
      customer: { name: customerName, contact: mobile || undefined },
      notify: { sms: false, email: false },
      reminder_enable: true,
      callback_method: "get"
    };

    let link;
    try {
      link = await rzp.paymentLink.create(payload);
    } catch (e) {
      console.error("RAZORPAY_ERROR", e?.error || e);
      const msg = e?.error?.description || e?.message || "razorpay_error";
      return res.status(500).json({ error: `RAZORPAY: ${msg}` });
    }

    await ref.set({
      paymentStatus: "Pending",
      "razorpay.paymentLinkId": link.id,
      "razorpay.paymentLinkURL": link.short_url || link.url,
      "razorpay.amount": amountNumber
    }, { merge: true });

    return res.status(200).json({
      paymentLinkURL: link.short_url || link.url,
      customerPhone: mobile,
      customerName,
      amount: amountNumber
    });
  } catch (e) {
    console.error("INTERNAL_ERROR", e);
    return res.status(500).json({ error: "internal_error" });
  }
}
