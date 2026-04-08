// Telegram webhook — listens for Anna's replies and triggers client creation

async function redisGet(key) {
  const url = `${process.env.UPSTASH_REDIS_REST_URL}/get/${encodeURIComponent(key)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` } });
  const data = await res.json();
  if (!data.result) return null;
  try { return JSON.parse(data.result); } catch { return data.result; }
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

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const update = req.body;
    const message = update.message || update.channel_post;
    if (!message || !message.text) return res.status(200).end();

    const text = message.text.trim();
    const chatId = message.chat.id.toString();

    // Log for debugging
    console.log('Telegram update received. Chat ID:', chatId, 'Expected:', process.env.TELEGRAM_CHAT_ID);

    // Only process messages from Portal Moments HQ channel
    if (chatId !== process.env.TELEGRAM_CHAT_ID) {
      console.log('Chat ID mismatch — ignoring');
      return res.status(200).end();
    }

    // Find most recent pending client
    const pendingKeys = await redisKeys('pending:*');
    if (pendingKeys.length === 0) {
      return res.status(200).end();
    }

    // Sort by most recent
    const pendings = [];
    for (const key of pendingKeys) {
      const p = await redisGet(key);
      if (p) pendings.push(p);
    }
    pendings.sort((a, b) => new Date(b.detectedAt) - new Date(a.detectedAt));
    const pending = pendings[0];

    let confirmedName = null;

    if (text.toLowerCase() === 'confirm') {
      confirmedName = pending.detectedName;
    } else if (text.match(/^[A-Z][a-z]+ [A-Z][a-z]+/i)) {
      // Looks like a name
      confirmedName = text.trim();
    } else {
      // Not a valid reply — ignore
      return res.status(200).end();
    }

    // Call confirm_client action
    const confirmRes = await fetch(`${process.env.VERCEL_URL ? 'https://' + process.env.VERCEL_URL : 'https://portalmoments.com'}/api/agent?action=confirm_client`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.AGENT_SECRET}`
      },
      body: JSON.stringify({
        email: pending.fromEmail,
        confirmedName
      })
    });

    const result = await confirmRes.json();
    if (result.error) {
      await sendTelegram(`⚠️ Error creating client: ${result.error}`);
    }

    return res.status(200).end();

  } catch (error) {
    console.error('Telegram webhook error:', error);
    return res.status(200).end();
  }
};
