import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

export default async function handler(req, res) {
  try {
    const body = req.method === "POST" ? JSON.parse(req.body || "{}") : {};
    const dealer = body.dealer || 'avon';

    // get the latest crawled stock snapshot
    const { data, error } = await sb
      .from('inventory_snapshots')
      .select('payload')
      .eq('dealer_id', dealer)
      .single();

    if (error) return res.status(500).json({ ok:false, error: String(error.message) });

    let results = data?.payload || [];
    const toLower = v => String(v || '').toLowerCase();

    const { q, make, maxPrice, fuel, transmission, ulez } = body;

    if (q) results = results.filter(v => toLower(v.title).includes(toLower(q)));
    if (make) results = results.filter(v => toLower(v.title).includes(toLower(make)));
    if (maxPrice) results = results.filter(v => (v.price || 0) <= Number(maxPrice));
    if (fuel) results = results.filter(v => toLower(v.fuel) === toLower(fuel));
    if (transmission) results = results.filter(v => toLower(v.transmission) === toLower(transmission));
    if (typeof ulez === 'boolean') results = results.filter(v => !!v.ulez === ulez);

    res.json(results.slice(0, 12)); // return up to 12 matches
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
}
