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

async function sendTelegram(message) {
  await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    })
  });
}

async function sendGmail(to, subject, body) {
  const { google } = require('googleapis');
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const message = [
    `To: ${to}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body
  ].join('\n');

  const encoded = Buffer.from(message).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_');

  await gmail.users.messages.send({
    userId: 'me',
    requestBody: { raw: encoded }
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const event = req.body;

    // Handle checkout.session.completed — client paid
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      // Get client email from Stripe session
      const clientEmail = session.customer_details?.email ||
                         session.customer_email;

      if (!clientEmail) {
        console.log('No email in Stripe session');
        return res.status(200).json({ received: true });
      }

      // Get client from Redis
      const client = await redisGet(`client:${clientEmail.toLowerCase()}`);
      if (!client) {
        await sendTelegram(`⚠️ <b>Payment received but client not found</b>\n\nEmail: ${clientEmail}\nAmount: ${(session.amount_total / 100).toFixed(2)} CAD\n\nPlease create client manually in admin.`);
        return res.status(200).json({ received: true });
      }

      // Determine package from amount
      const amount = session.amount_total / 100;
      const packageName = amount >= 200 ? 'Full Portal' : 'Spark Pack';
      const price = `$${amount.toFixed(2)} CAD`;

      // Update client status to purchased
      client.status = 'purchased';
      client.package = packageName;
      client.price = price;
      client.purchasedAt = new Date().toISOString();
      client.revenue = amount;
      await redisSet(`client:${clientEmail.toLowerCase()}`, client);

      // Send Template 3 to client
      const firstName = client.name.split(' ')[0];
      await sendGmail(
        clientEmail,
        'Your collection is being prepared ✨',
        `Hello ${firstName},

Your order is confirmed — thank you!

I'm now preparing your full collection with the same care as the moment itself. You'll receive your edited photos shortly.

Warmly,
Anna Totska
Portal Moments
portalmoments.com
@portalmoments`
      );

      // Notify Anna in Telegram
      await sendTelegram(`💳 <b>Payment Received!</b>

<b>Client:</b> ${client.name}
<b>Email:</b> ${clientEmail}
<b>Package:</b> ${packageName}
<b>Amount:</b> ${price}

━━━━━━━━━━━━━━━
✅ Template 3 sent to client automatically
✅ Status updated to Purchased

<b>Your next step:</b>
🎨 Edit photos in Lightroom
📁 Upload to Cloudinary: <code>${client.folder}/edited/</code>`);

      return res.status(200).json({ received: true });
    }

    // All other events — just acknowledge
    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Stripe webhook error:', error);
    await sendTelegram(`⚠️ <b>Stripe Webhook Error</b>\n\n${error.message}`);
    return res.status(500).json({ error: error.message });
  }
};
