const { google } = require('googleapis');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'portalmoments2026';

async function getGmailClient() {
  const oauth2Client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    'https://developers.google.com/oauthplayground'
  );
  oauth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN
  });
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

async function sendTelegram(message) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: process.env.TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    })
  });
}

function extractName(subject, body, fromEmail) {
  // Try to extract name from email signature or greeting
  const namePatterns = [
    /my name is ([A-Z][a-z]+ [A-Z][a-z]+)/i,
    /i'm ([A-Z][a-z]+ [A-Z][a-z]+)/i,
    /this is ([A-Z][a-z]+ [A-Z][a-z]+)/i,
    /^([A-Z][a-z]+ [A-Z][a-z]+)$/m,
  ];
  for (const pattern of namePatterns) {
    const match = body.match(pattern);
    if (match) return match[1];
  }
  // Fall back to email prefix
  const emailName = fromEmail.split('@')[0];
  return emailName.replace(/[._]/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
}

function generateFolder(name) {
  return name.toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '') +
    '-' + new Date().toISOString().slice(0, 10);
}

function getExpiry() {
  const d = new Date();
  d.setDate(d.getDate() + 30);
  return d.toISOString().split('T')[0];
}

function decodeBase64(str) {
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf-8');
}

function getEmailBody(payload) {
  if (payload.body && payload.body.data) {
    return decodeBase64(payload.body.data);
  }
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        return decodeBase64(part.body.data);
      }
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        return decodeBase64(part.body.data).replace(/<[^>]+>/g, ' ');
      }
    }
  }
  return '';
}

module.exports = async function handler(req, res) {
  // Security check
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.AGENT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const gmail = await getGmailClient();

    // Get unread emails from the last 24 hours
    const since = Math.floor((Date.now() - 24 * 60 * 60 * 1000) / 1000);
    const listRes = await gmail.users.messages.list({
      userId: 'me',
      q: `is:unread after:${since} -from:me`,
      maxResults: 10
    });

    const messages = listRes.data.messages || [];

    if (messages.length === 0) {
      return res.status(200).json({ message: 'No new emails', processed: 0 });
    }

    let processed = 0;

    for (const msg of messages) {
      const email = await gmail.users.messages.get({
        userId: 'me',
        id: msg.id,
        format: 'full'
      });

      const headers = email.data.payload.headers;
      const fromHeader = headers.find(h => h.name === 'From')?.value || '';
      const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';

      // Extract email address from "Name <email@example.com>" format
      const emailMatch = fromHeader.match(/<(.+?)>/) || fromHeader.match(/([^\s]+@[^\s]+)/);
      if (!emailMatch) continue;
      const fromEmail = emailMatch[1].toLowerCase().trim();

      // Skip if from portal moments itself
      if (fromEmail.includes('portalmoments')) continue;

      // Get email body
      const body = getEmailBody(email.data.payload);

      // Extract or guess client name
      const clientName = extractName(subject, body, fromEmail);

      // Generate folder name
      const folder = generateFolder(clientName);

      // Generate expiry
      const expiry = getExpiry();

      // Build gallery URL
      const firstName = encodeURIComponent(clientName.split(' ')[0]);
      const fullName = encodeURIComponent(clientName);
      const galleryUrl = `https://portalmoments.com/gallery.html?email=${encodeURIComponent(fromEmail)}&folder=${folder}&name=${firstName}&fullname=${fullName}&expiry=${expiry}`;

      // Send Telegram notification
      const telegramMsg = `📸 <b>New Portal Moments Client</b>

<b>Name:</b> ${clientName}
<b>Email:</b> ${fromEmail}
<b>Subject:</b> ${subject}

<b>Folder:</b> ${folder}
<b>Gallery expires:</b> ${expiry}

<b>Next steps:</b>
1. Upload photos to Cloudinary: <code>${folder}/previews/</code>
2. Send Template 1 email with gallery link
3. Create client in admin panel

<b>Gallery link:</b>
${galleryUrl}`;

      await sendTelegram(telegramMsg);

      // Mark email as read
      await gmail.users.messages.modify({
        userId: 'me',
        id: msg.id,
        requestBody: { removeLabelIds: ['UNREAD'] }
      });

      processed++;
    }

    return res.status(200).json({ message: 'Done', processed });

  } catch (error) {
    console.error('Agent error:', error);
    await sendTelegram(`⚠️ <b>Portal Moments Agent Error</b>\n\n${error.message}`);
    return res.status(500).json({ error: error.message });
  }
};
