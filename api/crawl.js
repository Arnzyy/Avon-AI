// /api/crawl.js
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE; // write-safe key
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE env vars.');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE, {
  auth: { persistSession: false }
});

// --- utilities ---------------------------------------------------------------

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fetchHTML(url, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        headers: {
          'user-agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
            '(KHTML, like Gecko) Chrome/123.0 Safari/537.36'
        }
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      if (i === retries) throw err;
      await sleep(500 + i * 500);
    }
  }
}

function toAbs(base, href) {
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

function cleanPrice(str) {
  if (!str) return null;
  const m = String(str).replace(/,/g, '').match(/(\d{2,7})/);
  return m ? parseInt(m[1], 10) : null;
}

function boolFromText(html, term) {
  const rx = new RegExp(`\\b${term}\\b`, 'i');
  return rx.test(html);
}

function extractAttrsFromPage($, pageText) {
  const attrs = {};

  // Fuel
  if (/diesel/i.test(pageText)) attrs.fuel = 'Diesel';
  else if (/petrol/i.test(pageText)) attrs.fuel = 'Petrol';
  else if (/hybrid/i.test(pageText)) attrs.fuel = 'Hybrid';
  else if (/electric/i.test(pageText)) attrs.fuel = 'Electric';

  // Transmission
  if (/automatic|auto\b/i.test(pageText)) attrs.transmission = 'Auto';
  else if (/manual/i.test(pageText)) attrs.transmission = 'Manual';

  // ULEZ
  attrs.ulez = /\bULEZ\b|ultra low emission/i.test(pageText);

  // Mileage (best effort)
  const miles =
    pageText.match(/(\d{1,3}(?:,\d{3})+)\s*miles/i) ||
    pageText.match(/(\d{4,7})\s*miles/i);
  if (miles) attrs.mileage = miles[1];

  return attrs;
}

// Try to extract a decent title and price heuristically
function extractTitleAndPrice($) {
  const title =
    $('h1').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim() ||
    '';

  // Look for a price-looking element:
  let priceText =
    $('[class*="price"], .price, [data-price], .vehicle-price')
      .first()
      .text()
      .trim() || '';

  // fallback: scan all text for the first £... pattern
  if (!/£/.test(priceText)) {
    const page = $('body').text();
    const m = page.match(/£\s*\d{1,3}(?:,\d{3})+/);
    priceText = m ? m[0] : '';
  }

  const price = cleanPrice(priceText);
  return { title, price };
}

// --- core crawler ------------------------------------------------------------

async function crawlDealer(dealerId) {
  // 1) pull dealer config from DB
  const { data: dealer, error: dealerErr } = await supabase
    .from('dealers')
    .select('id, site_url, list_paths')
    .eq('id', dealerId)
    .single();

  if (dealerErr || !dealer) {
    throw new Error(
      `Dealer "${dealerId}" not found or db error: ${dealerErr?.message}`
    );
  }

  const base = dealer.site_url.endsWith('/')
    ? dealer.site_url
    : dealer.site_url + '/';

  const listPaths = Array.isArray(dealer.list_paths) ? dealer.list_paths : [];
  if (!listPaths.length) {
    throw new Error(`Dealer "${dealerId}" has no list_paths configured.`);
  }

  // 2) collect candidate VDP links from listing pages
  const vdpUrls = new Set();

  for (const path of listPaths) {
    const listUrl = toAbs(base, path);
    if (!listUrl) continue;

    try {
      const html = await fetchHTML(listUrl);
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        const href = $(a).attr('href');
        if (!href) return;
        const abs = toAbs(base, href);
        if (!abs) return;

        // Heuristic: only keep used vehicle detail pages
        // (adjust filter to match your site’s structure)
        if (
          /\/used\//i.test(abs) &&
          !/\.(png|jpg|jpeg|gif|webp|pdf|zip)$/i.test(abs)
        ) {
          vdpUrls.add(abs.split('#')[0]);
        }
      });
    } catch (err) {
      console.warn('List page error:', path, err.message);
    }
  }

  // 3) visit each VDP & extract data
  const rows = [];
  for (const url of vdpUrls) {
    try {
      const html = await fetchHTML(url);
      const $ = cheerio.load(html);
      const pageText = $('body').text().replace(/\s+/g, ' ');

      const { title, price } = extractTitleAndPrice($);
      const attrs = extractAttrsFromPage($, pageText);

      // Skip if we couldn't get a sensible title
      if (!title) continue;

      rows.push({
        dealer_id: dealerId,
        vdp_url: url,
        title,
        price: price ?? null,
        attrs
      });
    } catch (err) {
      console.warn('VDP error:', url, err.message);
    }
  }

  // 4) upsert into DB on vdp_url
  let upserted = 0;
  if (rows.length) {
    const { error: upErr, count } = await supabase
      .from('vehicles')
      .upsert(rows, {
        onConflict: 'vdp_url', // requires unique index on vehicles(vdp_url)
        ignoreDuplicates: false,
        count: 'exact'
      });
    if (upErr) throw upErr;
    upserted = count ?? rows.length;
  }

  return { found: rows.length, upserted };
}

// --- handler -----------------------------------------------------------------

export default async function handler(req, res) {
  try {
    const dealer = (req.query.dealer || 'avon').toString().trim();
    const out = await crawlDealer(dealer);
    res.status(200).json({ ok: true, dealer, ...out });
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ ok: false, error: err.message || 'crawl failed' });
  }
}
