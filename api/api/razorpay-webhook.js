// Razorpay webhook endpoint (set in dashboard)
// URL: https://YOUR_DOMAIN/api/razorpay-webhook
// Event to enable: payment_link.paid
// Secret must match env WEBHOOK_SECRET

import crypto from "crypto";
import admin from "firebase-admin";

function initAdmin() {
  if (admin.apps.length) return admin;
  const creds = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!creds) throw new Error("Missing GOOGLE_APPLICATION_CREDENTIALS_JSON env var");
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(creds))
  });
  return admin;
}

// Vercel gives req.body already parsed; to verify signature we need raw.
// Workaround: use the raw body from req.__POST_BODY if provided, else fallback.
export const config = {
  api: {
    bodyParser: false
  }
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = [];
    req.on("data", chunk => data.push(chunk));
    req.on("end", () => resolve(Buffer.concat(data)));
    req.on("error", reject);
  });
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");
  try {
    const raw = await readBody(req);
    const signature = req.headers["x-razorpay-signature"];
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) throw new Error("WEBHOOK_SECRET not set");

    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    if (expected !== signature) {
      console.warn("Invalid Razorpay signature");
      return res.status(400).send("Invalid signature");
    }

    const event = JSON.parse(raw.toString("utf8"));
    const type = event?.event;

    if (type === "payment_link.paid" || type === "payment.paid") {
      // Extract reference_id => "pickup:docId"
      const ref =
        event?.payload?.payment_link?.entity?.reference_id ||
        event?.payload?.payment?.entity?.notes?.reference_id ||
        event?.payload?.payment?.entity?.description || "";

      let docId = null;
      if (ref.includes(":")) {
        const [, id] = ref.split(":");
        docId = id;
      } else {
        docId = event?.payload?.payment_link?.entity?.notes?.docId || null;
      }
      if (!docId) {
        console.warn("DocId not found in webhook payload");
        return res.status(200).end();
      }

      const a = initAdmin();
      const db = a.firestore();

      await db.collection("pickup_bookings").doc(docId).set({
        paymentStatus: "Paid",
        cashStatus: "Received",
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    return res.status(200).end();
  } catch (e) {
    console.error(e);
    return res.status(500).end();
  }
}
