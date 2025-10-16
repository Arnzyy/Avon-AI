// /api/env-check.js
export default function handler(req, res) {
  // Never print secret values — just booleans
  const hasUrl  = !!process.env.SUPABASE_URL;
  const hasRole = !!process.env.SUPABASE_SERVICE_ROLE_KEY;

  res.status(200).json({
    ok: true,
    supabase: {
      url_present: hasUrl,
      service_role_key_present: hasRole,
    }
  });
}
