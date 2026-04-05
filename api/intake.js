const { google } = require('googleapis');

async function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({ refresh_token: process.env.GMAIL_REFRESH_TOKEN });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

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

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: message, parse_mode: 'HTML' })
  });
}

function isAutomatedEmail(fromEmail, subject, body) {
  const automatedSenders = [
    'noreply', 'no-reply', 'donotreply', 'do-not-reply',
    'notifications', 'support@upstash', 'hello@upstash',
    'stripe.com', 'vercel.com', 'github.com', 'cloudinary.com',
    'google.com', 'anthropic.com', 'namecheap.com'
  ];
  for (const sender of automatedSenders) {
    if (fromEmail.includes(sender)) return true;
  }
  const automatedSubjects = [
    'welcome to', 'verify your', 'confirm your', 'receipt for',
    'invoice', 'payment received', 'your order', 'subscription',
    'unsubscribe', 'account created', 'reset your password',
    'newsletter', 'notification', 'automated'
  ];
  const subjectLower = subject.toLowerCase();
  for (const s of automatedSubjects) {
    if (subjectLower.includes(s)) return true;
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.headers.authorization !== `Bearer ${process.env.AGENT_SECRET}`) return res.status(401).json({ error: 'Unauthorized' });

  try {
    const gmail = await getGmailClient();
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
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';

      const emailMatch = fromHeader.match(/<(.+?)>/) || fromHeader.match(/([^\s]+@[^\s]+)/);
      if (!emailMatch) continue;
      const fromEmail = emailMatch[1].toLowerCase().trim();

      // Skip portalmoments own emails
      if (fromEmail.includes('portalmoments')) continue;

      const body = getEmailBody(email.data.payload);

      // Skip automated emails
      if (isAutomatedEmail(fromEmail, subject, body)) {
        await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] } });
        continue;
      }

      // Skip if client already exists
      const existingKey = `client:${fromEmail}`;
      const existing = await redisGet(existingKey);
      if (existing) {
        await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] } });
        continue;
      }

      const clientName = extractName(body, fromEmail);
      const folder = generateFolder(clientName);

      // Create client — no expiry until delivery
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

      // Gallery link — no expiry parameter yet
      const firstName = encodeURIComponent(clientName.split(' ')[0]);
      const fullName = encodeURIComponent(clientName);
      const galleryUrl = `https://portalmoments.com/gallery.html?email=${encodeURIComponent(fromEmail)}&folder=${folder}&name=${firstName}&fullname=${fullName}`;

      const telegramMsg = `📸 <b>New Portal Moments Client</b>

<b>Name:</b> ${clientName}
<b>Email:</b> ${fromEmail}
<b>Subject:</b> ${subject}

<b>Message:</b>
${body.slice(0, 150).trim()}

━━━━━━━━━━━━━━━
✅ <b>Client created automatically</b>

<b>Cloudinary folder:</b>
<code>${folder}/previews/</code>

<b>Gallery link — copy for Template 1:</b>
<code>${galleryUrl}</code>

<b>Your steps:</b>
1️⃣ Drop photos in: <code>Portal Moments Uploads/${folder}/previews/</code>
2️⃣ Send Template 1 to <code>${fromEmail}</code>
   → attach hero photo
   → paste gallery link`;

      await sendTelegram(telegramMsg);
      await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] } });

      processed++;
    }

    return res.status(200).json({ message: 'Done', processed });

  } catch (error) {
    console.error('Agent error:', error);
    await sendTelegram(`⚠️ <b>Portal Moments Agent Error</b>\n\n${error.message}`);
    return res.status(500).json({ error: error.message });
  }
};
