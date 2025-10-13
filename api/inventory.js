// /api/inventory.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY, // read-only is fine here
  { auth: { persistSession: false } }
);

export default async function handler(req, res) {
  try {
    const dealer = (req.query.dealer || 'avon').toString().trim();
    const q = (req.query.q || '').toString().trim();
    const limit = Math.min(parseInt(req.query.limit || '25', 10), 100);

    let query = supabase
      .from('vehicles')
      .select('id, dealer_id, vdp_url, title, price, attrs')
      .eq('dealer_id', dealer)
      .order('price', { ascending: true })
      .limit(limit);

    if (q) {
      // simple keyword search
      query = query.or(
        `title.ilike.%${q}%,attrs->>fuel.ilike.%${q}%,attrs->>transmission.ilike.%${q}%`
      );
    }

    const { data, error } = await query;
    if (error) throw error;

    const results = (data || []).map((v) => ({
      title: v.title,
      price: v.price,
      url: v.vdp_url,
      attrs: v.attrs || {},
      ulez: !!(v.attrs && v.attrs.ulez)
    }));

    res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ ok: false, error: err.message || 'inventory error', results: [] });
  }
}
