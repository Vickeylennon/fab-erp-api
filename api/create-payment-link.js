// ...top of file unchanged...

module.exports = async (req, res) => {
  cors(res, req.headers.origin);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });

  try {
    const { docId } = req.body || {};
    if (!docId) return res.status(400).json({ error: "docId is required" });

    // ✅ Explicit env checks so the client gets a helpful message
    if (!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      return res.status(500).json({ error: "SERVER_MISCONFIG: Missing GOOGLE_APPLICATION_CREDENTIALS_JSON" });
    }
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
      return res.status(500).json({ error: "SERVER_MISCONFIG: Missing Razorpay keys" });
    }

    const a = initAdminOrThrow();
    const db = a.firestore();

    const key_id = process.env.RAZORPAY_KEY_ID;
    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    const rzp = new Razorpay({ key_id, key_secret });

    const ref = db.collection("pickup_bookings").doc(docId);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "booking not found" });

    const d = snap.data() || {};
    const amountNumber = d?.pickupDetails?.totalAmount ?? d?.totalAmount ?? 0;
    if (!amountNumber || isNaN(amountNumber)) {
      return res.status(400).json({ error: "invalid amount (pickupDetails.totalAmount or totalAmount)" });
    }
    if (String(d.status||"").toLowerCase() !== "delivered") {
      return res.status(400).json({ error: `invalid status: ${d.status}` });
    }

    const customerName = String(d?.Name ?? "Customer").trim();
    const mobile = String(d?.Mobile ?? "").replace(/[^\d]/g, "");
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
    return res.status(500).json({ error: String(e.message || "internal_error") });
  }
};
