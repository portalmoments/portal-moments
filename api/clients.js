const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

async function redisGet(key) {
  const res = await fetch(`${REDIS_URL}/get/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return data.result; }
}

async function redisSet(key, value) {
  const res = await fetch(`${REDIS_URL}/set/${encodeURIComponent(key)}/${encodeURIComponent(JSON.stringify(value))}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  return res.json();
}

async function redisDel(key) {
  const res = await fetch(`${REDIS_URL}/del/${encodeURIComponent(key)}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  return res.json();
}

async function getAllClients() {
  const keysRes = await fetch(`${REDIS_URL}/keys/${encodeURIComponent('client:*')}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` }
  });
  const keysData = await keysRes.json();
  const keys = keysData.result || [];
  const clients = [];
  for (const key of keys) {
    const client = await redisGet(key);
    if (client && client.email) clients.push(client);
  }
  clients.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return clients;
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

async function sendGmail(to, subject, body, threadId) {
  const { google } = require('googleapis');
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
  ];
  if (!threadId) {
    headers.push(`Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`);
  }
  headers.push('', body);
  const message = headers.join('\n');

  const encoded = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
  const requestBody = { raw: encoded };
  if (threadId) requestBody.threadId = threadId;

  await gmail.users.messages.send({ userId: 'me', requestBody });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const auth = req.headers.authorization;
  if (!auth || auth !== `Bearer ${process.env.AGENT_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { action } = req.query;

  try {
    // GET all clients
    if (req.method === 'GET' && !action) {
      const clients = await getAllClients();
      return res.status(200).json({ clients });
    }

    // GET single client by email
    if (req.method === 'GET' && action === 'get') {
      const { email } = req.query;
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const client = await redisGet(`client:${email.toLowerCase()}`);
      if (!client) return res.status(404).json({ error: 'Client not found' });
      return res.status(200).json({ client });
    }

    // CREATE client
    if (req.method === 'POST' && action === 'create') {
      const { name, email, folder, date } = req.body;
      if (!name || !email || !folder) return res.status(400).json({ error: 'Missing fields' });
      const key = `client:${email.toLowerCase()}`;
      const existing = await redisGet(key);
      if (existing) return res.status(409).json({ error: 'Client already exists' });
      const client = {
        id: Date.now(),
        name, email: email.toLowerCase(), folder, date,
        status: 'gallery',
        expiry: null,
        revenue: 0,
        createdAt: new Date().toISOString()
      };
      await redisSet(key, client);
      return res.status(200).json({ client });
    }

    // UPDATE client
    if (req.method === 'PUT' && action === 'update') {
      const { email, ...updates } = req.body;
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const key = `client:${email.toLowerCase()}`;
      const client = await redisGet(key);
      if (!client) return res.status(404).json({ error: 'Client not found' });

      // If marking delivered — set expiry and send Template 4
      if (updates.status === 'delivered' && client.status !== 'delivered') {
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + 30);
        updates.expiry = expiry.toISOString().split('T')[0];
        updates.deliveredAt = new Date().toISOString();

        const firstName = client.name.split(' ')[0];
        const firstNameEnc = encodeURIComponent(firstName);
        const fullName = encodeURIComponent(client.name);
        const galleryUrl = `https://www.portalmoments.com/gallery.html?email=${encodeURIComponent(client.email)}&folder=${client.folder}&name=${firstNameEnc}&fullname=${fullName}&expiry=${updates.expiry}&state=delivered`;

        // Send Template 4
        try {
          await sendGmail(
            client.email,
            `Re: ${client.emailSubject || 'Your Portal Moment'}`,
            `Hello ${firstName},

Your photos are here!

I hope when you look at these, you feel exactly what I felt when I captured them.

Access your full gallery here:
${galleryUrl}

Warmly,
Anna Totska
Portal Moments
portalmoments.com
@portalmoments`,
            client.threadId || null
          );
        } catch(e) {
          console.error('Template 4 email error:', e.message);
        }

        // Notify Anna
        try {
          await sendTelegram(`✅ <b>Delivered: ${client.name}</b>

Template 4 sent automatically.
Gallery expires: ${updates.expiry}

<b>Gallery link:</b>
<code>${galleryUrl}</code>`);
        } catch(e) {
          console.error('Telegram notify error:', e.message);
        }
      }

      // If resetting — clear expiry
      if (updates.status === 'gallery') {
        updates.expiry = null;
        updates.deliveredAt = null;
      }

      const updated = { ...client, ...updates };
      await redisSet(key, updated);
      return res.status(200).json({ client: updated });
    }

    // DELETE client
    if (req.method === 'DELETE' && action === 'delete') {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Missing email' });
      await redisDel(`client:${email.toLowerCase()}`);
      return res.status(200).json({ message: 'Deleted' });
    }

    // EXTEND expiry
    if (req.method === 'PUT' && action === 'extend') {
      const { email } = req.body;
      if (!email) return res.status(400).json({ error: 'Missing email' });
      const key = `client:${email.toLowerCase()}`;
      const client = await redisGet(key);
      if (!client) return res.status(404).json({ error: 'Client not found' });
      const current = client.expiry ? new Date(client.expiry) : new Date();
      if (current < new Date()) current.setTime(new Date().getTime());
      current.setDate(current.getDate() + 30);
      client.expiry = current.toISOString().split('T')[0];
      await redisSet(key, client);
      return res.status(200).json({ client });
    }

    return res.status(400).json({ error: 'Unknown action' });

  } catch (error) {
    console.error('Clients API error:', error);
    return res.status(500).json({ error: error.message });
  }
};
