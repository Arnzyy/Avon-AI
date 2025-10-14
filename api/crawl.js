// /api/crawl.js
import * as cheerio from 'cheerio';
import { supabase } from '../../lib/supabase';

const MAX_PAGES = parseInt(process.env.CRAWL_MAX_PAGES || '5', 10);

/**
 * Very small fetch with retry (handle brief timeouts).
 */
async function getHtml(url, tries = 3) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; AvonBot/1.0)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      await new Promise(r => setTimeout(r, 400 + i * 600));
    }
  }
  throw lastErr;
}

/**
 * Parse one listing page -> array of VDP links.
 * We try several reasonable selectors to be resilient.
 */
function extractCardLinks($, base) {
  const links = new Set();

  // Most common: each card contains a heading link
  $('a[href*="/used/"]').each((_, a) => {
    const href = $(a).attr('href') || '';
    // Only keep DETAIL pages, not category pages
    // Detail pages typically look like .../used/.../<id> or .../used/.../<slug>
    if (/\/used\//.test(href) && !/\/used\/(cars|vans|vehicles)\/?$/.test(href)) {
      const abs = href.startsWith('http') ? href : new URL(href, base).href;
      links.add(abs);
    }
  });

  return [...links];
}

/**
 * Given a vehicle detail page, extract structured data.
 */
function parseVDP($, url) {
  const textAll = $('body').text().replace(/\s+/g, ' ').toLowerCase();

  // Title
  let title =
    $('h1, .vehicle-title, .title, .heading').first().text().trim() ||
    $('meta[property="og:title"]').attr('content') ||
    $('title').text().trim();

  // Price
  let priceText =
    $('[class*="price"], .price, .vehicle-price, .heading-price')
      .first()
      .text()
      .replace(/[, ]/g, '') || '';

  // fallback: some dealers keep price in meta
  if (!/\d/.test(priceText)) {
    priceText = $('meta[itemprop="price"]').attr('content') || '';
  }

  const price = parseInt((priceText.match(/(\d{3,})/) || [])[1] || '0', 10) || null;

  // ULEZ (best-effort detection)
  const ulez =
    /ulez/.test(textAll) && !/non[- ]?compliant/.test(textAll)
      ? true
      : /ulez\s*(?:compliant|yes|✓|✔)/.test(textAll);

  // Fuel (best-effort)
  let fuel =
    (/electric|ev/i.test(textAll) && 'Electric') ||
    (/hybrid/i.test(textAll) && 'Hybrid') ||
    (/diesel/i.test(textAll) && 'Diesel') ||
    (/petrol|gasoline/i.test(textAll) && 'Petrol') ||
    null;

  // Gearbox (best-effort)
  let transmission =
    (/auto(matic)?/i.test(textAll) && 'Auto') ||
    (/manual/i.test(textAll) && 'Manual') ||
    null;

  // Mileage
  const mileageMatch = textAll.match(/(\d{1,3}(?:,\d{3})+|\d{4,})\s*(miles|mi|ml|km)/i);
  let mileage = null;
  if (mileageMatch) {
    mileage = parseInt(mileageMatch[1].replace(/,/g, ''), 10);
  }

  // attrs json
  const attrs = {
    fuel,
    transmission,
    ulez: !!ulez,
    mileage,
  };

  return { title, price, attrs, vdp_url: url };
}

/**
 * Crawl a single list path (pagination supported, up to MAX_PAGES).
 */
async function crawlListPath(baseUrl, listPath, dealerId) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const url = new URL(listPath, baseUrl);
    // If your site uses query pagination, add here (e.g., ?page=2)
    if (page > 1) url.searchParams.set('page', String(page));

    let html;
    try {
      html = await getHtml(url.href);
    } catch (e) {
      // Stop paginating if we get errors after first page
      if (page === 1) throw e;
      break;
    }

    const $ = cheerio.load(html);
    const vdpLinks = extractCardLinks($, baseUrl);

    // If no links on page 1 => this path likely invalid
    if (!vdpLinks.length) {
      if (page === 1) {
        // allow continuing next path
      }
      break;
    }

    // Visit each VDP and extract details
    for (const vdp of vdpLinks) {
      try {
        const vdpHtml = await getHtml(vdp);
        const $$ = cheerio.load(vdpHtml);
        const rec = parseVDP($$, vdp);

        if (rec.title && rec.vdp_url) {
          out.push({
            dealer_id: dealerId,
            vdp_url: rec.vdp_url,
            title: rec.title,
            price: rec.price,
            attrs: rec.attrs,
          });
        }
      } catch {
        // ignore one-off failures
      }
    }
  }
  return out;
}

export default async function handler(req, res) {
  try {
    const dealer = (req.query.dealer || req.body?.dealer || 'avon').toString();

    // 1) get this dealer's list paths from DB
    const { data: dealerRow, error: dealerErr } = await supabase
      .from('dealers')
      .select('id, site_url, list_paths')
      .eq('id', dealer)
      .single();

    if (dealerErr || !dealerRow) {
      return res.status(404).json({ ok: false, error: 'Dealer not found' });
    }

    const baseUrl = dealerRow.site_url;
    const listPaths = Array.isArray(dealerRow.list_paths) ? dealerRow.list_paths : [];

    if (!listPaths.length) {
      return res.status(400).json({ ok: false, error: 'Dealer has no list_paths' });
    }

    // 2) Crawl each path
    let all = [];
    for (const p of listPaths) {
      const batch = await crawlListPath(baseUrl, p, dealer);
      all = all.concat(batch);
    }

    if (!all.length) {
      return res.json({ ok: true, dealer, upserted: 0, note: 'No stock discovered' });
    }

    // 3) Upsert to vehicles (unique on vdp_url)
    const now = new Date().toISOString();

    // Upsert in small chunks to avoid payload limits
    const chunkSize = 100;
    let upserted = 0;

    for (let i = 0; i < all.length; i += chunkSize) {
      const chunk = all.slice(i, i + chunkSize).map(v => ({
        ...v,
        first_seen: now,           // if col exists it will keep earliest via SQL default/trigger
        last_seen: now,
      }));

      const { error } = await supabase
        .from('vehicles')
        .upsert(chunk, { onConflict: 'vdp_url' }); // IMPORTANT: unique on vdp_url

      if (error) {
        // continue next chunk; log error
        console.error('upsert error', error);
      } else {
        upserted += chunk.length;
      }
    }

    return res.json({ ok: true, dealer, upserted });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: String(err?.message || err) });
  }
}
