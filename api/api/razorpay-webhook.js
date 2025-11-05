// POST /api/razorpay-webhook
// Set in Razorpay dashboard: event payment_link.paid, Secret = WEBHOOK_SECRET

const crypto = require("crypto");
const admin = require("firebase-admin");

function initAdminOrThrow() {
  if (admin.apps.length) return admin;
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON;
  if (!raw) throw new Error("ADMIN_INIT: Missing GOOGLE_APPLICATION_CREDENTIALS_JSON");
  let creds; try { creds = JSON.parse(raw); } catch (e) { throw new Error("ADMIN_INIT: Service account JSON invalid"); }
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  return admin;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  try {
    const raw = await readBody(req);
    const signature = req.headers["x-razorpay-signature"];
    const secret = process.env.WEBHOOK_SECRET;
    if (!secret) { console.error("WEBHOOK: secret missing"); return res.status(500).end(); }

    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    if (expected !== signature) { console.warn("WEBHOOK: invalid signature"); return res.status(400).end(); }

    const event = JSON.parse(raw.toString("utf8"));
    const type = event?.event;

    if (type === "payment_link.paid" || type === "payment.paid") {
      const ref =
        event?.payload?.payment_link?.entity?.reference_id ||
        event?.payload?.payment?.entity?.notes?.reference_id ||
        event?.payload?.payment?.entity?.description || "";

      let docId = null;
      if (ref && ref.includes(":")) {
        docId = ref.split(":")[1];
      } else {
        docId = event?.payload?.payment_link?.entity?.notes?.docId || null;
      }
      if (!docId) { console.warn("WEBHOOK: docId missing"); return res.status(200).end(); }

      const a = initAdminOrThrow();
      const db = a.firestore();

      await db.collection("pickup_bookings").doc(docId).set({
        paymentStatus: "Paid",
        cashStatus: "Received",
        paidAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    return res.status(200).end();
  } catch (e) {
    console.error("WEBHOOK_INTERNAL", e);
    return res.status(500).end();
  }
};
