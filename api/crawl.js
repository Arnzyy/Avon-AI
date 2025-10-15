// /api/crawl.js
// Node 18 / ESM (package.json has "type": "module")

import { load } from "cheerio";
import { createClient } from "@supabase/supabase-js";

// --------- Config ---------
const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE,     // service key for write
  CRON_KEY,                  // optional shared secret for the endpoint
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false },
});

// Small utility to sleep between fetches (be kind to the dealer site)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Normalise text -> integer (price / mileage)
function toInt(text) {
  if (!text) return null;
  const m = String(text).replace(/[,£]/g, "").match(/\d+/g);
  if (!m) return null;
  return parseInt(m.join(""), 10);
}

// Safe fetch with proper UA
async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      "user-agent":
        "Mozilla/5.0 (compatible; AvonAI/1.0; +https://avon-ai.vercel.app)",
      accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) {
    throw new Error(`Fetch failed ${res.status} for ${url}`);
  }
  return await res.text();
}

// Extract VDP links from a listing page
function extractVdpLinks(listHtml, baseUrl) {
  const $ = cheerio.load(listHtml);
  const hrefs = new Set();

  // 1) Anchors that look like used car detail pages
  $("a[href]").each((_, a) => {
    let href = $(a).attr("href");
    if (!href) return;

    // Make absolute
    if (href.startsWith("/")) {
      href = new URL(href, baseUrl).href;
    } else if (!href.startsWith("http")) {
      // relative like "./detail"
      try {
        href = new URL(href, baseUrl).href;
      } catch {
        return;
      }
    }

    // Heuristic: your site uses /used/ in VDPs
    if (/\/used\//i.test(href)) {
      hrefs.add(href.split("#")[0]);
    }
  });

  return Array.from(hrefs);
}

// Extract data from a VDP page (best-effort & resilient)
function extractVehicleFromVdp(html, vdpUrl) {
  const $ = load(html);

  // Title: og:title or h1 fallback
  const ogTitle = $('meta[property="og:title"]').attr("content");
  const title = (ogTitle || $("h1").first().text() || "").trim();

  // Price: common patterns on dealer sites
  let priceText =
    $('meta[itemprop="price"]').attr("content") ||
    $('[data-test="price"]').text() ||
    $('[class*="price"]').first().text() ||
    $("body").text();
  const price = toInt(priceText);

  // Mileage (not all pages have)
  const mileageText =
    $('[class*="mileage"]').first().text() ||
    $("body:contains('miles')").text().match(/[\d,]+\s*miles/i)?.[0];
  const mileage = toInt(mileageText);

  // Fuel (simple heuristics)
  let fuel = null;
  const bodyText = $("body").text().toLowerCase();
  if (bodyText.includes("diesel")) fuel = "Diesel";
  else if (bodyText.includes("petrol")) fuel = "Petrol";
  else if (bodyText.includes("electric")) fuel = "Electric";
  else if (bodyText.includes("hybrid")) fuel = "Hybrid";

  // ULEZ (simple contains)
  const ulez = /ulez/i.test(html);

  return {
    vdp_url: vdpUrl,
    title: title || null,
    price: price ?? null,
    attrs: {
      fuel: fuel ?? null,
      mileage: mileage ?? null,
      ulez: ulez,
    },
  };
}

// Upsert a single vehicle into public.vehicles
async function upsertVehicle(dealerId, vehicle) {
  // Ensure the payload matches your table columns
  const row = {
    dealer_id: dealerId,
    vdp_url: vehicle.vdp_url,
    title: vehicle.title,
    price: vehicle.price,
    attrs: vehicle.attrs ?? {},
  };

  const { error } = await supabase
    .from("vehicles")
    .upsert(row, { onConflict: "dealer_id,vdp_url" })
    .select("id")
    .single();

  if (error) throw error;
}

// Get dealer record (or all) from Supabase
async function getDealer(dealerId) {
  const { data, error } = await supabase
    .from("dealers")
    .select("id, site_url, list_paths, rep_apr, finance_apply_url")
    .eq("id", dealerId)
    .single();

  if (error) throw error;
  if (!data || !data.list_paths || data.list_paths.length === 0) {
    throw new Error(`Dealer ${dealerId} is missing list_paths`);
  }
  return data;
}

// --------- API Handler ---------
export default async function handler(req, res) {
  try {
    // Allow GET only
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method Not Allowed" });
    }

    // Simple auth (optional)
    const key = req.query.key || req.headers["x-cron-key"];
    if (CRON_KEY && key !== CRON_KEY) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const dealerId = (req.query.dealer || "avon").toLowerCase();

    // 1) Read dealer config
    const dealer = await getDealer(dealerId);

    let totalFound = 0;
    let totalUpserts = 0;
    const allVdps = new Set();

    // 2) Crawl each listing path
    for (const path of dealer.list_paths) {
      const listUrl = new URL(path, dealer.site_url).href;

      let html;
      try {
        html = await fetchHtml(listUrl);
      } catch (err) {
        console.error("List fetch failed:", listUrl, err.message);
        continue;
      }

      const links = extractVdpLinks(html, dealer.site_url);
      links.forEach((u) => allVdps.add(u));

      // Small delay between listing pages
      await sleep(300);
    }

    totalFound = allVdps.size;

    // 3) Visit each VDP and upsert
    for (const vdp of allVdps) {
      try {
        const vdpHtml = await fetchHtml(vdp);
        const vehicle = extractVehicleFromVdp(vdpHtml, vdp);
        await upsertVehicle(dealerId, vehicle);
        totalUpserts += 1;
      } catch (err) {
        console.error("VDP failed:", vdp, err.message);
      }
      // avoid hammering the site
      await sleep(350);
    }

    return res.status(200).json({
      ok: true,
      dealer: dealerId,
      totalFound,
      totalUpserts,
    });
  } catch (err) {
    console.error("crawl error", err);
    return res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
