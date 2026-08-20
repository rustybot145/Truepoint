// node api/_answers.test.mjs
import assert from 'node:assert/strict';
import { buildRows, renderNote, renderCsv } from './_answers.mjs';

const d = {
  biz: 'Ace "Mobile" Detailing, LLC', first: 'Sam', last: 'Reyes',
  email: 'sam@ace.com', phone: '+16025551234', addr: '1 Main St', city: 'Mesa',
  state: 'AZ', zip: '85201', days: ['Mon', 'Tue'], hours: '8-5',
  services: [{ name: 'Full detail', min: '120', price: '$250' }, { name: '' }],
  ticket: '250', miles: '25',
  notes: 'Call me,\nnot text. He said "no Sundays".',
};

const rows = buildRows(d);
const note = renderNote(rows);
const csv = renderCsv(rows);

// onboarding.mjs slices the note here to strip PII before logging — if this
// header ever changes, that log leaks the client's name, email and address.
assert.ok(note.includes('-- SCHEDULE --'), 'note lost its SCHEDULE header');
assert.ok(note.includes('Contact: Sam Reyes'));

// Every row must be exactly 3 cells or the columns shift mid-sheet.
assert.ok(rows.every((r) => r.length === 3), 'ragged row');

// Named services expand to their own row; blank ones are dropped.
assert.ok(rows.some(([, q, a]) => q === 'Service 1' && a === 'Full detail - 120 min - $250'));
assert.ok(!rows.some(([, q]) => q === 'Service 2'), 'blank service leaked in');

// The escaping that actually matters: a comma, a newline and a quote in one field.
const lines = csv.split('\r\n');
assert.equal(lines[0], '﻿"Section","Question","Answer"');
assert.ok(csv.includes('"Call me,\nnot text. He said ""no Sundays""."'), 'notes not escaped');
assert.ok(csv.includes('"Ace ""Mobile"" Detailing, LLC"'), 'business name not escaped');

// Quotes balance across the whole file — the one check that catches any escape bug.
assert.equal((csv.match(/"/g) || []).length % 2, 0, 'unbalanced quotes');

console.log(`ok — ${rows.length} rows, ${csv.length} bytes of CSV`);
