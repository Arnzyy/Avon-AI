import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// --- Simple intent splitter (no AI yet) ---
function parseIntent(text = "") {
  const t = text.toLowerCase();

  // finance intent
  if (/(finance|monthly|apr|deposit|term|quote)/.test(t)) {
    const price = Number((t.match(/£?\s?([\d,]{3,})/)?.[1] || "0").replace(/,/g,''));
    const dep = Number((t.match(/deposit\s*£?\s?([\d,]+)/)?.[1] || "0").replace(/,/g,''));
    const term = Number(t.match(/(\d{2,3})\s*(months|mo|mth)/)?.[1] || 60);
    return { intent: 'finance', price, deposit: dep, term };
  }

  // inventory intent
  if (/(have|got|stock|show|find|search)/.test(t) || /(petrol|diesel|hybrid|electric|automatic|manual|ulez)/.test(t)) {
    const maxPrice = Number((t.match(/under\s*£?\s?([\d,]+)/)?.[1] || "0").replace(/,/g,''));
    const make = (t.match(/\b(audi|bmw|mercedes|ford|vauxhall|nissan|toyota|kia|hyundai|volkswagen|vw|peugeot|renault|skoda)\b/i)?.[0] || '').toLowerCase();
    const fuel = (t.match(/\b(petrol|diesel|hybrid|electric)\b/i)?.[0] || '').toLowerCase();
    const transmission = (t.match(/\b(automatic|auto|manual)\b/i)?.[0] || '').toLowerCase().replace('auto','automatic');
    const ulez = /ulez/.test(t) ? true : undefined;
    return { intent: 'inventory', filters: { make, maxPrice: maxPrice||undefined, fuel, transmission, ulez } };
  }

  // lead capture intent
  if (/(book|appointment|view|test\s*drive|call me|ring me)/.test(t)) {
    return { intent: 'lead' };
  }

  return { intent: 'smalltalk' };
}

async function inventorySearch(filters) {
  // use latest snapshot (same as /api/inventory)
  const { data, error } = await sb.from('inventory_snapshots').select('payload').eq('dealer_id', 'avon').single();
  if (error) return [];
  let results = data?.payload || [];
  const toLower = v => String(v||'').toLowerCase();
  const { q, make, maxPrice, fuel, transmission, ulez } = filters || {};
  if (q) results = results.filter(v => toLower(v.title).includes(toLower(q)));
  if (make) results = results.filter(v => toLower(v.title).includes(toLower(make)));
  if (maxPrice) results = results.filter(v => (v.price||0) <= Number(maxPrice));
  if (fuel) results = results.filter(v => toLower(v.fuel) === toLower(fuel));
  if (transmission) results = results.filter(v => toLower(v.transmission) === toLower(transmission));
  if (typeof ulez === 'boolean') results = results.filter(v => !!v.ulez === ulez);
  return results.slice(0,6);
}

function financeQuote({ cashPrice=0, deposit=0, term=60, apr=9.9, feeSetup=0, feeOption=0 }) {
  const P = Math.max(0, cashPrice - deposit + feeSetup);
  const r = (apr/100)/12;
  const n = Math.max(1, term);
  const monthly = r === 0 ? P/n : (r * P * Math.pow(1+r,n)) / (Math.pow(1+r,n)-1);
  return {
    monthly: Number(monthly.toFixed(2)),
    lastPayment: Number((monthly + feeOption).toFixed(2)),
    apr, termMonths: n, deposit, cashPrice
  };
}

export default async function handler(req, res) {
  try {
    const body = req.method === 'POST' ? JSON.parse(req.body || '{}') : {};
    const user = String(body.message || '');
    if (!user) return res.status(400).json({ ok:false, error:'message required' });

    const intent = parseIntent(user);

    if (intent.intent === 'inventory') {
      const items = await inventorySearch(intent.filters||{});
      if (!items.length) {
        return res.json({ ok:true, reply: "I couldn’t find a match in stock for that. Want me to try a different budget, fuel type, or transmission?" });
      }
      const lines = items.map(v => `• ${v.title} — £${(v.price||0).toLocaleString()}${v.ulez? " — ULEZ ✅":""}\n  ${v.url}`);
      return res.json({ ok:true, reply: `Here are a few that fit:\n${lines.join("\n")}\n\nWant example finance on any of these? Say “finance £PRICE deposit £X term 48 months”.` });
    }

    if (intent.intent === 'finance') {
      const quote = financeQuote({ cashPrice:intent.price||0, deposit:intent.deposit||0, term:intent.term||60 });
      return res.json({
        ok:true,
        reply: `Representative example on £${(quote.cashPrice||0).toLocaleString()} over ${quote.termMonths} months with £${(quote.deposit||0).toLocaleString()} deposit at ${quote.apr}% APR: ~£${quote.monthly}/mo.\n\nThis is a guide only (soft search). I can link you to the finance form — it’s a soft check and takes ~5 minutes.`
      });
    }

    if (intent.intent === 'lead') {
      return res.json({ ok:true, reply: "Happy to get you booked in. What’s your name, email, and best number? I’ll pass this to the team and they’ll confirm your appointment time." });
    }

    // smalltalk/default
    return res.json({ ok:true, reply: "I can help with stock, ULEZ, and finance examples. Try: “show petrol automatics under £15,000” or “finance £12,995 deposit £1,000 term 48 months”." });
  } catch (e) {
    res.status(500).json({ ok:false, error:String(e) });
  }
}
