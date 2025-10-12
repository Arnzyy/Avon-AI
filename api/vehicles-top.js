import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  try {
    const { data, error } = await sb
      .from('v_vehicle_lead_stats')
      .select('*')
      .order('leads_per_day', { ascending: false })
      .limit(25);

    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
}
