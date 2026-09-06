/**
 * Open Bounty Schema conformance.
 *
 * These tests validate the Worker's objects against the SCHEMA AS PUBLISHED —
 * fetched from the public repo rather than a vendored copy — because a vendored
 * copy silently stops proving anything the moment the spec moves. The validator
 * below is deliberately small and generic: it is driven entirely by the fetched
 * schema, so it does not encode a second opinion about what the rules are.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { allianceBounty, brandBounty, isoDate } from '../src/lib/bounty-schema.js';
import { scan } from '../src/lib/disclosure.js';

const SCHEMA_URL =
  'https://raw.githubusercontent.com/Hoya25/open-bounty-schema/main/schema/bounty.schema.json';

/** Generic check driven by the fetched schema: required, additionalProperties, enum, pattern, type. */
function validate(doc, schema, path = '') {
  const errors = [];
  for (const key of schema.required || []) {
    if (!(key in doc)) errors.push(`${path}/${key} is required`);
  }
  if (schema.additionalProperties === false) {
    for (const key of Object.keys(doc)) {
      if (!schema.properties?.[key]) errors.push(`${path}/${key} is not permitted`);
    }
  }
  for (const [key, sub] of Object.entries(schema.properties || {})) {
    if (!(key in doc)) continue;
    const val = doc[key];
    const at = `${path}/${key}`;
    if (sub.type === 'object' && val && typeof val === 'object') {
      errors.push(...validate(val, sub, at));
    }
    if (sub.enum && !sub.enum.includes(val)) errors.push(`${at} must be one of ${sub.enum.join('|')}`);
    if (sub.pattern && !new RegExp(sub.pattern).test(String(val))) errors.push(`${at} fails pattern ${sub.pattern}`);
    if (sub.type === 'string' && typeof val !== 'string') errors.push(`${at} must be a string`);
    if (sub.type === 'boolean' && typeof val !== 'boolean') errors.push(`${at} must be a boolean`);
    if (sub.maxLength && String(val).length > sub.maxLength) errors.push(`${at} exceeds maxLength`);
  }
  return errors;
}

// Top-level await: the schema must be loaded BEFORE the tests below are
// registered. An earlier version fetched it inside a test and guarded the rest
// with `{ skip: () => !schema }` — but node's skip option takes a boolean, and a
// function is always truthy, so every conformance test silently skipped and
// proved nothing. Fetching here removes the guard entirely.
const schemaRes = await fetch(SCHEMA_URL);
if (!schemaRes.ok) throw new Error(`published schema unreachable: HTTP ${schemaRes.status}`);
const schema = await schemaRes.json();

test('the published schema is draft 2020-12', () => {
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
});

test('the Alliance program object conforms', () => {
  const errors = validate(allianceBounty(), schema);
  assert.deepEqual(errors, [], errors.join('; '));
});

test('a brand object conforms', () => {
  const doc = brandBounty({ public_slug: 'example-brand', updated_at: '2026-09-01T12:00:00Z' });
  assert.deepEqual(validate(doc, schema), []);
  assert.equal(doc.api, 'https://api.nctr.live/v1/bounties/example-brand');
  assert.equal(doc.updated_at, '2026-09-01');
});

test('the validator actually rejects — it is not a rubber stamp', () => {
  const bad = { ...allianceBounty(), rate: 0.05 };
  delete bad.active;
  const errors = validate(bad, schema);
  assert.ok(errors.some((e) => /active is required/.test(e)));
  assert.ok(errors.some((e) => /rate is not permitted/.test(e)));
});

test('earn.display carries no rate, price or banned vocabulary', () => {
  // Display over math: a sentence, never a manufactured number. Beacon's
  // bounty_earn_displayed has no documented unit, so it must never be rendered
  // into this string.
  const display = allianceBounty().earn.display;
  assert.ok(scan(display).clean);
  assert.ok(!/\d/.test(display), 'no digits — a rate here would invite false precision');
});

test('isoDate yields a date, never a timestamp', () => {
  assert.match(isoDate('2026-09-01T12:34:56Z'), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(isoDate(null), /^\d{4}-\d{2}-\d{2}$/);
  assert.match(isoDate('not a date'), /^\d{4}-\d{2}-\d{2}$/);
});

test('a brand slug is URL-encoded into the api field', () => {
  const doc = brandBounty({ public_slug: 'a b/c', updated_at: null });
  assert.ok(!/ /.test(doc.api));
  assert.match(doc.api, /a%20b%2Fc/);
});
