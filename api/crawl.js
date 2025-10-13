import cheerio from 'cheerio';
import { createClient } from '@supabase/supabase-js';

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

// helpers
const abs = (base, href='') => {
  try { return new URL(href, base).toString(); } catch { return href; }
};
const parsePrice = (s='') => {
  const m = String(s).replace(/[, ]/g,'').match(/£?\s?(\d{3,7})/);
  return m ? Number(m[1]) : null;
};
const norm = s => String(s||'').replace(/\s+/g,' ').trim();

async function fetchHTML(url){
  const r = await fetch(url, { headers: { 'user-agent':'Mozilla/5.0 AvonBot' }});
  const html = await r.text();
  return cheerio.load(html);
}

export default async function handler(req,res){
  try{
    const dealer = String((req.query.dealer||'avon')).toLowerCase();

    // 1) read dealer config
    const { data: d, error: derr } = await sb
      .from('dealers').select('*').eq('id', dealer).single();
    if (derr || !d) throw new Error('dealer not found');

    const base = d.site_url;
    const listPaths = Array.isArray(d.list_paths) ? d.list_paths : [];

    const items = [];
    const seen = new Set();

    // 2) crawl each listing page, extract car cards
    for (const path of listPaths){
      const url = abs(base, path);
      const $ = await fetchHTML(url);

      // try common card patterns, and fall back to any used-car link with price nearby
      const candidates = new Set();

      // obvious cards
      $('[class*="vehicle"], [class*="stock"], [class*="card"], li, article, .result, .srp, .listing').each((_,el)=>{
        const a = $(el).find('a[href*="/used/"], a[href*="/vehicle"], a[href*="/cars/"]').first();
        if (a.length){
          const href = abs(base, a.attr('href'));
          if (!href.includes('#') && !seen.has(href)) candidates.add(el);
        }
      });

      // generic anchors if nothing matched
      if (candidates.size === 0){
        $('a[href*="/used/"], a[href*="/vehicle"], a[href*="/cars/"]').each((_,a)=>{
          const href = abs(base, $(a).attr('href'));
          if (!href.includes('#') && !seen.has(href)) candidates.add(a);
        });
      }

      for (const el of candidates){
        const $el = $(el);
        const a = $el.is('a') ? $el : $el.find('a[href]').first();
        const href = abs(base, a.attr('href')||'');
        if (!href || seen.has(href)) continue;

        // title
        let title = norm(a.text() || $el.find('h3,h2,.title').first().text());
        if (!title || /used cars in/i.test(title)) {
          // try parent text
          title = norm($el.text()).slice(0,140);
        }

        // price: closest text with £
        let priceText = '';
        const priceNode = $el.find(':contains("£")').filter((_,n)=>/\£\s?\d/.test($(n).text())).first();
        priceText = priceNode.text() || a.text() || $el.text();
        const price = parsePrice(priceText);

        // attrs
        const blockText = norm($el.text()).toLowerCase();
        const fuel = (blockText.match(/\b(petrol|diesel|hybrid|electric)\b/)||[])[0] || null;
        let transmission = (blockText.match(/\b(automatic|manual|auto)\b/)||[])[0] || null;
        if (transmission === 'auto') transmission = 'automatic';
        const ulez = /ulez|ul ez/.test(blockText);

        // sanity checks
        if (!price || price < 500 || price > 200000) continue; // skip junk/headers
        if (!title || title.length < 5) continue;

        seen.add(href);
        items.push({
          dealer_id: dealer,
          url: href,
          title,
          price,
          fuel,
          transmission,
          ulez
        });
      }
    }

    // 3) upsert into vehicles & snapshot
    for (const v of items){
      const attrs = { fuel: v.fuel, transmission: v.transmission, ulez: !!v.ulez, url: v.url };
      await sb.rpc('upsert_vehicle_from_crawl', {
        p_dealer: v.dealer_id,
        p_vdp_url: v.url,
        p_title: v.title,
        p_price: v.price,
        p_attrs: attrs
      });
    }

    if (items.length){
      await sb.from('inventory_snapshots').upsert({
        dealer_id: dealer,
        payload: items.map(i=>({ url:i.url, title:i.title, price:i.price, fuel:i.fuel, transmission:i.transmission, ulez:i.ulez })),
        updated_at: new Date().toISOString()
      });
    }

    res.json({ ok:true, dealer, count: items.length });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
}
