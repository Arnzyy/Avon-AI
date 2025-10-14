// api/inventory.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE // needs read access
);

function sanitizeIlike(str = '') {
  // escape % and _ so they behave as literals
  return str.replace(/[%_]/g, s => '\\' + s);
}

export default async function handler(req, res) {
  try {
    const dealer = (req.query.dealer || 'avon').toLowerCase();
    const q = (req.query.q || '').trim();

    let query = supabase
      .from('vehicles')
      .select('id,dealer_id,vdp_url,title,price,attrs,first_seen_at', { count: 'exact' })
      .eq('dealer_id', dealer)
      .order('first_seen_at', { ascending: false })
      .limit(50);

    if (q) {
      const s = sanitizeIlike(q);
      // Search across title, URL and attrs make/model
      // NOTE: Supabase .or() uses comma-separated filters
      query = query.or(
        [
          `title.ilike.%${s}%`,
          `vdp_url.ilike.%${s}%`,
          `attrs->>make.ilike.%${s}%`,
          `attrs->>model.ilike.%${s}%`
        ].join(',')
      );
    }

    const { data, error, count } = await query;
    if (error) throw error;

    const results = (data || []).map(row => ({
      title: row.title,
      price: row.price,
      url: row.vdp_url,
      ulez: row?.attrs?.ulez ?? null,
      fuel: row?.attrs?.fuel ?? null,
      transmission: row?.attrs?.transmission ?? null,
      dealer: row.dealer_id
    }));

    res.status(200).json({ ok: true, dealer, count, results });
  } catch (err) {
    console.error('inventory error:', err);
    res.status(200).json({
      ok: false,
      error: err.message || String(err)
    });
  }
}
