// /api/crawl.js
// Crawl listing pages and upsert vehicle VDP URLs into Supabase.
//
// Notes:
// - Uses Cheerio ESM correctly: import { load } from "cheerio";
// - Reads dealer config (site_url, list_paths) from public.dealers if present.
// - Falls back to defaults for "avon" dealer.
// - Upserts into public.vehicles on conflict vdp_url.
// - Keep it simple: we record (dealer_id, vdp_url, title, attrs). Price/title can
//   be improved later once your selectors are finalized.

import { load } from "cheerio";
import { supabase } from "../lib/supabase.js"; // path from /api to /lib

// --- Fallback config for Avon Automotive (used if dealers row is missing) ---
const DEFAULT_DEALER = "avon";
const DEFAULT_SITE = "https://www.avon-automotive.com";
const DEFAULT_LIST_PATHS = [
  "/used/cars/bristol",
  "/used/cars",
  "/used" // belt-and-braces
];

// Helpful: normalize and build absolute URLs
const abs = (base, href) => {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
};

// Pick only /used/ vehicle-like links and normalize
function extractVDPUrls($, baseUrl) {
  const urls = new Set();

  // broad match for anything that looks like a used-vehicle link
  $('a[href*="/used/"]').each((_, a) => {
    const href = $(a).attr("href");
    const url = abs(baseUrl, href);
    if (!url) return;

    // optionally filter out listing pages if they have obvious patterns,
    // keep the test simple for now – we only dedupe later
    urls.add(url);
  });

  return [...urls];
}

// Extract a passable title from card/link, fallback to page <title>
function guessTitle($, linkEl, pageTitle) {
  const t =
    ($(linkEl).attr("title") || $(linkEl).text() || "").trim() ||
    (pageTitle || "").trim();
  return t || null;
}

export default async function handler(req, res) {
  try {
    const dealer = (req.query.dealer || DEFAULT_DEALER).toLowerCase();

    // 1) Try to load dealer config from DB
    let siteUrl = DEFAULT_SITE;
    let listPaths = DEFAULT_LIST_PATHS;

    const { data: dealerRow, error: dealerErr } = await supabase
      .from("dealers")
      .select("id, site_url, list_paths")
      .eq("id", dealer)
      .maybeSingle();

    if (dealerErr) {
      console.warn("[crawl] dealers fetch error:", dealerErr.message);
    }
    if (dealerRow) {
      siteUrl = dealerRow.site_url || siteUrl;
      if (Array.isArray(dealerRow.list_paths) && dealerRow.list_paths.length) {
        listPaths = dealerRow.list_paths;
      }
    }

    // 2) Crawl each listing path and collect candidate VDP URLs
    const headers = { "user-agent": "Mozilla/5.0 (compatible; AvonAI/1.0)" };
    const discovered = new Set();

    for (const path of listPaths) {
      const url = abs(siteUrl, path);
      if (!url) continue;

      const resp = await fetch(url, { headers });
      if (!resp.ok) {
        console.warn(`[crawl] listing fetch failed ${url} -> ${resp.status}`);
        continue;
      }

      const html = await resp.text();
      const $ = load(html);

      const pageUrls = extractVDPUrls($, siteUrl);
      pageUrls.forEach((u) => discovered.add(u));
    }

    const vdpUrls = [...discovered];

    // 3) Build rows to upsert
    // Try to get a shallow title by fetching the VDP quickly
    // (optional: you can skip titles entirely to make it faster)
    const rows = [];
    for (const url of vdpUrls) {
      let title = null;
      try {
        const vdpResp = await fetch(url, { headers });
        if (vdpResp.ok) {
          const html = await vdpResp.text();
          const $ = load(html);
          // basic guess: use the <title> tag
          title = ($("title").text() || "").trim() || null;
        }
      } catch {
        /* ignore VDP fetch errors; we still store URL */
      }

      rows.push({
        dealer_id: dealer,
        vdp_url: url,
        title,
        // You can add more fields as needed. price can stay null.
        attrs: { source: "crawl", dealer }
        // first_seen is handled by DB default (now())
      });
    }

    if (!rows.length) {
      return res.json({ ok: true, dealer, site: siteUrl, found: 0, upserted: 0 });
    }

    // 4) Upsert into vehicles on vdp_url uniqueness
    const { data: upserted, error: upsertErr } = await supabase
      .from("vehicles")
      .upsert(rows, { onConflict: "vdp_url" }) // unique index exists
      .select("vdp_url");

    if (upsertErr) {
      console.error("[crawl] upsert error:", upsertErr.message);
      return res.status(500).json({ ok: false, error: upsertErr.message });
    }

    return res.json({
      ok: true,
      dealer,
      site: siteUrl,
      found: vdpUrls.length,
      upserted: upserted?.length || 0
    });
  } catch (err) {
    console.error("[crawl] fatal:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
