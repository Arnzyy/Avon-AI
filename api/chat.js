// /api/chat.js
import { createClient } from "@supabase/supabase-js";

// --- Setup ---
const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE || process.env.SUPABASE_SERVICE_ROLE_KEY // support either env name
);

// Map any old model names to a valid one
function resolveModel() {
  const m = (process.env.OPENAI_MODEL || "").toLowerCase();
  if (m.includes("4.1")) return "gpt-4.1-mini";
  if (!m) return "gpt-4o-mini";
  return process.env.OPENAI_MODEL;
}

const OPENAI_MODEL = resolveModel();
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// Small helper
async function callOpenAI(messages, opts = {}) {
  const { jsonMode = false, temperature = 0.3 } = opts;
  const body = {
    model: OPENAI_MODEL,
    messages,
    temperature,
    ...(jsonMode ? { response_format: { type: "json_object" } } : {}),
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const errText = await r.text();
    throw new Error(`OpenAI error: ${r.status} ${errText}`);
  }

  const data = await r.json();
  return data.choices?.[0]?.message?.content || "";
}

// Intent schema we want back from the model
const INTENT_SYSTEM = `
You are an intent extractor for a UK car dealership chat.
Return STRICT JSON with the following keys:

{
  "intent": "search|finance|lead|greeting|other",
  "make": string|null,           // e.g., "Ford"
  "model": string|null,          // e.g., "Ranger"
  "price_max": number|null,      // e.g., 15000 for "under £15,000"
  "fuel": "Petrol|Diesel|Hybrid|Electric|null",
  "transmission": "Auto|Manual|null",
  "ulez": boolean|null,
  "finance": {                   // present if finance question
    "deposit": number|null,
    "term_months": number|null,
    "budget_monthly": number|null
  }
}

Extract what you can. If the user says "ford rangers under 15k", output:
{"intent":"search","make":"Ford","model":"Ranger","price_max":15000,"fuel":null,"transmission":null,"ulez":null,"finance":null}

Output ONLY JSON. No commentary.
`;

const REPLY_SYSTEM = `
You are a friendly, non-pushy receptionist/sales assistant for a UK car dealer.
Style: concise, clear, human, helpful. Never cheesy. Offer next steps without pressure.

Rules:
- If there are matches, show 1-5 best matches as bullet points:
  • Title — £PRICE — ULEZ ✓/✗
  • Link on its own line (plain URL)
- If no matches, suggest close alternatives (e.g., similar price, fuel, transmission) in one line.
- If user asked about finance (or after showing matches), offer to provide a rough example and
  ask for deposit + term. Mention it's a soft search and takes ~5 minutes to apply.
- If user seems like a serious lead, politely ask for name, email, phone to arrange a viewing/test drive.
- If they mention ULEZ, be explicit ✓ if ulez===true, otherwise ✗.
- Never invent stock. Only talk about what was provided in the "context" list.
- Keep reply under ~140 words if possible.
`;

async function queryInventory(filters) {
  // Build a targeted query based on extracted intent
  let q = sb.from("vehicles")
    .select("title, price, vdp_url, attrs")
    .order("price", { ascending: true })
    .limit(5);

  if (filters.price_max) q = q.lte("price", filters.price_max);
  if (filters.make) q = q.ilike("title", `%${filters.make}%`);
  if (filters.model) q = q.ilike("title", `%${filters.model}%`);
  if (filters.fuel) q = q.filter("attrs->>fuel", "ilike", filters.fuel);
  if (filters.transmission) q = q.filter("attrs->>transmission", "ilike", filters.transmission);
  if (filters.ulez !== null && filters.ulez !== undefined) q = q.eq("attrs->>ulez", String(!!filters.ulez));

  const { data, error } = await q;
  if (error) throw error;

  // Normalize
  return (data || []).map(v => ({
    title: v.title,
    price: v.price,
    url: v.vdp_url,
    fuel: v.attrs?.fuel || null,
    transmission: v.attrs?.transmission || null,
    ulez: !!(v.attrs?.ulez),
  }));
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Use POST with { message }" });
    }

    if (!OPENAI_API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing OPENAI_API_KEY" });
    }

    const { message } = await (await req).json?.() || req.body || {};
    const userText = message || (typeof req.body === "string" ? req.body : "");

    if (!userText) {
      return res.status(400).json({ ok: false, error: "Empty message" });
    }

    // 1) Extract intent / filters
    const intentJson = await callOpenAI(
      [
        { role: "system", content: INTENT_SYSTEM },
        { role: "user", content: userText },
      ],
      { jsonMode: true, temperature: 0.0 }
    );

    let intent;
    try {
      intent = JSON.parse(intentJson);
    } catch {
      // fall back: treat as generic search
      intent = { intent: "search", make: null, model: null, price_max: null, fuel: null, transmission: null, ulez: null, finance: null };
    }

    let matches = [];
    if (intent.intent === "search" || intent.intent === "finance" || intent.intent === "other") {
      matches = await queryInventory(intent);
    }

    // 2) Ask model to write a polished reply using the matches as context
    const context = JSON.stringify(matches.slice(0, 5));

    const reply = await callOpenAI(
      [
        { role: "system", content: REPLY_SYSTEM },
        {
          role: "user",
          content:
            `User message:\n${userText}\n\n` +
            `Filters:\n${JSON.stringify(intent, null, 2)}\n\n` +
            `Context (matching stock as JSON array):\n${context}\n\n` +
            `When you list cars, follow the style rules.`
        }
      ],
      { temperature: 0.5 }
    );

    res.status(200).json({ ok: true, reply, results: matches });
  } catch (e) {
    console.error("chat error:", e);
    res.status(500).json({ ok: false, error: String(e) });
  }
}
