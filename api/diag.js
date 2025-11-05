module.exports = async (req, res) => {
  const out = { ok: true, checks: {} };

  // Check env presence (no values leaked)
  out.checks.env = {
    HAS_GCP_JSON: !!process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON,
    HAS_RZP_ID: !!process.env.RAZORPAY_KEY_ID,
    HAS_RZP_SECRET: !!process.env.RAZORPAY_KEY_SECRET
  };

  // Try JSON parse (caught)
  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
      out.checks.gcp_json_parse = "ok";
    } else {
      out.checks.gcp_json_parse = "missing";
    }
  } catch (e) {
    out.checks.gcp_json_parse = "parse_error";
    out.error_parse = String(e.message || e);
  }

  // Try require modules
  try { require.resolve("firebase-admin"); out.checks.firebase_admin = "found"; } 
  catch (e) { out.checks.firebase_admin = "MODULE_NOT_FOUND"; }

  try { require.resolve("razorpay"); out.checks.razorpay = "found"; }
  catch (e) { out.checks.razorpay = "MODULE_NOT_FOUND"; }

  // Optionally try to init firebase-admin
  try {
    if (process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON) {
      const admin = require("firebase-admin");
      if (!admin.apps.length) {
        const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS_JSON);
        admin.initializeApp({ credential: admin.credential.cert(creds) });
      }
      await require("firebase-admin").firestore().listCollections(); // light ping
      out.checks.firestore = "ok";
    } else {
      out.checks.firestore = "skipped";
    }
  } catch (e) {
    out.checks.firestore = "error";
    out.error_firestore = String(e.message || e);
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  return res.status(200).json(out);
};
