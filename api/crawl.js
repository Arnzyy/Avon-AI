// /api/crawl.js
import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

// ----- Environment validation (clear errors instead of cryptic crash) -----
const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

function envOrThrow(name, value) {
  if (!value || String(value).trim() === '') {
    // Surface which var is missing right in the response/logs
    throw new Error(`Missing environment variable: ${name}`);
  }
  return value;
}

const url = envOrThrow('SUPABASE_URL', SUPABASE_URL);
// You can use ANON or SERVICE ROLE — this code expects SERVICE ROLE.
// If you prefer ANON, just pass SUPABASE_ANON_KEY below and ensure RLS allows it.
const key = envOrThrow('SUPABASE_SERVICE_ROLE_KEY', SUPABASE_SERVICE_ROLE_KEY);

const supabase = createClient(url, key, {
  auth: { persistSession: false },
  // Make sure the client uses the same fetch as the runtime (Node 18 has global fetch)
  global: { fetch },
});

/** Dealer configuration */
const DEALERS = {
  avon: {
    id: 'avon',
    listUrls: [
      'https://www.avon-automotive.com/used/cars',
      // Add ?page=2,3... here if you want more pages
    ],
    selectors: {
      card: '.vehicle-card, .stocklist__item, .card',
      title: '.vehicle-title, .stocklist__title, h3, .card__title',
      price: '.vehicle-price, .stocklist__price, .price, .card__price',
      link: 'a[href]',
    },
  },
};

// Normalize helps “ranger” search match “Ford Ranger”
function normalizeTitle(title) {
  const t = title.toLowerCase();
  if (t.includes('ranger') && !t.includes('ford')) return `Ford ${title}`;
  return title;
}

async function crawlDealer(dealer) {
  const out = [];

  for (const url of dealer.listUrls) {
    let res;
    try {
      res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
    } catch (e) {
      console.warn('Fetch error:', url, e?.message || e);
      continue;
    }

    if (!res.ok) {
      console.warn('Fetch failed', url, res.status);
      continue;
    }

    const html = await res.text();
    const $ = cheerio.load(html);

    $(dealer.selectors.card).each((_, el) => {
      const titleRaw =
        $(el).find(dealer.selectors.title).first().text().trim() ||
        $(el).find('h3').first().text().trim();

      if (!titleRaw) return;

      const title = normalizeTitle(titleRaw);

      const priceText = $(el).find(dealer.selectors.price).first().text().trim() || '';
      const href = $(el).find(dealer.selectors.link).attr('href') || '';
      const vdp_url = href.startsWith('http') ? href : new URL(href, url).toString();

      // parse number out of price string
      const match = priceText.replace(/[,£]/g, '').match(/\d{3,}/);
      const price = match ? parseInt(match[0], 10) : null;

      out.push({
        dealer_id: dealer.id,
        vdp_url,
        title,
        price,
        attrs: { source_url: url, price_text: priceText },
      });
    });
  }

  return out;
}

async function upsertVehicles(rows) {
  if (!rows.length) return { inserted: 0 };

  // Upsert in batches to avoid payload limits
  const batchSize = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);

    const { error, count } = await supabase
      .from('vehicles')
      .upsert(slice, {
        onConflict: 'vdp_url', // requires a unique index/constraint on vdp_url
        ignoreDuplicates: false,
        count: 'exact',
      });

    if (error) {
      // surface the DB error so you can see it in Vercel logs
      throw new Error(`Supabase upsert failed: ${error.message}`);
    }

    inserted += count || 0;
  }

  return { inserted };
}

export default async function handler(req, res) {
  try {
    const dealerKey = String(req.query.dealer || 'avon').toLowerCase();
    const dealer = DEALERS[dealerKey];
    if (!dealer) return res.status(400).json({ ok: false, error: 'Unknown dealer' });

    const rows = await crawlDealer(dealer);
    const summary = await upsertVehicles(rows);

    return res.status(200).json({
      ok: true,
      dealer: dealerKey,
      found: rows.length,
      inserted: summary.inserted,
    });
  } catch (err) {
    console.error('[crawl] error:', err);
    return res.status(500).json({
      ok: false,
      error: err?.message || String(err),
    });
  }
}
