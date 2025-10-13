// /api/chat.js
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  { auth: { persistSession: false } }
);

function extractMaxPrice(text) {
  const m = text.match(/(?:under|below|less than)\s*£?\s*([\d,]+)/i) || text.match(/£\s*([\d,]+)/);
  if (!m) return null;
  return parseInt(String(m[1]).replace(/,/g, ''), 10);
}

async function searchVehicles(message) {
  const maxPrice = extractMaxPrice(message);
  let query = supabase
    .from('vehicles')
    .select('id, title, price, vdp_url, attrs')
    .order('price', { ascending: true })
    .limit(10);

  if (message) query = query.ilike('title', `%${message}%`);
  if (maxPrice) query = query.lte('price', maxPrice);

  const { data, error } = await query;
  if (error) throw error;

  return data?.map(v => ({
    title: v.title,
    price: v.price,
    url: v.vdp_url,
    fuel: v.attrs?.fuel,
    ulez: v.attrs?.ulez,
    mileage: v.attrs?.mileage
  })) || [];
}

function formatReply(results, query) {
  if (!results.length)
    return `I couldn’t find any results matching “${query}”. Try giving me a make or model name, like “Ford Ranger” or a price range such as “under £15,000”.`;

  const items = results.map(v => {
    const tags = [];
    if (v.fuel) tags.push(v.fuel);
    if (v.ulez) tags.push("ULEZ");
    return `• **${v.title}** — £${v.price.toLocaleString()}${tags.length ? ` (${tags.join(", ")})` : ""} — [View Vehicle](${v.url})`;
  });

  return `Here’s what I found:\n\n${items.join("\n")}\n\nWould you like a finance example? Just say “finance £DEPOSIT term 48 months”.`;
}

export default async function handler(req, res) {
  try {
    const { message } = JSON.parse(req.body || '{}');
    if (!message) return res.status(400).json({ reply: 'Please enter a search query.' });

    const results = await searchVehicles(message);

    // If OpenAI key exists, make a smart reply using the search data
    if (process.env.OPENAI_API_KEY) {
      try {
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content: `You are a polite, knowledgeable assistant for a used car dealership. Only use the data provided.`
              },
              {
                role: 'user',
                content: `User asked: "${message}"\n\nResults:\n${JSON.stringify(results).slice(0, 6000)}`
              }
            ],
            temperature: 0.2
          })
        });

        const json = await response.json();
        const reply = json?.choices?.[0]?.message?.content;
        if (reply) return res.status(200).json({ reply });
      } catch (error) {
        console.warn('OpenAI failed, fallback reply used');
      }
    }

    // Fallback reply (if OpenAI quota or off)
    const reply = formatReply(results, message);
    return res.status(200).json({ reply });
  } catch (err) {
    console.error('chat error', err);
    return res.status(500).json({
      reply: "There was an issue fetching results. Please try again shortly."
    });
  }
}
