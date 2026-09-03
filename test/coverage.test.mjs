/**
 * Two-supply coverage tests.
 *
 * The invariants that matter here are epistemic, not cosmetic: the Worker must
 * never claim a brand is absent unless it actually reached both systems, and it
 * must never surface the discovery layer's vendor-bearing columns.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { checkCoverage, sanitize, DISCOVERY_COLUMNS } from '../src/v1/coverage.js';
import { scan } from '../src/lib/disclosure.js';

// ── the column allowlist is the leak-prevention mechanism ───────────────────

test('discovery layer select is narrow and carries no forbidden column', () => {
  assert.equal(DISCOVERY_COLUMNS, 'name,category');
  assert.ok(!/affiliate_url|logo_url|description|_id/.test(DISCOVERY_COLUMNS),
    'never widen this select — affiliate_url and the vendor-named id must not be read');
  assert.ok(scan(DISCOVERY_COLUMNS).clean);
});

// ── query sanitisation ──────────────────────────────────────────────────────

test('sanitize strips PostgREST filter syntax', () => {
  for (const ch of [',', '.', '(', ')', '*', ':', '%', '\\']) {
    assert.ok(!sanitize(`ni${ch}ke`).includes(ch), `${ch} must be stripped`);
  }
});

test('sanitize caps length and trims', () => {
  assert.equal(sanitize('  nike  '), 'nike');
  assert.ok(sanitize('x'.repeat(500)).length <= 80);
  assert.equal(sanitize(null), '');
});

// ── the epistemic invariant, with both systems stubbed ──────────────────────

const okEnv = {
  BEACON_SUPABASE_URL: 'https://beacon.test', BEACON_ANON_KEY: 'k',
  AFFILIATE_SUPABASE_URL: 'https://disc.test', AFFILIATE_ANON_KEY: 'k'
};

function stubFetch(handler) {
  const real = globalThis.fetch;
  globalThis.fetch = handler;
  return () => { globalThis.fetch = real; };
}
const jsonRes = (body) => new Response(JSON.stringify(body), {
  status: 200, headers: { 'Content-Type': 'application/json' } });

test('in_network is FALSE only when both systems answered', async () => {
  const restore = stubFetch(async () => jsonRes([]));
  try {
    const r = await checkCoverage('nothing-here', okEnv);
    assert.equal(r.in_network, false);
    assert.equal(r.coverage_complete, true);
    assert.deepEqual(r.systems_checked.sort(), ['direct_merchants', 'discovery_layer']);
  } finally { restore(); }
});

test('in_network is NULL — never false — when a system fails', async () => {
  const restore = stubFetch(async (url) => {
    if (String(url).includes('disc.test')) return new Response('boom', { status: 500 });
    return jsonRes([]);
  });
  try {
    const r = await checkCoverage('patagonia', okEnv);
    assert.equal(r.in_network, null, 'absence from one of two systems proves nothing');
    assert.equal(r.coverage_complete, false);
    assert.ok(!r.systems_checked.includes('discovery_layer'));
    assert.match(r.note, /not a confirmation/i);
  } finally { restore(); }
});

test('in_network is NULL when the discovery layer is not configured', async () => {
  const restore = stubFetch(async () => jsonRes([]));
  try {
    const r = await checkCoverage('x', { BEACON_SUPABASE_URL: 'https://b.test', BEACON_ANON_KEY: 'k' });
    assert.equal(r.in_network, null);
    assert.equal(r.coverage_complete, false);
  } finally { restore(); }
});

test('a discovery-layer hit reports in_network true and leaks nothing', async () => {
  const restore = stubFetch(async (url) => {
    if (String(url).includes('disc.test')) return jsonRes([{ name: 'Nike', category: 'Apparel' }]);
    return jsonRes([]);
  });
  try {
    const r = await checkCoverage('nike', okEnv);
    assert.equal(r.in_network, true);
    assert.equal(r.match.system, 'discovery_layer');
    assert.ok(scan(r).clean, `coverage payload leaked: ${scan(r).hits.join(', ')}`);
    const s = JSON.stringify(r);
    assert.ok(!/affiliate_url|_id/.test(s), 'no vendor-bearing field may appear');
  } finally { restore(); }
});

test('a direct-merchant hit wins and is labelled', async () => {
  const restore = stubFetch(async (url) => {
    if (String(url).includes('beacon.test')) return jsonRes([{ public_slug: 'acme', store_name: 'Acme' }]);
    return jsonRes([]);
  });
  try {
    const r = await checkCoverage('acme', okEnv);
    assert.equal(r.in_network, true);
    assert.equal(r.match.system, 'direct_merchants');
  } finally { restore(); }
});

test('similar names never imply coverage', async () => {
  const restore = stubFetch(async (url) => {
    const u = String(url);
    // The near-match query is the one that orders and takes several rows;
    // the exact query is limit=1 with no order. Discriminating on `order=`
    // avoids depending on how URLSearchParams encodes the * wildcard.
    if (u.includes('disc.test') && u.includes('order=')) {
      return jsonRes([{ name: 'Backcountry', category: 'Outdoor' }]);
    }
    return jsonRes([]);
  });
  try {
    const r = await checkCoverage('patagonia', okEnv);
    assert.equal(r.in_network, false, 'a fuzzy neighbour is not a match');
    assert.ok(!r.match, 'similar names must not become a match');
    assert.deepEqual(r.similar_brands, ['Backcountry']);
  } finally { restore(); }
});

test('an excluded direct-merchant slug is not reported as in-network', async () => {
  const restore = stubFetch(async (url) => {
    if (String(url).includes('beacon.test')) {
      return jsonRes([{ public_slug: 'ri7pme-15-myshopify-com', store_name: 'dev' }]);
    }
    return jsonRes([]);
  });
  try {
    const r = await checkCoverage('ri7pme-15-myshopify-com', okEnv);
    assert.notEqual(r.in_network, true);
  } finally { restore(); }
});
