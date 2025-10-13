// /api/chat.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

function extractMaxPrice(text) {
  const m = text.match(/(?:under|below|<=?|less than)\s*£?\s*([\d,]+)/i) || text.match(/£\s*([\d,]+)/);
  if (!m) return null;
  return parseInt(String(m[1]).replace(/,/g, ''), 10);
}

async function searchVehicles(message) {
  let q = message;
  let maxPrice = extractMaxPrice(message);

  let query = supabase
    .from('vehicles')
    .select('id, title, price, vdp_url, attrs', { count: 'exact' })
    .order('price', { ascending: true })
    .limit(20);

  if (q) query = query.ilike('title', `%${q}%`);
  if (maxPrice) query = query.lte('price', maxPrice);

  const { data, error } = await query;
  if (error) throw error;

  return (data || []).map(v => ({
    title: v.title,
    price: v.price,
    url: v.vdp_url,
    fuel: v?.attrs?.fuel ?? null,
    transmission: v?.attrs?.transmission ?? null,
    ulez: v?.attrs?.ulez ?? null
  }));
}

function templateReply(results, message) {
  if (!results.length) {
    return `I couldn't find an exact match for “${message}”. \
If you can give me a make/model, budget (e.g. “under £15,000”), or fuel type, I’ll refine the search.`;
  }

  const top = results.slice(0, 5)
    .map(r => `• **${r.title}** — £${r.price.toLocaleString()}${r.fuel ? ` — ${r.fuel.toUpperCase()}` : ''} — [View vehicle](${r.url})`)
    .join('\n');

  return `Here are some matches:\n\n${top}\n\nWant finance figures? Say “finance £PRICE deposit £X term 48 months”.`;
}

export default async function handler(req, res) {
  try {
    const { message } = JSON.parse(req.body || '{}');
    if (!message) return res.status(400).json({ reply: "Please type something to search." });

    const results = await searchVehicles(message);

    // Try OpenAI for a nicer tone (optional)
    if (process.env.OPENAI_API_KEY) {
      try {
        const prompt = `
You are an assistant for a used-car dealership. You must *only* use the vehicles provided.
Do NOT invent links or cars. If there are no matches, politely ask for more details.

User asked:
"${message}"

Vehicles (JSON):
${JSON.stringify(results).slice(0, 8000)}

Write a concise reply with bullet points. Each bullet must include the title, price,
and a markdown link using the 'url' field. Keep it friendly and helpful.
`;
        const r = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            temperature: 0.2,
            messages: [
              { role: 'system', content: 'You are a helpful car sales assistant.' },
              { role: 'user', content: prompt }
            ]
          })
        });

        if (!r.ok) throw new Error(`OpenAI error ${r.status}`);
        const j = await r.json();
        const reply = j?.choices?.[0]?.message?.content?.trim();
        if (reply) return res.status(200).json({ reply });
      } catch (e) {
        // fall back to template
        console.warn('OpenAI failed, using template:', e.message);
      }
    }

    // Fallback if no/failed OpenAI
    const reply = templateReply(results, message);
    return res.status(200).json({ reply });
  } catch (err) {
    console.error('chat error', err);
    return res.status(200).json({
      reply:
        "Looks like there was a technical issue. Tell me a make/model and a budget (e.g. “petrol automatic under £15,000”) and I’ll try again."
    });
  }
}
