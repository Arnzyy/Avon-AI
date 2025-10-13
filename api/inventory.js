// /api/inventory.js
import { admin } from './_supabase.js';

export default async function handler(req, res) {
  try {
    const dealer = (req.query.dealer || 'avon').toString().toLowerCase();
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit || '24', 10), 50);

    const supa = admin();

    // Base filter
    let query = supa.from('vehicles')
      .select('id, dealer_id, title, vdp_url, price, attrs')
      .eq('dealer_id', dealer)
      .order('price', { ascending: true })
      .limit(limit);

    // Full-text-ish search on title, uses (dealer_id,title) index you created
    if (q) query = query.ilike('title', `%${q}%`);

    const { data, error } = await query;
    if (error) return res.status(500).json({ ok: false, error });

    return res.json({ ok: true, results: data ?? [] });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
