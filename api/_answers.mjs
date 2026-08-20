// Every onboarding answer in ONE list: [section, question, answer].
// The GHL note and the emailed spreadsheet both render from this, so a new
// question can't land in one and quietly go missing from the other.
// Leading underscore keeps Vercel from routing this as an endpoint.

export function buildRows(d) {
  const rows = [
    ['BUSINESS', 'Business', d.biz],
    ['BUSINESS', 'Contact', [d.first, d.last].filter(Boolean).join(' ')],
    ['BUSINESS', 'Phone', d.phone],
    ['BUSINESS', 'Email', d.email],
    ['BUSINESS', 'Address', [d.addr, d.city, d.state, d.zip].filter(Boolean).join(', ')],
    ['BUSINESS', 'Website', d.site],
    ['BUSINESS', 'Instagram', d.ig],
    ['BUSINESS', 'Google', d.gbp],
    ['SCHEDULE', 'Days', (d.days || []).join(', ')],
    ['SCHEDULE', 'Hours', d.hours],
  ];

  // One row per service so each is its own line in the sheet, not a blob.
  (d.services || []).forEach((sv, i) => {
    if (sv && sv.name) {
      rows.push(['SCHEDULE', `Service ${i + 1}`, `${sv.name} - ${sv.min || '?'} min - ${sv.price || '?'}`]);
    }
  });

  rows.push(
    ['SCHEDULE', 'Price varies by vehicle size', d.sizePricing],
    ['SCHEDULE', 'Max jobs/day', d.perday],
    ['SCHEDULE', 'Drive radius', d.miles ? `${d.miles} mi` : ''],
    ['SCHEDULE', 'Deposit', [d.deposit, d.depamt].filter(Boolean).join(' ')],
    ['NUMBERS', 'Average job', d.ticket ? `$${d.ticket}` : ''],
    ['NUMBERS', 'Slowest day', d.slowest],
    ['NUMBERS', 'Rebook after', d.rebook],
    ['PHONE', 'Missed-call text-back', d.missed],
    ['PHONE', 'Rings on', d.mcnum],
    ['WHAT THEY WANT', 'Bigger problem', d.problem],
    ['WHAT THEY WANT', 'Questions / requests', d.notes]
  );

  return rows;
}

// Section headers stay exactly `-- NAME --`: onboarding.mjs slices the note at
// '-- SCHEDULE --' to strip PII before logging unsaved answers.
export function renderNote(rows) {
  const out = ['ONBOARDING FORM', ''];
  let section = '';
  rows.forEach(([sec, label, value]) => {
    if (sec !== section) {
      if (section) out.push('');
      out.push(`-- ${sec} --`);
      section = sec;
    }
    out.push(`${label}: ${value || '-'}`);
  });
  return out.join('\n');
}

// RFC 4180: quote every field, double any quote inside it. The notes field runs
// to 1000 chars of free text — a naive join on commas corrupts the whole sheet
// the first time a client types a comma or hits return.
const cell = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

export function renderCsv(rows) {
  // Leading BOM so Excel opens it as UTF-8 instead of mangling anything non-ASCII.
  return '\uFEFF' + [['Section', 'Question', 'Answer'], ...rows]
    .map((r) => r.map(cell).join(','))
    .join('\r\n');
}
