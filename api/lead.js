import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  try {
    const body = req.method === 'POST' ? JSON.parse(req.body || '{}') : {};
    const { dealer = 'avon', name, email, phone, source_url } = body;

    if (!name || !phone) {
      return res.status(400).json({ ok: false, error: "Name and phone required" });
    }

    // Link the lead to a specific vehicle if found
    let vehicleId = null;
    if (source_url) {
      const { data: v } = await sb
        .from('vehicles')
        .select('id')
        .eq('vdp_url', source_url)
        .single();
      vehicleId = v?.id || null;
    }

    const { data: lead, error } = await sb
      .from('leads')
      .insert({
        dealer_id: dealer,
        name,
        email,
        phone,
        source_url,
        vehicle_id: vehicleId,
        consent_bool: true
      })
      .select('*')
      .single();

    if (error) throw error;

    res.json({
      ok: true,
      lead_id: lead.id,
      vehicle_id: vehicleId
    });

  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
