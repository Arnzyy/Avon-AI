import { createClient } from '@supabase/supabase-js';
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

export default async function handler(req,res){
  try{
    const body = req.method === 'POST' ? JSON.parse(req.body||'{}') : {};
    const { q, make, maxPrice, fuel, transmission, ulez, dealer='avon' } = body;

    let query = sb.from('vehicles')
      .select('title, price, attrs, vdp_url')
      .eq('dealer_id', dealer)
      .order('price', { ascending: true })
      .limit(25);

    if (q) query = query.ilike('title', `%${q}%`);
    if (make) query = query.ilike('title', `%${make}%`);
    if (maxPrice) query = query.lte('price', Number(maxPrice));
    if (fuel) query = query.contains('attrs', { fuel });
    if (transmission) query = query.contains('attrs', { transmission });
    if (typeof ulez === 'boolean') query = query.contains('attrs', { ulez });

    const { data, error } = await query;
    if (error) throw error;

    const rows = (data||[]).map(r => ({
      title: r.title,
      price: r.price,
      url: r.vdp_url,
      fuel: r.attrs?.fuel || null,
      transmission: r.attrs?.transmission || null,
      ulez: !!r.attrs?.ulez
    }));

    res.json({ ok:true, results: rows });
  }catch(e){
    res.status(500).json({ ok:false, error:String(e) });
  }
}
