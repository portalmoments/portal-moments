const { google } = require('googleapis');
const https = require('https');

// ─── GMAIL ───────────────────────────────────────────────────────────────────
async function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function sendGmail(gmail, to, subject, body) {
  const message = [
    `To: ${to}`,
    'Content-Type: text/plain; charset=utf-8',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body
  ].join('\n');
  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

// ─── REDIS ───────────────────────────────────────────────────────────────────
async function redisSet(key, value) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
  return res.json();
}

async function redisGet(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return data.result; }
}

// ─── TELEGRAM ─────────────────────────────────────────────────────────────────
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

// ─── CLOUDINARY ──────────────────────────────────────────────────────────────
async function cloudinaryUpload(fileBuffer, fileName, folder) {
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const apiKey = process.env.CLOUDINARY_API_KEY;
  const apiSecret = process.env.CLOUDINARY_API_SECRET;
  const timestamp = Math.floor(Date.now() / 1000);
  const publicId = `${folder}/${fileName.replace(/\.[^.]+$/, '')}`;

  const crypto = require('crypto');
  const signature = crypto
    .createHash('sha1')
    .update(`public_id=${publicId}&timestamp=${timestamp}${apiSecret}`)
    .digest('hex');

  const FormData = require('form-data');
  const form = new FormData();
  form.append('file', fileBuffer, fileName);
  form.append('public_id', publicId);
  form.append('timestamp', timestamp);
  form.append('api_key', apiKey);
  form.append('signature', signature);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, {
    method: 'POST',
    body: form
  });
  return res.json();
}

// ─── EMAIL DETECTION ─────────────────────────────────────────────────────────
function isRealClientEmail(subject, body) {
  const text = (subject + ' ' + body).toLowerCase();
  const clientKeywords = [
    'photo', 'photos', 'picture', 'pictures', 'photograph',
    'shoot', 'session', 'moment', 'shot',
    'you took', 'you photographed', 'you approached',
    'i met you', 'met you', 'you came up',
    'the photographer', 'a photographer',
    'free photo', 'my photo', 'my picture',
    'send me', 'my photos',
    'yesterday', 'this afternoon', 'this morning',
    'last night', 'today at', 'earlier today',
    'park', 'street', 'downtown', 'market',
    'distillery', 'kensington', 'bellwoods',
    'high park', 'waterfront',
    'i was wearing', 'i had on', 'i was sitting',
    'i was standing', 'i was walking', 'i was with',
  ];
  for (const keyword of clientKeywords) {
    if (text.includes(keyword)) return true;
  }
  return false;
}

function extractName(body, fromEmail) {
  const namePatterns = [
    /my name is ([A-Z][a-z]+ [A-Z][a-z]+)/i,
    /i(?:'m| am) ([A-Z][a-z]+ [A-Z][a-z]+)/i,
    /this is ([A-Z][a-z]+ [A-Z][a-z]+)/i,
    /^([A-Z][a-z]+ [A-Z][a-z]+)[\s,\.]/m,
  ];
  for (const pattern of namePatterns) {
    const match = body.match(pattern);
    if (match) return match[1].trim();
  }
  const emailName = fromEmail.split('@')[0];
  return emailName.replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function generateFolder(name) {
  const date = new Date().toISOString().slice(5, 10).replace('-', '');
  return name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '') + '-' + date;
}

function decodeBase64(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function getEmailBody(payload) {
  if (payload.body?.data) return decodeBase64(payload.body.data);
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data) return decodeBase64(part.body.data);
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data) return decodeBase64(part.body.data).replace(/<[^>]+>/g, ' ');
    }
  }
  return '';
}

function buildGalleryUrl(client, state) {
  const firstName = encodeURIComponent(client.name.split(' ')[0]);
  const fullName = encodeURIComponent(client.name);
  let url = `https://portalmoments.com/gallery.html?email=${encodeURIComponent(client.email)}&folder=${client.folder}&name=${firstName}&fullname=${fullName}`;
  if (client.expiry) url += `&expiry=${client.expiry}`;
  if (state) url += `&state=${state}`;
  return url;
}

function getExpiryDate(daysFromNow) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  return d.toISOString().split('T')[0];
}

