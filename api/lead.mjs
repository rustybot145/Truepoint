import arcjet, { shield, slidingWindow } from '@arcjet/node';

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: 'LIVE' }),
    slidingWindow({ mode: 'LIVE', interval: 60, max: 5 }),
  ],
});

// Truepoint Digital's Go High Level location — not a secret, safe to hardcode.
const GHL_LOCATION_ID = '5mYqhmiB4HEf6r0CRGoP';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ success: false, message: 'Method not allowed' });
    return;
  }

  const decision = await aj.protect(req);
  if (decision.isDenied()) {
    res.status(decision.reason.isRateLimit() ? 429 : 403).json({ success: false, message: 'Request blocked' });
    return;
  }

  const data = req.body || {};

  // Honeypot — pretend success so bots don't learn to skip this field
  if (data._gotcha) {
    res.status(200).json({ success: true });
    return;
  }

  const email = (data.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    res.status(400).json({ success: false, message: 'Valid email required' });
    return;
  }

  const ghlToken = process.env.GHL_API_KEY;
  if (!ghlToken) {
    console.error('GHL_API_KEY is not set');
    res.status(500).json({ success: false, message: 'Server misconfigured' });
    return;
  }

  try {
    const upstream = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ghlToken}`,
        Version: '2021-07-28',
      },
      body: JSON.stringify({
        locationId: GHL_LOCATION_ID,
        email,
        source: 'Website - Homepage Lead Bar',
        tags: ['website-lead', 'homepage'],
      }),
    });
    const json = await upstream.json();
    res.status(upstream.ok ? 200 : upstream.status).json({ success: upstream.ok, ...json });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Upstream error' });
  }
}
