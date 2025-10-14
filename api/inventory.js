// /api/inventory.js
import { supabase } from '../../lib/supabase';

export default async function handler(req, res) {
  try {
    const dealer = (req.query.dealer || req.body?.dealer || 'avon').toString();
    const q = (req.query.q || req.body?.q || '').toString().trim();
    const max = Math.min(parseInt(req.query.max || '20', 10) || 20, 50);

    // Optional filters: price ceiling, ULEZ, fuel, transmission
    const priceMax = parseInt(req.query.priceMax || '', 10) || null;
    const wantUlez = req.query.ulez === '1' || req.query.ulez === 'true';
    const fuel = (req.query.fuel || '').toString().trim();           // e.g. "Diesel"
    const gearbox = (req.query.gearbox || '').toString().trim();     // e.g. "Auto"

    // Base
    let query = supabase
      .from('vehicles')
      .select('title, price, vdp_url, attrs, dealer_id')
      .eq('dealer_id', dealer);

    if (q) {
      // search in title (case-insensitive)
      query = query.ilike('title', `%${q}%`);
    }

    if (priceMax) query = query.lte('price', priceMax);
    if (wantUlez) query = query.eq('attrs->>ulez', 'true'); // JSONB filter
    if (fuel) query = query.ilike('attrs->>fuel', `%${fuel}%`);
    if (gearbox) query = query.ilike('attrs->>transmission', `%${gearbox}%`);

    query = query.order('price', { ascending: true }).limit(max);

    const { data, error } = await query;
    if (error) throw error;

    const results = (data || []).map(r => ({
      title: r.title,
      price: r.price ?? null,
      url: r.vdp_url,                   // **This is the actual VDP link**
      ulez: !!(r.attrs?.ulez),
      fuel: r.attrs?.fuel || null,
      transmission: r.attrs?.transmission || null,
      dealer: r.dealer_id,
    }));

    return res.json({ ok: true, count: results.length, results });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