// ─── EMAIL TEMPLATES ─────────────────────────────────────────────────────────
function template3(clientName, packageName, price) {
  return `Hello ${clientName.split(' ')[0]},

Your order is confirmed — thank you.

I'm now preparing your full collection with the same care as the moment itself. You'll receive your edited photos shortly.

Here's what you ordered:
${packageName} — ${price}

Warmly,
Anna Totska
Portal Moments
portalmoments.com
@portalmoments`;
}

function template4(clientName, galleryUrl) {
  return `Hello ${clientName.split(' ')[0]},

They're here.

Every photo was edited with the same intention as the moment itself. I hope when you look at these, you feel exactly what I felt when I captured them.

Access your full gallery here:
${galleryUrl}

Your photos are yours forever. Download them, print them, keep them somewhere you'll find them on the days you need a reminder of who you are.

Warmly,
Anna Totska
Portal Moments
portalmoments.com
@portalmoments`;
}

// ─── MAIN HANDLER ─────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  const isCron = req.headers['x-vercel-cron'] === '1';
  if (req.method !== 'POST' && !isCron) return res.status(405).json({ error: 'Method not allowed' });
  if (!isCron && req.headers.authorization !== `Bearer ${process.env.AGENT_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });

  const action = req.body?.action || 'check_emails';

  try {
    const gmail = await getGmailClient();

    // ── ACTION: CHECK NEW EMAILS ──────────────────────────────────────────────
    if (action === 'check_emails') {
      const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
      const listRes = await gmail.users.messages.list({
        userId: 'me',
        q: `is:unread after:${since} -from:me`,
        maxResults: 10
      });

      const messages = listRes.data.messages || [];
      let processed = 0;

      for (const msg of messages) {
        const email = await gmail.users.messages.get({ userId: 'me', id: msg.id, format: 'full' });
        const headers = email.data.payload.headers;
        const fromHeader = headers.find(h => h.name === 'From')?.value || '';
        const subject = headers.find(h => h.name === 'Subject')?.value || '';
        const emailMatch = fromHeader.match(/<(.+?)>/) || fromHeader.match(/([^\s]+@[^\s]+)/);
        if (!emailMatch) continue;
        const fromEmail = emailMatch[1].toLowerCase().trim();
        if (fromEmail.includes('portalmoments')) continue;

        const body = getEmailBody(email.data.payload);

        // Mark read regardless
        await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] } });

        // Only process real client emails
        if (!isRealClientEmail(subject, body)) continue;

        // Skip existing clients
        const existingKey = `client:${fromEmail}`;
        const existing = await redisGet(existingKey);
        if (existing) continue;

        const clientName = extractName(body, fromEmail);
        const folder = generateFolder(clientName);

        const client = {
          id: Date.now(),
          name: clientName,
          email: fromEmail,
          folder,
          status: 'gallery',
          expiry: null,
          revenue: 0,
          createdAt: new Date().toISOString(),
          emailSubject: subject
        };

        await redisSet(existingKey, client);
        await redisSet(`clientid:${client.id}`, fromEmail);

        const galleryUrl = buildGalleryUrl(client);

        await sendTelegram(`📸 <b>New Portal Moments Client</b>

<b>Name:</b> ${clientName}
<b>Email:</b> ${fromEmail}
<b>Subject:</b> ${subject}

<b>Message:</b>
${body.slice(0, 200).trim()}

━━━━━━━━━━━━━━━
✅ <b>Client created automatically</b>

<b>Cloudinary folder:</b>
<code>${folder}/previews/</code>

<b>Gallery link — copy for Template 1:</b>
<code>${galleryUrl}</code>

<b>Your steps:</b>
1️⃣ Drop photos in Desktop upload folder: <code>${folder}/previews/</code>
2️⃣ Send Template 1 to <code>${fromEmail}</code>
   → attach hero photo
   → paste gallery link above`);

        processed++;
      }

      return res.status(200).json({ message: 'Done', processed });
    }

    // ── ACTION: PAYMENT RECEIVED (called by Stripe webhook) ──────────────────
    if (action === 'payment_received') {
      const { clientEmail, packageName, price, selectedPhotos } = req.body;
      if (!clientEmail) return res.status(400).json({ error: 'Missing clientEmail' });

      const client = await redisGet(`client:${clientEmail}`);
      if (!client) return res.status(404).json({ error: 'Client not found' });

      client.status = 'purchased';
      client.package = packageName;
      client.price = price;
      client.selectedPhotos = selectedPhotos;
      client.purchasedAt = new Date().toISOString();
      await redisSet(`client:${clientEmail}`, client);

      // Send Template 3 to client
      await sendGmail(
        gmail,
        clientEmail,
        'Your collection is being prepared ✨',
        template3(client.name, packageName || 'Your package', price || '')
      );

      // Notify Anna
      await sendTelegram(`💳 <b>Payment Received</b>

<b>Client:</b> ${client.name}
<b>Email:</b> ${clientEmail}
<b>Package:</b> ${packageName}
<b>Amount:</b> ${price}

<b>Selected photos:</b>
${selectedPhotos || 'Check Stripe for details'}

━━━━━━━━━━━━━━━
✅ Template 3 sent to client automatically
🎨 <b>Start editing in Lightroom!</b>
📁 Upload edited photos to: <code>${client.folder}/edited/</code>`);

      return res.status(200).json({ message: 'Payment processed' });
    }

    // ── ACTION: MARK DELIVERED ────────────────────────────────────────────────
    if (action === 'mark_delivered') {
      const { clientEmail } = req.body;
      if (!clientEmail) return res.status(400).json({ error: 'Missing clientEmail' });

      const client = await redisGet(`client:${clientEmail}`);
      if (!client) return res.status(404).json({ error: 'Client not found' });

      // Set 30 day expiry from delivery date
      client.status = 'delivered';
      client.expiry = getExpiryDate(30);
      client.deliveredAt = new Date().toISOString();
      await redisSet(`client:${clientEmail}`, client);

      const galleryUrl = buildGalleryUrl(client, 'delivered');

      // Send Template 4 to client
      await sendGmail(
        gmail,
        clientEmail,
        'Your Portal Moments are ready 🌿',
        template4(client.name, galleryUrl)
      );

      // Notify Anna
      await sendTelegram(`✅ <b>Delivered: ${client.name}</b>

Template 4 sent automatically.
Gallery expires: ${client.expiry}

<b>Gallery link:</b>
<code>${galleryUrl}</code>`);

      return res.status(200).json({ message: 'Delivered', expiry: client.expiry });
    }

    // ── ACTION: CHECK EXPIRY & CLEANUP REMINDERS ─────────────────────────────
    if (action === 'check_cleanup') {
      const keys = await (async () => {
        const url = `${process.env.UPSTASH_REDIS_REST_URL}/keys/${encodeURIComponent('client:*')}`;
        const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
        const data = await res.json();
        return data.result || [];
      })();

      const now = new Date();
      let expiringSoon = [];
      let toDelete = [];

      for (const key of keys) {
        const client = await redisGet(key);
        if (!client || !client.deliveredAt) continue;

        const deliveredAt = new Date(client.deliveredAt);
        const daysSinceDelivery = Math.floor((now - deliveredAt) / (1000 * 60 * 60 * 24));

        // Warn Anna when gallery expires in 5 days
        if (client.status === 'delivered' && client.expiry) {
          const daysLeft = Math.ceil((new Date(client.expiry) - now) / (1000 * 60 * 60 * 24));
          if (daysLeft <= 5 && daysLeft > 0) {
            expiringSoon.push({ name: client.name, daysLeft, email: client.email });
          }
        }

        // Flag for Cloudinary cleanup after 60 days
        if (daysSinceDelivery >= 60) {
          toDelete.push({ name: client.name, folder: client.folder, email: client.email });
        }
      }

      if (expiringSoon.length > 0) {
        const list = expiringSoon.map(c => `• ${c.name} — ${c.daysLeft} days left`).join('\n');
        await sendTelegram(`⏰ <b>Galleries Expiring Soon</b>\n\n${list}`);
      }

      if (toDelete.length > 0) {
        const list = toDelete.map(c => `• ${c.name}: <code>${c.folder}</code>`).join('\n');
        await sendTelegram(`🗑️ <b>Ready for Cloudinary Cleanup</b>

These folders are 60+ days past delivery:

${list}

Please delete these folders from Cloudinary to free up storage.`);
      }

      return res.status(200).json({ expiringSoon: expiringSoon.length, toDelete: toDelete.length });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (error) {
    console.error('Agent error:', error);
    await sendTelegram(`⚠️ <b>Portal Moments Agent Error</b>\n\n${error.message}`);
    return res.status(500).json({ error: error.message });
  }
};
