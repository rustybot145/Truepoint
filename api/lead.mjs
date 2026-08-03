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

  const email = (data.email || '').trim().toLowerCase().slice(0, 254);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ success: false, message: 'Valid email required' });
    return;
  }

  // Optional — present on the step-2 submit (name + phone), absent on step 1 (email only).
  // Upsert matches on email, so this updates the same contact rather than creating a second one.
  // Length caps mirror the HTML maxlength attributes — those are client-side only and
  // trivially bypassed by posting to this endpoint directly, so enforce them here too.
  const firstName = (data.firstName || '').trim().slice(0, 60);
  const lastName = (data.lastName || '').trim().slice(0, 60);
  const phone = (data.phone || '').trim().slice(0, 20);
  const isFirstStep = !firstName && !lastName && !phone;

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
    source: 'Website - Homepage Lead Bar',
    tags,
  };
  if (firstName) payload.firstName = firstName;
  if (lastName) payload.lastName = lastName;
  if (phone) payload.phone = phone;

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

    // Only create the pipeline card on step 1 (email only) — step 2 just enriches
    // the same contact and shouldn't spawn a second card in "Form Filled out."
    if (isFirstStep && contactId) {
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
            name: `Website Lead — ${email}`,
            pipelineStageId: GHL_STAGE_FORM_FILLED_OUT,
            status: 'open',
          }),
        });
        if (!oppRes.ok) {
          console.error('Opportunity creation failed:', await oppRes.text());
        }
      } catch (oppErr) {
        // Contact capture is the critical path — don't fail the whole request
        // just because the pipeline card didn't get created.
        console.error('Opportunity creation error:', oppErr);
      }
    }

    // Step 2 only — add 'phone-captured' as its own call, AFTER the upsert above
    // has already saved firstName/lastName/phone. GHL's Workflow trigger fires off
    // this tag; adding it in a separate, later request (instead of bundled into
    // the same upsert payload) guarantees the trigger reads a contact that already
    // has the name on it, instead of racing the field write.
    if (!isFirstStep && phone && contactId) {
      try {
        const tagRes = await fetch(`https://services.leadconnectorhq.com/contacts/${contactId}/tags`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ghlToken}`,
            Version: '2021-07-28',
          },
          body: JSON.stringify({ tags: ['phone-captured'] }),
        });
        if (!tagRes.ok) {
          console.error('phone-captured tag failed:', await tagRes.text());
        }
      } catch (tagErr) {
        console.error('phone-captured tag error:', tagErr);
      }
    }

    res.status(200).json({ success: true });
  } catch (err) {
    res.status(502).json({ success: false, message: 'Upstream error' });
  }
}
