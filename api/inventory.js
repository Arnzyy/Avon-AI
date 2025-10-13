// /api/inventory.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

function numberFromText(text) {
  const nums = (text?.match(/\d{3,}/g) || []).map(n => parseInt(n, 10)).filter(Boolean);
  return nums.length ? Math.max(...nums) : null;
}

export default async function handler(req, res) {
  try {
    const { q = '' } = req.query;

    let query = supabase
      .from('vehicles')
      .select('id, dealer_id, title, price, vdp_url, attrs', { count: 'exact' })
      .order('price', { ascending: true })
      .limit(50);

    // Search by text in title
    if (q) query = query.ilike('title', `%${q}%`);

    // Optional: detect "under £..." queries
    const cap = numberFromText(q);
    if (cap) query = query.lte('price', cap);

    const { data, error } = await query;
    if (error) throw error;

    const results = (data || []).map(row => ({
      id: row.id,
      title: row.title,
      price: row.price,
      url: row.vdp_url,
      dealer: row.dealer_id,
      fuel: row.attrs?.fuel || null,
      ulez: row.attrs?.ulez || null,
      mileage: row.attrs?.mileage || null
    }));

    return res.status(200).json({ ok: true, results });
  } catch (err) {
    console.error('inventory error', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
