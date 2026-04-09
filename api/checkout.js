const https = require('https');

async function redisGet(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return data.result; }
}

async function redisSet(key, value) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
  return res.json();
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { email, selectedPhotos, package: pkg } = req.body;

    if (!email || !selectedPhotos || !pkg) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Get client from Redis
    const client = await redisGet(`client:${email.toLowerCase()}`);
    if (!client) {
      return res.status(404).json({ error: 'Client not found' });
    }

    // Determine price based on package
    const isFull = pkg === 'full' || selectedPhotos.length >= 10;
    const priceCAD = isFull ? 22200 : 11100; // in cents
    const packageName = isFull ? 'Full Portal — 10 edited photos' : 'Spark Pack — 5 edited photos';

    // Save selected photos to Redis before checkout
    await redisSet(`selected:${email.toLowerCase()}`, {
      selectedPhotos,
      package: isFull ? 'Full Portal' : 'Spark Pack',
      savedAt: new Date().toISOString()
    });

    // Create Stripe checkout session
    const stripeKey = process.env.STRIPE_SECRET_KEY;
    const successUrl = `https://www.portalmoments.com/gallery.html?email=${encodeURIComponent(email)}&folder=${client.folder}&name=${encodeURIComponent(client.name.split(' ')[0])}&fullname=${encodeURIComponent(client.name)}&state=purchased`;
    const cancelUrl = `https://www.portalmoments.com/gallery.html?email=${encodeURIComponent(email)}&folder=${client.folder}&name=${encodeURIComponent(client.name.split(' ')[0])}&fullname=${encodeURIComponent(client.name)}`;

    const sessionData = new URLSearchParams({
      'payment_method_types[]': 'card',
      'line_items[0][price_data][currency]': 'cad',
      'line_items[0][price_data][product_data][name]': packageName,
      'line_items[0][price_data][product_data][description]': `Portal Moments Photography — ${selectedPhotos.length} edited photos`,
      'line_items[0][price_data][unit_amount]': priceCAD.toString(),
      'line_items[0][quantity]': '1',
      'mode': 'payment',
      'customer_email': email,
      'success_url': successUrl,
      'cancel_url': cancelUrl,
      'metadata[clientEmail]': email,
      'metadata[selectedPhotos]': selectedPhotos.join(','),
      'metadata[package]': isFull ? 'Full Portal' : 'Spark Pack',
      'metadata[folder]': client.folder
    });

    const stripeRes = await new Promise((resolve, reject) => {
      const options = {
        hostname: 'api.stripe.com',
        path: '/v1/checkout/sessions',
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${stripeKey}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(sessionData.toString())
        }
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve(JSON.parse(data)));
      });
      req.on('error', reject);
      req.write(sessionData.toString());
      req.end();
    });

    if (stripeRes.error) {
      return res.status(400).json({ error: stripeRes.error.message });
    }

    return res.status(200).json({ url: stripeRes.url });

  } catch (error) {
    console.error('Checkout error:', error);
    return res.status(500).json({ error: error.message });
  }
};
