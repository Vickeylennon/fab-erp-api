// B2C only: pickup_bookings
// POST /api/create-payment-link  { docId: "..." }

import Razorpay from "razorpay";
import admin from "firebase-admin";

// --- allow only your frontends (optional; remove if not needed) ---
const ALLOWED_ORIGINS = new Set([
  "https://fab-erp.firebaseapp.com",
  "https://fab-erp.web.app",
  "http://localhost:5173",
  "http://localhost:5000"
  "https://fab-erp-lf3sxmdku-vigneshs-projects-ae914a48.vercel.app"
]);

function cors(res, origin) {
  if (origin && ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function initAdmin() {
  if (admin.apps.length) return admin;
  const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!creds) throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS_JSON env var");
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(creds))
  });
  return admin;
}

export default async function handler(req, res) {
  cors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { docId } = req.body || {};
    if (!docId) return res.status(400).json({ error: "docId is required" });

    // Init Firebase + Razorpay
    const a = initAdmin();
    const db = a.firestore();

    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key_id || !key_secret) throw new Error("Razorpay keys not set");
    const rzp = new Razorpay({ key_id, key_secret });

    // Load booking (B2C only)
    const ref = db.collection("pickup_bookings").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "booking not found" });
    const d = snap.data();

    // Amount (₹) → paise
    const amountNumber = d?.pickupDetails?.totalAmount ?? d?.totalAmount ?? 0;
    if (!amountNumber || isNaN(amountNumber)) return res.status(400).json({ error: "invalid amount" });
    const amountPaise = Math.round(Number(amountNumber) * 100);

    const customerName = String(d?.Name ?? "Customer").trim();
    const mobile = String(d?.Mobile ?? "").replace(/[^\d]/g, ""); // 91XXXXXXXXXX
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

    const link = await rzp.paymentLink.create(payload);

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
    console.error(e);
    return res.status(500).json({ error: "internal_error" });
  }
}
