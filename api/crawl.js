// /api/crawl.js
import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

// Helper to normalize strings
const clean = (txt) =>
  txt?.replace(/\s+/g, ' ').replace(/£|,/g, '').trim() || null;

// --- MAIN HANDLER ---
export default async function handler(req, res) {
  const dealer = (req.query.dealer || '').toLowerCase();
  if (!dealer)
    return res.status(400).json({ ok: false, error: 'Missing ?dealer=' });

  try {
    // 1️⃣ Fetch dealer configuration
    const { data: dealers, error: dealerErr } = await supabase
      .from('dealers')
      .select('id, site_url, list_paths')
      .eq('id', dealer)
      .limit(1);

    if (dealerErr || !dealers?.length)
      throw new Error(`Dealer not found: ${dealer}`);

    const d = dealers[0];
    const base = d.site_url.replace(/\/$/, '');
    const listPaths = Array.isArray(d.list_paths)
      ? d.list_paths
      : JSON.parse(d.list_paths || '[]');

    let vehicles = [];

    // 2️⃣ Fetch each list page and scrape
    for (const path of listPaths) {
      const listUrl = `${base}${path}`;
      console.log(`Crawling ${listUrl}`);
      const html = await fetch(listUrl).then((r) => r.text());
      const $ = cheerio.load(html);

      $('a[href*="/used/"]').each((_, el) => {
        const href = $(el).attr('href');
        if (!href) return;

        // Construct full URL
        const vdpUrl = href.startsWith('http') ? href : `${base}${href}`;

        const title = clean($(el).text()) || 'Used Vehicle';
        if (!vdpUrl.includes('/used/')) return;

        // Infer make/model from URL
        let make = null;
        let model = null;
        try {
          const u = new URL(vdpUrl);
          const parts = u.pathname.split('/').filter(Boolean); // e.g. ['used','ford','ranger','bristol']

          const usedIdx = parts.findIndex((p) => p === 'used');
          const maybeMake = parts[usedIdx + 1];
          const maybeModel = parts[usedIdx + 2];

          const slugToName = (s) =>
            (s || '').replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
          const isLocationLike = (s) =>
            /bristol|avon|bath|swindon|gloucester/i.test(s || '');

          if (maybeMake && !isLocationLike(maybeMake))
            make = slugToName(maybeMake);
          if (maybeModel && !isLocationLike(maybeModel))
            model = slugToName(maybeModel);
        } catch (e) {
          // ignore errors
        }

        vehicles.push({
          dealer_id: dealer,
          vdp_url: vdpUrl,
          title,
          price: null,
          attrs: {
            ulez: null,
            fuel: null,
            mileage: null,
            make,
            model,
          },
        });
      });
    }

    console.log(`Found ${vehicles.length} potential vehicles`);

    // 3️⃣ Fetch individual pages for details
    for (let v of vehicles) {
      try {
        const html = await fetch(v.vdp_url).then((r) => r.text());
        const $ = cheerio.load(html);

        const text = $.text();

        // Extract details
        const priceMatch = text.match(/£\s?([\d,]+)/);
        const fuelMatch = text.match(/(Diesel|Petrol|Electric|Hybrid)/i);
        const mileageMatch = text.match(/([\d,]+)\s*miles/i);
        const ulezMatch = /ULEZ/i.test(text);

        v.price = priceMatch ? parseInt(priceMatch[1].replace(/,/g, '')) : null;
        v.attrs.fuel = fuelMatch ? fuelMatch[1] : v.attrs.fuel;
        v.attrs.mileage = mileageMatch
          ? parseInt(mileageMatch[1].replace(/,/g, ''))
          : v.attrs.mileage;
        v.attrs.ulez = ulezMatch;
      } catch (e) {
        console.warn(`Failed to parse ${v.vdp_url}`, e.message);
      }
    }

    // 4️⃣ Upsert into Supabase
    const { error: upErr, count } = await supabase
      .from('vehicles')
      .upsert(vehicles, { onConflict: 'vdp_url', ignoreDuplicates: false })
      .select('*');

    if (upErr) throw upErr;

    return res.json({
      ok: true,
      dealer,
      upserted: vehicles.length,
      message: 'Crawl completed successfully',
    });
  } catch (err) {
    console.error(err);
    return res.status(200).json({ ok: false, error: err.message });
  }
}
