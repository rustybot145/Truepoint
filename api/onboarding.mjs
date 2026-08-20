import arcjet, { shield, slidingWindow } from '@arcjet/node';
import { buildRows, renderNote, renderCsv } from './_answers.mjs';

const aj = arcjet({
  key: process.env.ARCJET_KEY,
  rules: [
    shield({ mode: 'LIVE' }),
    // Lower than lead.mjs's 5/min — a client submits this once, not repeatedly.
    slidingWindow({ mode: 'LIVE', interval: 60, max: 3 }),
  ],
});

// Same location as lead.mjs — not a secret, safe to hardcode.
const GHL_LOCATION_ID = '5mYqhmiB4HEf6r0CRGoP';

// Same normalizer as lead.mjs. GHL silently drops a non-E.164 number.
function toE164(raw) {
  const digits = (raw || '').replace(/\D/g, '');
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return '';
}

const s = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// Emails the answers to Ben as a spreadsheet. The `onboarding-complete` tag in
// GHL is passive — nothing announces a submission — so this is the only thing
// that actually tells him a client finished the form.
// Never allowed to fail the request: the client is done either way.
async function emailAnswers(d, rows) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.ONBOARDING_NOTIFY_EMAIL;
  if (!key || !to) {
    console.error('Onboarding email skipped: RESEND_API_KEY or ONBOARDING_NOTIFY_EMAIL not set');
    return false;
  }

  const biz = d.biz || 'Unknown business';
  const slug = biz.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase() || 'client';
  const date = new Date().toISOString().slice(0, 10);

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      // resend.dev is Resend's shared sender and only delivers to the account
      // owner — fine here, since this only ever mails Ben. Set ONBOARDING_FROM
      // to a truepoint.agency address once that domain is verified in Resend.
      from: process.env.ONBOARDING_FROM || 'True Point Digital <onboarding@resend.dev>',
      to: [to],
      subject: `Onboarding form: ${biz}`,
      text: `${biz} finished the onboarding form.\n\nAll ${rows.length} answers are in the attached spreadsheet.\n\n${renderNote(rows)}\n`,
      attachments: [{
        filename: `onboarding-${slug}-${date}.csv`,
        content: Buffer.from(renderCsv(rows), 'utf8').toString('base64'),
      }],
    }),
  });

  if (!res.ok) {
    console.error('Resend failed:', res.status, await res.text());
    return false;
  }
  return true;
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

  const raw = req.body || {};

  // Honeypot — same trick as lead.mjs: pretend success so bots don't adapt.
  if (raw._gotcha) {
    res.status(200).json({ success: true });
    return;
  }

  // Caps mirror the HTML maxlength attributes, which are client-side only and
  // trivially bypassed by posting here directly.
  const d = {
    biz: s(raw.biz, 100),
    first: s(raw.first, 60),
    last: s(raw.last, 60),
    email: s(raw.email, 254).toLowerCase(),
    phone: s(raw.phone, 20),
    addr: s(raw.addr, 120),
    city: s(raw.city, 60),
    state: s(raw.state, 30),
    zip: s(raw.zip, 12),
    site: s(raw.site, 200),
    ig: s(raw.ig, 200),
    gbp: s(raw.gbp, 300),
    tz: s(raw.tz, 40),
    days: Array.isArray(raw.days) ? raw.days.slice(0, 7).map((x) => s(x, 10)) : [],
    hours: s(raw.hours, 60),
    services: Array.isArray(raw.services)
      ? raw.services.slice(0, 15).map((sv) => ({
          name: s(sv && sv.name, 80),
          min: s(sv && sv.min, 6),
          price: s(sv && sv.price, 20),
        }))
      : [],
    sizePricing: s(raw.sizePricing, 10),
    perday: s(raw.perday, 4),
    miles: s(raw.miles, 5),
    deposit: s(raw.deposit, 30),
    depamt: s(raw.depamt, 20),
    ticket: s(raw.ticket, 8),
    slowest: s(raw.slowest, 10),
    rebook: s(raw.rebook, 12),
    missed: s(raw.missed, 6),
    mcnum: s(raw.mcnum, 20),
    problem: s(raw.problem, 60),
    notes: s(raw.notes, 1000),
  };

  if (!d.email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email)) {
    res.status(400).json({ success: false, message: 'Valid email required' });
    return;
  }

  const phone = toE164(d.phone);
  if (d.phone && !phone) {
    res.status(400).json({ success: false, message: 'Valid US phone number required' });
    return;
  }
  d.phone = phone || d.phone;
  if (d.mcnum) d.mcnum = toE164(d.mcnum) || d.mcnum;

  const ghlToken = process.env.GHLMCP || process.env.GHL_API_KEY;
  if (!ghlToken) {
    console.error('No GHL token: neither GHLMCP nor GHL_API_KEY is set');
    res.status(500).json({ success: false, message: 'Server misconfigured' });
    return;
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ghlToken}`,
    Version: '2021-07-28',
  };

  // Native contact fields only — nothing here needs a custom field created in GHL
  // first, so there's no field key to guess wrong and fail silently.
  const payload = {
    locationId: GHL_LOCATION_ID,
    email: d.email,
    source: 'Client Onboarding Form',
    tags: ['onboarding-complete', 'client'],
  };
  if (d.first) payload.firstName = d.first;
  if (d.last) payload.lastName = d.last;
  if (phone) payload.phone = phone;
  if (d.biz) payload.companyName = d.biz;
  if (d.addr) payload.address1 = d.addr;
  if (d.city) payload.city = d.city;
  if (d.state) payload.state = d.state;
  if (d.zip) payload.postalCode = d.zip;
  if (d.site) payload.website = d.site;
  if (d.tz) payload.timezone = d.tz;

  try {
    const upstream = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
    const json = await upstream.json();

    if (!upstream.ok) {
      console.error('GHL contact upsert failed:', json);
      res.status(upstream.status).json({ success: false, message: 'Upstream error' });
      return;
    }

    const contactId = json.contact ? json.contact.id : json.id;

    // The answers themselves. If this fails the contact still exists but the
    // answers would be lost, so they get logged instead — recoverable from
    // Vercel's function logs rather than gone.
    let noteSaved = false;
    const rows = buildRows(d);
    const note = renderNote(rows);

    // If the note fails, the answers are the only thing actually at risk — the
    // contact's name/email/phone/address already saved above. Log just the
    // answers so recovery is possible without duplicating PII into the logs.
    const cut = note.indexOf('-- SCHEDULE --');
    const recoverable = cut === -1 ? note : note.slice(cut);

    if (contactId) {
      try {
        const noteRes = await fetch(
          `https://services.leadconnectorhq.com/contacts/${contactId}/notes`,
          { method: 'POST', headers, body: JSON.stringify({ body: note }) }
        );
        if (noteRes.ok) {
          noteSaved = true;
        } else {
          console.error('GHL note failed:', await noteRes.text());
          console.error(`UNSAVED ONBOARDING ANSWERS for contact ${contactId} >>>\n` + recoverable);
        }
      } catch (noteErr) {
        console.error('GHL note error:', noteErr);
        console.error(`UNSAVED ONBOARDING ANSWERS for contact ${contactId} >>>\n` + recoverable);
      }
    }

    // Same rule as the note: a mail failure is Ben's problem to chase in the
    // logs, not something to show a client who has already finished.
    let emailed = false;
    try {
      emailed = await emailAnswers(d, rows);
    } catch (mailErr) {
      console.error('Onboarding email error:', mailErr);
    }
    if (!emailed) {
      console.error(`UNSENT ONBOARDING EMAIL >>>\n` + recoverable);
    }

    // The client is done either way — the contact is saved and the answers are
    // in the logs. Don't show them a failure they can't act on.
    res.status(200).json({ success: true, noteSaved, emailed });
  } catch (err) {
    console.error('Onboarding submit error:', err);
    res.status(502).json({ success: false, message: 'Upstream error' });
  }
}
