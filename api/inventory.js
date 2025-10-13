// /api/inventory.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  // Server-side only — do NOT use the anon key here.
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false }, global: { headers: { 'x-application-name': 'avon-ai' } } }
);

function numberFromText(text) {
  // Pulls the largest number as a price (e.g. "under 15000" -> 15000)
  const nums = (text?.match(/\d{3,}/g) || []).map(n => parseInt(n, 10)).filter(Boolean);
  if (!nums.length) return null;
  return Math.max(...nums);
}

export default async function handler(req, res) {
  try {
    const { q = '', maxPrice, fuel, ulez } = req.query;

    // Base select
    let query = supabase
      .from('vehicles')
      .select('id, dealer_id, title, price, vdp_url, attrs', { count: 'exact' })
      .order('price', { ascending: true })
      .limit(50);

    // Simple text match against title
    if (q) query = query.ilike('title', `%${q}%`);

    // Max price: from query param or extract from text
    const cap = maxPrice ? Number(maxPrice) : numberFromText(q);
    if (cap) query = query.lte('price', cap);

    // Filter by fuel if provided (works with jsonb "attrs" column)
    if (fuel) query = query.ilike('attrs->>fuel', `%${fuel}%`);

    // Filter by ULEZ if provided (expects boolean-ish in attrs.ulez)
    if (ulez === 'true') query = query.eq('attrs->>ulez', 'true');
    if (ulez === 'false') query = query.eq('attrs->>ulez', 'false');

    const { data, error } = await query;
    if (error) throw error;

    const results = (data || []).map(row => ({
      id: row.id,
      title: row.title,
      price: row.price,
      url: row.vdp_url,              // <- your real VDP URL
      fuel: row?.attrs?.fuel ?? null,
      transmission: row?.attrs?.transmission ?? null,
      ulez: row?.attrs?.ulez ?? null,
      dealer_id: row.dealer_id
    }));

    return res.status(200).json({ ok: true, count: results.length, results });
  } catch (err) {
    console.error('inventory error', err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
