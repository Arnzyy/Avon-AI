// /api/crawl.js
import cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

// --- Supabase client from env ---
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const supabaseAnon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseAnon) {
  throw new Error('Supabase URL or ANON key missing in environment.');
}
const supabase = createClient(supabaseUrl, supabaseAnon);

// --- small helpers ---
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const asJsonArray = (v) => {
  if (Array.isArray(v)) return v;
  if (!v) return [];
  try { return JSON.parse(v); } catch { return []; }
};
const cleanText = (t) => (t || '').replace(/\s+/g, ' ').trim();
const parsePrice = (txt) => {
  if (!txt) return null;
  const m = txt.replace(/,/g, '').match(/(\d{2,})/);
  return m ? Number(m[1]) : null;
};

// --- fetch one list page ---
async function fetchListPage(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`Bad status ${res.status} for ${url}`);
  return await res.text();
}

// --- parse links from list page ---
// NOTE: Adjust selectors to your website structure if needed.
function parseVehicleLinks(html, base) {
  const $ = cheerio.load(html);
  const links = new Set();

  // generic anchors that look like VDPs:
  $('a[href*="/used/"], a[href*="/cars/"]').each((_, a) => {
    const href = $(a).attr('href');
    if (!href) return;
    const abs =
      href.startsWith('http')
        ? href
        : new URL(href, base).toString();
    // skip obvious non-VDP pages if needed:
    if (!/\/(used|cars)\//i.test(abs)) return;
    links.add(abs);
  });

  // If site uses cards with data attributes, add another strategy here.

  return Array.from(links);
}

// --- upsert one vehicle into DB ---
async function upsertVehicle(dealerId, vdpUrl, title, price, attrs) {
  const { error } = await supabase
    .from('vehicles')
    .upsert(
      {
        dealer_id: dealerId,
        vdp_url: vdpUrl,
        title,
        price,
        attrs
      },
      { onConflict: 'vdp_url' }
    );
  if (error) throw error;
}

// --- main handler ---
export default async function handler(req, res) {
  try {
    const dealerId = (req.query.dealer || req.query.id || '').trim().toLowerCase();
    if (!dealerId) {
      res.status(400).json({ ok: false, error: 'Missing ?dealer=id' });
      return;
    }

    // 1) Get dealer config
    const { data: dealer, error: dErr } = await supabase
      .from('dealers')
      .select('id, site_url, list_paths')
      .eq('id', dealerId)
      .single();
    if (dErr || !dealer) throw new Error(dErr?.message || 'Dealer not found');

    const siteUrl = dealer.site_url;
    const listPaths = asJsonArray(dealer.list_paths);

    if (!siteUrl || listPaths.length === 0) {
      res.status(400).json({ ok: false, error: 'Dealer site_url or list_paths missing' });
      return;
    }

    // 2) For each list path, fetch & parse
    const allLinks = new Set();
    for (const p of listPaths) {
      try {
        const full = new URL(p, siteUrl).toString();
        const html = await fetchListPage(full);
        const links = parseVehicleLinks(html, siteUrl);
        links.forEach((l) => allLinks.add(l));
        await sleep(300); // be nice
      } catch (e) {
        console.error('List fetch error:', p, e.message);
      }
    }

    const urls = Array.from(allLinks);
    if (urls.length === 0) {
      res.status(200).json({ ok: true, dealer: dealerId, count: 0, note: 'No links found' });
      return;
    }

    // 3) Upsert a row for each found link (basic metadata)
    // If you want deep parsing, add a second fetch here to parse the VDP itself.
    for (const vdp of urls) {
      try {
        // minimal parse from link (title from URL path)
        const titleGuess = decodeURIComponent(vdp.split('/').filter(Boolean).slice(-1)[0] || '');
        const title = cleanText(titleGuess.replace(/-/g, ' '));
        // price unknown from list link alone; keep null
        await upsertVehicle(dealerId, vdp, title, null, { list_hit: true });
        await sleep(100);
      } catch (e) {
        console.error('Upsert vehicle error:', vdp, e.message);
      }
    }

    res.status(200).json({ ok: true, dealer: dealerId, count: urls.length });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
}

export const config = {
  api: { bodyParser: false }
};
