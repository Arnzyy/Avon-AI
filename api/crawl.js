// /api/crawl.js
import * as cheerio from 'cheerio';
import { admin } from './_supabase.js';

const ABSOLUTE = /^(https?:)?\/\//i;

// crude helpers ----------------------------------------------------
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const toAbs = (base, href) => {
  try {
    if (!href) return null;
    if (ABSOLUTE.test(href)) return new URL(href).toString();
    return new URL(href, base).toString();
  } catch { return null; }
};

// grab £price from text
const parsePrice = (txt) => {
  if (!txt) return null;
  const m = txt.replace(/[, ]+/g,'').match(/£?(\d{3,7})/i);
  return m ? parseInt(m[1], 10) : null;
};

// infer simple attrs from title/snippet
const inferAttrs = (title, blob) => {
  const s = `${title ?? ''} ${blob ?? ''}`.toLowerCase();
  return {
    fuel: /diesel/.test(s) ? 'Diesel' : /petrol|gasoline/.test(s) ? 'Petrol' : undefined,
    ulez: /ulez|euro\s*6/.test(s) ? true : undefined
  };
};

// extract products from a listing page (generic)
function extractListings(html, baseUrl) {
  const $ = cheerio.load(html);
  const cards = [];

  // Try to find cards with <a> links to used cars; fall back to all anchors on page
  const anchors = $('a[href]').toArray();

  for (const a of anchors) {
    const href = $(a).attr('href');
    const abs = toAbs(baseUrl, href);
    if (!abs) continue;

    // accept links under same domain + likely vehicle paths
    if (!abs.startsWith(new URL(baseUrl).origin)) continue;
    if (!/used|cars|vehicle|stock/i.test(abs)) continue;

    // Title: anchor text or nearest heading
    let title = $(a).text().trim();
    if (!title) {
      title = $(a).closest('article,li,div').find('h2,h3,h4').first().text().trim();
    }
    if (!title) continue;              // require a title to avoid garbage

    // gather nearby text to hunt for price/attrs
    const cardRoot = $(a).closest('article,li,div').first();
    const textBlob = cardRoot.text().replace(/\s+/g, ' ').trim();
    const price = parsePrice(textBlob);

    cards.push({
      title,
      vdp_url: abs,
      price,
      attrs: inferAttrs(title, textBlob)
    });
  }

  // Deduplicate on vdp_url
  const dedup = new Map();
  for (const c of cards) {
    if (!dedup.has(c.vdp_url)) dedup.set(c.vdp_url, c);
  }
  return [...dedup.values()];
}

// -----------------------------------------------------------------

export default async function handler(req, res) {
  try {
    const dealer = (req.query.dealer || req.query.id || 'avon').toString().toLowerCase();
    const supa = admin();

    // 1) read dealer config
    const { data: dealerRow, error: dErr } = await supa
      .from('dealers')
      .select('id, site_url, list_paths, rep_apr, finance_apply_url')
      .eq('id', dealer)
      .single();

    if (dErr || !dealerRow) {
      return res.status(404).json({ ok: false, error: 'Dealer not found', details: dErr });
    }

    const siteBase = dealerRow.site_url.replace(/\/+$/, '');
    const paths = Array.isArray(dealerRow.list_paths) ? dealerRow.list_paths : [];

    if (!paths.length) {
      return res.status(400).json({ ok: false, error: 'Dealer has no list_paths configured.' });
    }

    let found = 0;
    for (const p of paths) {
      const url = toAbs(siteBase + '/', p);
      if (!url) continue;

      // polite delay
      await sleep(400);

      const resp = await fetch(url, { headers: { 'User-Agent': 'avon-ai-crawler/1.0' } });
      if (!resp.ok) continue;

      const html = await resp.text();
      const items = extractListings(html, url);

      // upsert into vehicles unique on vdp_url
      if (items.length) {
        const rows = items.map(v => ({
          dealer_id: dealerRow.id,
          vdp_url: v.vdp_url,
          title: v.title,
          price: v.price ?? null,
          attrs: v.attrs ?? {}
        }));

        const { error: upErr } = await supa
          .from('vehicles')
          .upsert(rows, { onConflict: 'vdp_url' });

        if (upErr) {
          console.error('Upsert error:', upErr);
        } else {
          found += rows.length;
        }
      }
    }

    return res.json({ ok: true, dealer, count: found });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}
