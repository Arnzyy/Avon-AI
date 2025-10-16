// /api/crawl.js
import * as cheerio from 'cheerio';
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

/** Map slug->dealer config */
const DEALERS = {
  avon: {
    id: 'avon',
    listUrls: [
      'https://www.avon-automotive.com/used/cars',  // page 1
      // add more pages if needed
    ],
    // selectors may change—tweak if site markup differs
    selectors: {
      card: '.vehicle-card, .stocklist__item, .card',
      title: '.vehicle-title, .stocklist__title, h3, .card__title',
      price: '.vehicle-price, .stocklist__price, .price, .card__price',
      link: 'a[href]'
    }
  }
};

// basic normalization that helps “ranger” match “Ford Ranger”
function normalizeTitle(title) {
  const t = title.toLowerCase();
  if (t.includes('ranger') && !t.includes('ford')) return `Ford ${title}`;
  return title;
}

async function crawlDealer(dealer) {
  const out = [];

  for (const url of dealer.listUrls) {
    const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }});
    if (!res.ok) {
      console.warn('Fetch failed', url, res.status);
      continue;
    }
    const html = await res.text();
    const $ = cheerio.load(html);

    $(dealer.selectors.card).each((_, el) => {
      const titleRaw =
        $(el).find(dealer.selectors.title).text().trim() ||
        $(el).find('h3').text().trim();

      if (!titleRaw) return;

      const title = normalizeTitle(titleRaw);
      const priceText =
        $(el).find(dealer.selectors.price).text().trim() || '';
      const vdpRel = $(el).find(dealer.selectors.link).attr('href') || '';
      const vdp_url = vdpRel.startsWith('http')
        ? vdpRel
        : new URL(vdpRel, url).toString();

      // parse number out of price string
      const match = priceText.replace(/[,£]/g, '').match(/\d{3,}/);
      const price = match ? parseInt(match[0], 10) : null;

      out.push({
        dealer_id: dealer.id,
        vdp_url,
        title,
        price,
        attrs: { source_url: url, price_text: priceText }
      });
    });
  }

  return out;
}

async function upsertVehicles(rows) {
  if (!rows.length) return { inserted: 0 };
  // batch to avoid payload limits
  const batchSize = 500;
  let inserted = 0;

  for (let i = 0; i < rows.length; i += batchSize) {
    const slice = rows.slice(i, i + batchSize);
    const { error, count } = await supabase
      .from('vehicles')
      .upsert(slice, { onConflict: 'vdp_url', ignoreDuplicates: false, count: 'exact' });

    if (error) throw error;
    inserted += count || 0;
  }

  return { inserted };
}

export default async function handler(req, res) {
  try {
    const dealerKey = (req.query.dealer || 'avon').toLowerCase();
    const dealer = DEALERS[dealerKey];
    if (!dealer) return res.status(400).json({ ok: false, error: 'Unknown dealer' });

    const rows = await crawlDealer(dealer);
    const summary = await upsertVehicles(rows);

    return res.status(200).json({
      ok: true,
      dealer: dealerKey,
      found: rows.length,
      inserted: summary.inserted
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message });
  }
}
