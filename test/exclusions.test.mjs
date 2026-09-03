/**
 * Public feed exclusion tests.
 *
 * The behaviour under test is that a named slug is unreachable on EVERY public
 * surface, and that the mechanism fails in the safe direction: unknown brands
 * are published, only named ones are withheld.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { EXCLUDED_SLUGS, isExcluded, withoutExcluded } from '../src/lib/exclusions.js';

const DEV_STORE = 'ri7pme-15-myshopify-com';

test('the dev store is excluded', () => {
  assert.equal(isExcluded(DEV_STORE), true);
});

test('exclusion is case-insensitive', () => {
  assert.equal(isExcluded('RI7PME-15-MYSHOPIFY-COM'), true);
});

test('unnamed brands are NOT excluded — fails in the safe direction', () => {
  // A real merchant must be published by default, including one still on a
  // myshopify.com hostname. This is the case a pattern-based filter would break.
  assert.equal(isExcluded('patagonia'), false);
  assert.equal(isExcluded('some-real-brand-myshopify-com'), false);
  assert.equal(isExcluded(''), false);
  assert.equal(isExcluded(null), false);
  assert.equal(isExcluded(undefined), false);
});

test('withoutExcluded drops only excluded rows', () => {
  const rows = [
    { public_slug: DEV_STORE, store_name: 'dev' },
    { public_slug: 'real-brand', store_name: 'Real' }
  ];
  const out = withoutExcluded(rows);
  assert.equal(out.length, 1);
  assert.equal(out[0].public_slug, 'real-brand');
});

test('withoutExcluded is safe on null and non-arrays', () => {
  assert.deepEqual(withoutExcluded(null), []);
  assert.deepEqual(withoutExcluded(undefined), []);
  assert.deepEqual(withoutExcluded('nope'), []);
});

test('withoutExcluded tolerates rows missing the slug key', () => {
  const rows = [{ store_name: 'no slug' }, { public_slug: DEV_STORE }];
  assert.equal(withoutExcluded(rows).length, 1);
});

test('every entry documents why it is here and what removes it', () => {
  // An undocumented exclusion is indistinguishable from a bug six months later.
  for (const [slug, meta] of EXCLUDED_SLUGS) {
    assert.ok(slug && slug === slug.toLowerCase(), `${slug} must be lowercase`);
    assert.ok(meta.reason && meta.reason.length > 20, `${slug} needs a reason`);
    assert.ok(meta.removes_when, `${slug} needs a removes_when`);
    assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(meta.added), `${slug} needs an added date`);
  }
});
