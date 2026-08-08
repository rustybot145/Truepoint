import arcjet, { shield, slidingWindow } from '@arcjet/node';

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: 'LIVE' }),
    slidingWindow({ mode: 'LIVE', interval: 60, max: 5 }),
  ],
});

// Truepoint Digital's Go High Level location, pipeline, and stage — not secrets, safe to hardcode.
const GHL_LOCATION_ID = '5mYqhmiB4HEf6r0CRGoP';
const GHL_PIPELINE_ID = 'pPxe0mptXps4zahDHmoL'; // Business Pipeline
const GHL_STAGE_FORM_FILLED_OUT = '572834fe-396b-4093-ac34-b9754d2fa4b2'; // "Form Filled out" stage

// GHL expects E.164 (+16021234567). A raw "(602) 123-4567" or "602-123-4567"
// from the input can get silently dropped by the upstream API — this is the
// most common reason a phone number "doesn't go through" on a CRM integration.
function toE164(raw) {
  const digits = raw.replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

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

  // Length caps mirror the HTML maxlength attributes — those are client-side only
  // and trivially bypassed by posting to this endpoint directly, so enforce them here.
  const email = (data.email || '').trim().toLowerCase().slice(0, 254);
  const firstName = (data.firstName || '').trim().slice(0, 60);
  const rawPhone = (data.phone || '').trim().slice(0, 20);
  const businessName = (data.businessName || '').trim().slice(0, 100);
  const businessNiche = (data.businessNiche || '').trim().slice(0, 100);

  // Real value from the required consent checkbox — captured but not yet sent to
  // GHL. TODO once the "Wants SMS" custom field exists in GHL: add it to `payload`
  // below as `customFields: [{ key: '<the real key>', field_value: wantsSms ? 'Yes' : 'No' }]`.
  // Not guessing the key here — a wrong key fails silently and is worse than leaving
  // this as a visible gap. See Packages.md.
  const wantsSms = data.wantsSms === true;

  // Nothing reaches GHL until the whole form is filled in. The contact and the
  // pipeline card are created once, from one complete submission, so the
  // Workflows never trigger on a half-empty contact and then get patched after.
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !firstName || !businessName || !businessNiche || !wantsSms) {
    res.status(400).json({ success: false, message: 'All fields are required' });
    return;
  }

  const phone = toE164(rawPhone);
  if (!phone) {
    res.status(400).json({ success: false, message: 'Valid US phone number required' });
    return;
  }

  const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  // Accept either name — the Vercel var is GHLMCP, local .env uses GHL_API_KEY.
  const ghlToken = process.env.GHLMCP || process.env.GHL_API_KEY;
  if (!ghlToken) {
    console.error('No GHL token: neither GHLMCP nor GHL_API_KEY is set');
    res.status(500).json({ success: false, message: 'Server misconfigured' });
    return;
  }

  const tags = ['website-lead', 'homepage'];

  const payload = {
    locationId: GHL_LOCATION_ID,
    email,
    firstName,
    phone,
    companyName: businessName,
    source: 'Social Media Landing Page',
    tags,
  };

  try {
    const upstream = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${ghlToken}`,
        Version: '2021-07-28',
      },
      body: JSON.stringify(payload),
    });
    const json = await upstream.json();

    if (!upstream.ok) {
      // Log the real GHL error server-side for debugging, but don't hand the raw
      // upstream response (internal IDs, field names) to whoever's calling this.
      console.error('GHL contact upsert failed:', json);
      res.status(upstream.status).json({ success: false, message: 'Upstream error' });
      return;
    }

    const contactId = json.contact ? json.contact.id : json.id;

    // One card, created once, already named — no follow-up rename pass.
    if (contactId) {
      try {
        const oppRes = await fetch('https://services.leadconnectorhq.com/opportunities/', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ghlToken}`,
            Version: '2021-07-28',
          },
          body: JSON.stringify({
            pipelineId: GHL_PIPELINE_ID,
            locationId: GHL_LOCATION_ID,
            contactId,
            name: `${firstName} — ${businessName} — ${today}`,
            pipelineStageId: GHL_STAGE_FORM_FILLED_OUT,
            status: 'open',
          }),
        });
        if (!oppRes.ok) {
          console.error('Opportunity creation failed:', await oppRes.json());
        }
      } catch (oppErr) {
        // Contact capture is the critical path — don't fail the whole request
        // just because the pipeline card didn't get created.
        console.error('Opportunity creation error:', oppErr);
      }
    }

    res.status(200).json({ success: true });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Upstream error' });
  }
}
