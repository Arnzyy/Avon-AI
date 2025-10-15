// /api/inventory.js
import { supabase } from "../lib/supabase.js";

const DEFAULT_DEALER = "avon";

function parseQuery(q) {
  if (!q) return [];
  return q
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

export default async function handler(req, res) {
  try {
    const dealer = (req.query.dealer || DEFAULT_DEALER).toLowerCase();
    const q = (req.query.q || "").trim();

    // If nothing provided, just show newest
    let query = supabase
      .from("vehicles")
      .select("dealer_id, vdp_url, title, price, attrs, first_seen", { count: "exact" })
      .eq("dealer_id", dealer)
      .order("first_seen", { ascending: false, nullsFirst: false })
      .limit(24);

    const tokens = parseQuery(q);
    for (const t of tokens) {
      // Each token must appear EITHER in title OR vdp_url
      // Multiple .or() calls are ANDed with the previous filters in Supabase
      query = query.or(`title.ilike.%${t}%,vdp_url.ilike.%${t}%`);
    }

    const { data, error, count } = await query;
    if (error) {
      console.error("[inventory] error:", error.message);
      return res.status(500).json({ ok: false, error: error.message });
    }

    return res.json({
      ok: true,
      dealer,
      q,
      count: count ?? data?.length ?? 0,
      results: (data || []).map((r) => ({
        title: r.title || null,
        url: r.vdp_url,
        price: r.price ?? null,
        attrs: r.attrs || null,
        first_seen: r.first_seen || null
      }))
    });
  } catch (e) {
    console.error("[inventory] fatal:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
