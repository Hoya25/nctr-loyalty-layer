/**
 * Disclosure gate tests.
 *
 * Run:  npm test          (unit only — no network)
 *       npm run test:live (unit + every live endpoint through the gate)
 *
 * The live mode is the member-register gate: it fetches each public endpoint and
 * asserts the actual response body carries no banned finance vocabulary, no
 * vendor name, and no private Beacon field. It is a test so it runs in CI and on
 * every deploy, not a manual sweep that gets skipped when someone is in a hurry.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  project, projectAll, scan, assertClean, DisclosureViolation,
  publicSourceClass, BRAND_PUBLIC_FIELDS, DEMAND_PUBLIC_FIELDS
} from '../src/lib/disclosure.js';

// ── project() fails closed ──────────────────────────────────────────────────

test('project drops any field not on the allowlist', () => {
  const row = { store_name: 'X', bounty_earn_displayed: 0.5, bounty_rate_committed: 0.5 };
  const out = project(row, BRAND_PUBLIC_FIELDS);
  assert.equal(out.store_name, 'X');
  assert.equal(out.bounty_earn_displayed, 0.5);
  assert.ok(!('bounty_rate_committed' in out), 'D13: committed rate must never project');
});

test('project drops a NEW upstream column it has never seen', () => {
  // The point of fail-closed: adding a column upstream must not leak it.
  const row = { store_name: 'X', secret_margin: 0.42, internal_notes: 'do not ship' };
  const out = project(row, BRAND_PUBLIC_FIELDS);
  assert.deepEqual(Object.keys(out), ['store_name']);
});

test('project never mutates its input and handles null', () => {
  const row = { store_name: 'X', bounty_rate_committed: 1 };
  project(row, BRAND_PUBLIC_FIELDS);
  assert.ok('bounty_rate_committed' in row, 'input must be untouched');
  assert.deepEqual(project(null, BRAND_PUBLIC_FIELDS), {});
  assert.deepEqual(projectAll(null, BRAND_PUBLIC_FIELDS), []);
});

test('demand allowlist exposes aggregates only', () => {
  const row = { title: 't', category: 'c', brand_name: 'b', wish_count: 5,
                member_count: 4, member_emails: ['a@b.c'], user_ids: [1, 2] };
  const out = project(row, DEMAND_PUBLIC_FIELDS);
  assert.ok(!('member_emails' in out) && !('user_ids' in out), 'no member identity');
  assert.equal(out.wish_count, 5);
});

// ── vocabulary scan ─────────────────────────────────────────────────────────

test('scan catches banned finance vocabulary in values', () => {
  assert.equal(scan({ note: 'Earn cashback on every order' }).clean, false);
  assert.equal(scan({ note: 'Great APY on deposits' }).clean, false);
  assert.equal(scan({ note: 'DeFi yields via Aerodrome LP' }).clean, false);
  assert.equal(scan({ desc: 'a solid investment opportunity' }).clean, false);
  assert.equal(scan({ x: 'revenue share with brands' }).clean, false);
});

test('scan catches the affiliate vendor name in any position', () => {
  assert.equal(scan({ provider: 'Loyalize' }).clean, false);
  assert.equal(scan({ url: 'https://x/loyalize-redirect' }).clean, false);
  assert.equal(scan({ sources: ['Affiliate commerce commissions (Sovrn Commerce)'] }).clean, false);
  assert.equal(scan({ source_class: 'loyalize_affiliate_rate' }).clean, false);
});

test('scan passes clean member-facing copy', () => {
  const ok = {
    generated_at: '2026-09-01T00:00:00Z',
    brands: [{ store_name: 'Acme', bounty_earn_displayed: 0.5 }],
    tiers: [{ tier: 'bronze', multiplier: 1.1, nctr_per_dollar: 11 }],
    note: 'Committing NCTR qualifies you for a tier. Earn rewards on every order.'
  };
  assert.equal(scan(ok).clean, true, JSON.stringify(scan(ok).hits));
});

test('scan does not false-positive on ordinary words', () => {
  // Word-boundary matching: these must NOT trip the gate.
  assert.equal(scan({ t: 'priceless craftsmanship' }).clean, true);
  assert.equal(scan({ t: 'a returns policy page' }).clean, true);
  assert.equal(scan({ t: 'apparel' }).clean, true);
});

test('assertClean throws DisclosureViolation with the hits', () => {
  assert.throws(() => assertClean({ a: 'cashback' }), (e) => {
    assert.ok(e instanceof DisclosureViolation);
    assert.ok(e.hits.includes('cashback'));
    return true;
  });
});

// ── F7: source_class never passes through raw ───────────────────────────────

test('publicSourceClass maps the vendor-named enum to neutral vocabulary', () => {
  assert.equal(publicSourceClass('loyalize_affiliate_rate'), 'affiliate_provider');
  assert.equal(publicSourceClass('external_affiliate_rate'), 'affiliate_provider');
  assert.equal(publicSourceClass('nctr_base_earn'), 'base');
  assert.equal(publicSourceClass('beacon_brand_rate'), 'brand');
});

test('publicSourceClass fails closed on an unknown enum label', () => {
  // A label added upstream must not pass through as a raw string.
  assert.equal(publicSourceClass('some_new_vendor_rate'), 'other');
  assert.equal(scan({ source: publicSourceClass('loyalize_affiliate_rate') }).clean, true);
});
