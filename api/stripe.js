const { google } = require('googleapis');

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

async function sendGmail(to, subject, body, threadId, messageId) {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });

  const headers = [
    `To: ${to}`,
    'Content-Type: text/plain; charset=UTF-8',
    'MIME-Version: 1.0',
    `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
  ];
  if (messageId) {
    headers.push(`In-Reply-To: ${messageId}`);
    headers.push(`References: ${messageId}`);
  }
  headers.push('', body);
  const message = headers.join('\n');
  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const requestBody = { raw: encoded };
  if (threadId) requestBody.threadId = threadId;
  await gmail.users.messages.send({ userId: 'me', requestBody });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const event = req.body;

    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      const clientEmail = session.customer_details?.email ||
                         session.customer_email ||
                         session.metadata?.clientEmail;

      if (!clientEmail) {
        console.log('No email in Stripe session');
        return res.status(200).json({ received: true });
      }

      const client = await redisGet(`client:${clientEmail.toLowerCase()}`);
      if (!client) {
        await sendTelegram(`⚠️ <b>Payment received but client not found</b>\n\nEmail: ${clientEmail}\nAmount: ${(session.amount_total / 100).toFixed(2)} CAD\n\nPlease create client manually in admin.`);
        return res.status(200).json({ received: true });
      }

      // Get selected photos from metadata or Redis
      let selectedPhotos = [];
      if (session.metadata && session.metadata.selectedPhotos) {
        selectedPhotos = session.metadata.selectedPhotos.split(',');
      } else {
        const saved = await redisGet(`selected:${clientEmail.toLowerCase()}`);
        if (saved && saved.selectedPhotos) selectedPhotos = saved.selectedPhotos;
      }

      const amount = session.amount_total / 100;
      const packageName = (session.metadata && session.metadata.package) || (amount >= 200 ? 'Full Portal' : 'Spark Pack');
      const price = `$${amount.toFixed(2)} CAD`;
      const firstName = client.name.split(' ')[0];

      // Update client status to editing
      client.status = 'editing';
      client.package = packageName;
      client.price = price;
      client.purchasedAt = new Date().toISOString();
      client.revenue = amount;
      client.selectedPhotos = selectedPhotos;
      client.galleryState = 'editing';
      await redisSet(`client:${clientEmail.toLowerCase()}`, client);

      // Build gallery link with selected photos
      const selectedParam = selectedPhotos.length > 0 ? '&selected=' + encodeURIComponent(selectedPhotos.join(',')) : '';
      const purchasedGalleryUrl = `https://www.portalmoments.com/gallery.html?email=${encodeURIComponent(clientEmail)}&folder=${client.folder}&name=${encodeURIComponent(firstName)}&fullname=${encodeURIComponent(client.name)}&state=purchased${selectedParam}`;

      // Send Template 3
      try {
        await sendGmail(
          clientEmail,
          `Re: ${client.emailSubject || 'Your Portal Moment'}`,
          `Hello ${firstName},

Your order is confirmed — thank you!

Here is what you ordered:
${purchasedGalleryUrl}

I am now preparing your collection with the same care as the moment itself. You will receive your edited photos as soon as they are ready.

Warmly,
Anna Totska
Portal Moments
portalmoments.com
@portalmoments`,
          client.threadId || null,
          client.messageId || null
        );
      } catch(gmailErr) {
        console.error('Gmail error:', gmailErr.message);
        await sendTelegram(`⚠️ Template 3 email failed: ${gmailErr.message}`);
      }

      // Notify Anna
      const photoList = selectedPhotos.length > 0
        ? selectedPhotos.map((p, i) => `${i+1}. ${p.split('/').pop()}`).join('\n')
        : 'Check gallery for selections';

      await sendTelegram(`💳 <b>Payment Received!</b>

<b>Client:</b> ${client.name}
<b>Email:</b> ${clientEmail}
<b>Package:</b> ${packageName}
<b>Amount:</b> ${price}

<b>Selected photos:</b>
${photoList}

━━━━━━━━━━━━━━━
✅ Template 3 sent to client automatically
✅ Status updated to Editing

<b>Your next step:</b>
🎨 Edit these photos in Lightroom
📁 Upload to Cloudinary: <code>${client.folder}/edited/</code>`);

      return res.status(200).json({ received: true });
    }

    return res.status(200).json({ received: true });

  } catch (error) {
    console.error('Stripe webhook error:', error);
    await sendTelegram(`⚠️ <b>Stripe Webhook Error</b>\n\n${error.message}`);
    return res.status(500).json({ error: error.message });
  }
};
