// /api/chat.js
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

async function searchInventory(message, dealer = DEFAULT_DEALER) {
  let query = supabase
    .from("vehicles")
    .select("dealer_id, vdp_url, title, price, attrs, first_seen", { count: "exact" })
    .eq("dealer_id", dealer)
    .order("first_seen", { ascending: false, nullsFirst: false })
    .limit(24);

  const tokens = parseQuery(message);
  for (const t of tokens) {
    query = query.or(`title.ilike.%${t}%,vdp_url.ilike.%${t}%`);
  }

  const { data, error, count } = await query;
  if (error) throw new Error(error.message);

  return { results: data || [], count: count ?? data?.length ?? 0 };
}

function formatResults(results, max = 8) {
  const take = results.slice(0, max);
  return take
    .map((r, i) => {
      const price =
        typeof r.price === "number"
          ? ` – £${r.price.toLocaleString()}`
          : "";
      const title = r.title || "View vehicle";
      return `${i + 1}. ${title}${price}\n   ${r.vdp_url}`;
    })
    .join("\n");
}

export default async function handler(req, res) {
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const message = String(body.message || body.q || "").trim();
    const dealer = (body.dealer || req.query.dealer || DEFAULT_DEALER).toLowerCase();

    if (!message) {
      return res.json({
        reply:
          "Hi! I can check stock at Avon Automotive. Ask me something like “Ford Ranger under £20k” or “electric cars in Bristol”."
      });
    }

    const { results, count } = await searchInventory(message, dealer);

    if (!count) {
      return res.json({
        reply:
          "I didn't find anything that matches that. Try a simpler search like “ranger”, “ford ranger”, or include a budget (e.g., “under £15k”)."
      });
    }

    const list = formatResults(results, 8);
    const preface =
      count > 8
        ? `I found ${count} matches. Here are the first ${Math.min(8, count)}:\n`
        : `I found ${count} ${count === 1 ? "match" : "matches"}:\n`;

    return res.json({ reply: `${preface}${list}` });
  } catch (e) {
    console.error("[chat] fatal:", e);
    return res.status(500).json({
      reply:
        "Sorry—something went wrong on my side. Try again with a simpler search, like “ranger” or “hybrid under 10k”."
    });
  }
}
