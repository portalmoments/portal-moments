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

async function redisDel(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/del/${encodeURIComponent(key)}`;
  await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
}

async function redisKeys(pattern) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/keys/${encodeURIComponent(pattern)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
  const data = await res.json();
  return data.result || [];
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

// BLOCK automated senders and subjects
function isAutomatedEmail(fromEmail, subject) {
  // Block these sender domains completely
  const blockedDomains = [
    'noreply', 'no-reply', 'donotreply', 'do-not-reply',
    'accounts.google.com', 'mail.google.com',
    'notifications.google.com', 'support.google.com',
    'apple.com', 'icloud.com', 'appleid.apple.com',
    'stripe.com', 'vercel.com', 'github.com',
    'cloudinary.com', 'anthropic.com', 'namecheap.com',
    'upstash.com', 'x.com', 'twitter.com',
    'linkedin.com', 'facebook.com', 'instagram.com',
    'paypal.com', 'shopify.com', 'mailchimp.com',
    'sendgrid.net', 'amazonses.com', 'vistaprint'
  ];
  for (const domain of blockedDomains) {
    if (fromEmail.includes(domain)) return true;
  }

  // Block these subject patterns
  const blockedSubjects = [
    'security alert', 'new sign-in', 'sign-in attempt',
    'account access', 'verify your', 'confirm your email',
    'suspicious activity', 'unusual activity',
    'password', 'two-factor', '2-step verification',
    'receipt for', 'invoice', 'your invoice',
    'payment received', 'payment confirmation',
    'your order', 'order confirmation', 'shipment',
    'subscription', 'unsubscribe', 'notification',
    'automated', 'do not reply', 'no reply',
    'billing', 'statement', 'transaction',
    'welcome to', 'activate your', 'please verify',
    'thanks for signing up', 'account created'
  ];
  const subjectLower = subject.toLowerCase();
  for (const s of blockedSubjects) {
    if (subjectLower.includes(s)) return true;
  }

  return false;
}

// ALLOW only real client emails with photography keywords
function isRealClientEmail(subject, body) {
  const text = (subject + ' ' + body).toLowerCase();
  const clientKeywords = [
    'photo', 'photos', 'picture', 'pictures', 'photograph',
    'shoot', 'session', 'moment', 'shot',
    'you took', 'you photographed', 'you approached',
    'i met you', 'met you', 'you came up',
    'the photographer', 'a photographer',
    'free photo', 'my photo', 'my picture',
    'yesterday', 'this afternoon', 'this morning',
    'last night', 'today at', 'earlier today',
    'park', 'street', 'downtown', 'market',
    'distillery', 'kensington', 'bellwoods',
    'high park', 'waterfront',
    'i was wearing', 'i had on', 'i was sitting',
    'i was standing', 'i was walking',
  ];
  for (const keyword of clientKeywords) {
    if (text.includes(keyword)) return true;
  }
  return false;
}

// Extract display name from "Anna Totska <anna@email.com>"
function extractDisplayName(fromHeader) {
  // Match: Anna Totska <email> or "Anna Totska" <email>
  const match = fromHeader.match(/^"?([^"<]+)"?\s*</);
  if (match) {
    const name = match[1].trim();
    // Make sure it's not an email address itself
    if (!name.includes('@') && name.length > 1) {
      return name;
    }
  }
  return null;
}

function generateFolder(name) {
  const date = new Date().toISOString().slice(5, 10).replace('-', '');
  const parts = name.trim().split(/\s+/);
  const first = (parts[0] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const last = (parts[1] || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  return last ? `${first}-${last}-${date}` : `${first}-${date}`;
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
  const isCron = req.headers['x-vercel-cron'] === '1';
  if (req.method !== 'POST' && !isCron) return res.status(405).json({ error: 'Method not allowed' });
  if (!isCron && req.headers.authorization !== `Bearer ${process.env.AGENT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const action = req.body?.action || 'check_emails';

  try {
    // ── CONFIRM CLIENT (called after Anna replies in Telegram) ──────────────
    if (action === 'confirm_client') {
      const { email, confirmedName } = req.body;
      if (!email) return res.status(400).json({ error: 'Missing email' });

      const pendingKey = `pending:${email}`;
      const pending = await redisGet(pendingKey);
      if (!pending) return res.status(404).json({ error: 'No pending client' });

      const clientName = confirmedName || pending.detectedName;
      const folder = generateFolder(clientName);

      const client = {
        id: Date.now(),
        name: clientName,
        email: email.toLowerCase(),
        folder,
        status: 'gallery',
        expiry: null,
        revenue: 0,
        createdAt: new Date().toISOString(),
        emailSubject: pending.subject,
        threadId: pending.threadId || null,
        messageId: pending.messageId || null
      };

      await redisSet(`client:${email}`, client);
      await redisDel(pendingKey);

      const firstName = encodeURIComponent(clientName.split(' ')[0]);
      const fullName = encodeURIComponent(clientName);
      const galleryUrl = `https://www.portalmoments.com/gallery.html?email=${encodeURIComponent(email)}&folder=${folder}&name=${firstName}&fullname=${fullName}`;

      await sendTelegram(`✅ <b>Client Created: ${clientName}</b>

<b>Email:</b> ${email}
<b>Cloudinary folder:</b> <code>${folder}/previews/</code>

<b>Gallery link — copy for Template 1:</b>
<code>${galleryUrl}</code>

━━━━━━━━━━━━━━━
<b>Your next steps:</b>
1️⃣ Create Desktop folder: <code>${folder}/previews/</code>
2️⃣ Drop unedited photos there
3️⃣ Send Template 1 to <code>${email}</code>
   → Attach free hero photo
   → Paste gallery link above`);

      return res.status(200).json({ message: 'Client created', client });
    }

    // ── CHECK EMAILS ────────────────────────────────────────────────────────
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
      const subject = headers.find(h => h.name === 'Subject')?.value || '';

      const emailMatch = fromHeader.match(/<(.+?)>/) || fromHeader.match(/([^\s]+@[^\s]+)/);
      if (!emailMatch) {
        await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] } });
        continue;
      }
      const fromEmail = emailMatch[1].toLowerCase().trim();

      // Mark read regardless
      await gmail.users.messages.modify({ userId: 'me', id: msg.id, requestBody: { removeLabelIds: ['UNREAD'] } });

      // Skip portalmoments own emails
      if (fromEmail.includes('portalmoments')) continue;

      // Block automated senders and subjects
      if (isAutomatedEmail(fromEmail, subject)) continue;

      const body = getEmailBody(email.data.payload);

      // Only process real client emails with photography keywords
      if (!isRealClientEmail(subject, body)) continue;

      // Skip existing clients
      if (await redisGet(`client:${fromEmail}`)) continue;

      // Skip if already pending
      if (await redisGet(`pending:${fromEmail}`)) continue;

      // Extract name — best source is display name from email header
      const displayName = extractDisplayName(fromHeader);
      const detectedName = displayName || fromEmail.split('@')[0].replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      const folder = generateFolder(detectedName);

      // Get thread ID and message ID from email
      const threadId = email.data.threadId || null;
      const messageId = email.data.payload.headers.find(h => h.name === 'Message-ID')?.value || null;

      // Save as pending — waiting for Anna's confirmation
      await redisSet(`pending:${fromEmail}`, {
        detectedName,
        fromEmail,
        folder,
        subject,
        threadId,
        messageId,
        bodyPreview: body.slice(0, 300),
        detectedAt: new Date().toISOString()
      });

      // Ask Anna to confirm name
      await sendTelegram(`📸 <b>New Portal Moments Inquiry</b>

<b>Detected name:</b> ${detectedName}
<b>Email:</b> ${fromEmail}
<b>Subject:</b> ${subject}

<b>Message:</b>
${body.slice(0, 200).trim()}

━━━━━━━━━━━━━━━
<b>Reply to confirm or correct name:</b>

✅ Reply <b>confirm</b> — use <b>${detectedName}</b>
✏️ Or type the correct name: <i>Sarah Johnson</i>`);

      processed++;
    }

    return res.status(200).json({ message: 'Done', processed });

  } catch (error) {
    console.error('Agent error:', error);
    await sendTelegram(`⚠️ <b>Portal Moments Agent Error</b>\n\n${error.message}`);
    return res.status(500).json({ error: error.message });
  }
};
