import * as cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_ANON_KEY
);

const UA = { headers: { "User-Agent": "AvonCrawler/1.0" } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const re = { money: /£\s?([\d,]+(?:\.\d{1,2})?)/i, miles: /([\d,]+)\s*miles/i };
const pick = (t, rx) => (t.match(rx) || [])[1] || null;

export default async function handler(req, res) {
  try {
    const u = new URL(req.url, 'http://x');
    const dealerId = u.searchParams.get('dealer') || 'avon';
    const { data: d } = await sb.from('dealers').select('*').eq('id', dealerId).single();

    if (!d) return res.status(400).json({ ok: false, error: "Dealer not found" });

    const base = d.site_url.replace(/\/$/, '');
    const links = new Set();

    for (const path of d.list_paths || []) {
      const html = await (await fetch(base + path, UA)).text();
      const $ = cheerio.load(html);
      $('a[href]').each((_, a) => {
        const href = ($(a).attr('href') || '').trim();
        if (!href) return;
        const abs = href.startsWith('http') ? href : base + (href.startsWith('/') ? href : '/' + href);
        if (/\/used\/cars\//.test(abs) && !/[?&]page=/.test(abs)) links.add(abs);
      });
    }

    const items = [];

    for (const vdp of Array.from(links).slice(0, 250)) {
      try {
        await sleep(300);
        const page = await (await fetch(vdp, UA)).text();
        const $ = cheerio.load(page);
        const text = $.root().text().replace(/\s+/g, ' ');
        const title = ($('h1').first().text() || '').trim();
        const priceAttr = $('[itemprop="price"]').attr('content') || '';
        const priceMatch = priceAttr || pick(text, re.money) || '';
        const price = Number(String(priceMatch).replace(/,/g, ''));
        if (!title || !price || Number.isNaN(price)) continue;
        const mileage = Number((pick(text, re.miles) || '0').replace(/,/g, ''));
        const fuel = $('td:contains("Fuel Type")').next().text().trim() || (text.match(/(Petrol|Diesel|Hybrid|Electric)/i)?.[1] || '');
        const transmission = $('td:contains("Transmission")').next().text().trim() || (text.match(/(Manual|Automatic|Auto)/i)?.[1] || '');
        const ulez = /ULEZ\s*Compliant/i.test(text);
        items.push({ url: vdp, title, price, mileage, fuel, transmission, ulez });

        await sb.rpc('upsert_vehicle_from_crawl', {
          p_dealer: dealerId,
          p_vdp_url: vdp,
          p_title: title,
          p_price: price,
          p_attrs: { mileage, fuel, transmission, ulez }
        });
      } catch { }
    }

    await sb.from('inventory_snapshots').upsert(
      { dealer_id: dealerId, payload: items, updated_at: new Date().toISOString() },
      { onConflict: 'dealer_id' }
    );

    res.json({ ok: true, dealer: dealerId, count: items.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  }
}
