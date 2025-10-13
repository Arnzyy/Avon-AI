import { createClient } from '@supabase/supabase-js';
import * as cheerio from 'cheerio';

// Initialize Supabase
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE);

export default async function handler(req, res) {
  try {
    const dealer = req.query.dealer || 'avon';

    // Get dealer config from Supabase
    const { data: dealers, error } = await sb
      .from('dealers')
      .select('*')
      .eq('id', dealer)
      .limit(1);

    if (error) throw error;
    if (!dealers?.length) throw new Error(`Dealer not found: ${dealer}`);

    const dealerData = dealers[0];
    const urls = dealerData.list_paths || [];

    let vehicles = [];

    // Crawl all stock list pages
    for (const path of urls) {
      const pageUrl = `${dealerData.site_url}${path}`;
      console.log(`Fetching: ${pageUrl}`);

      const response = await fetch(pageUrl);
      const html = await response.text();
      const $ = cheerio.load(html);

      // Detect vehicle cards (Avon Automotive uses .vehicle-listing)
      $('.vehicle, .vehicle-listing, .car, .stock-listing, .vehicle-card').each((_, el) => {
        const title =
          $(el).find('h2, .title, .vehicle-title, .vehicle__title').text().trim() ||
          'Unknown vehicle';

        const priceText =
          $(el).find('.price, .vehicle-price, .vehicle__price').text().replace(/[^\d]/g, '') || '0';
        const price = Number(priceText);

        const link = $(el).find('a').attr('href');
        const fullUrl =
          link && link.startsWith('http')
            ? link
            : link
            ? `${dealerData.site_url}${link}`
            : null;

        if (title && fullUrl && price > 0) {
          vehicles.push({
            dealer_id: dealer,
            title,
            price,
            vdp_url: fullUrl,
            attrs: {
              fuel: $(el).text().toLowerCase().includes('diesel')
                ? 'Diesel'
                : $(el).text().toLowerCase().includes('petrol')
                ? 'Petrol'
                : 'Unknown',
              transmission: $(el).text().toLowerCase().includes('auto')
                ? 'Auto'
                : $(el).text().toLowerCase().includes('manual')
                ? 'Manual'
                : 'Unknown',
              ulez: $(el).text().toLowerCase().includes('ulez'),
            },
          });
        }
      });
    }

    if (vehicles.length === 0) {
      throw new Error(`No vehicles found for dealer ${dealer}`);
    }

    // Insert into Supabase
    const { error: insertError } = await sb.from('vehicles').insert(vehicles);
    if (insertError) throw insertError;

    res.json({ ok: true, dealer, count: vehicles.length });
  } catch (e) {
    // 🧩 Error logging (safe and visible in Vercel logs)
    console.error('crawl error:', e);
    res.status(500).json({ ok: false, error: String(e) });
  }
}
