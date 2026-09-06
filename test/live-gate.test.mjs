/**
 * MEMBER-REGISTER GATE — runs against a live deployment.
 *
 *   BASE=https://api.nctr.live node --test test/live-gate.test.mjs
 *
 * Every public endpoint's real response body is passed through the same gate the
 * Worker uses. Skipped automatically when BASE is unset so `npm test` stays
 * offline and fast.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { scan } from '../src/lib/disclosure.js';
import { EXCLUDED_SLUGS } from '../src/lib/exclusions.js';

const BASE = process.env.BASE;
const ENDPOINTS = [
  '/health', '/loyalty/tiers', '/loyalty/stats', '/loyalty/lock-status',
  '/loyalty/verify?tx=0x' + '0'.repeat(64),
  '/v1/bounties', '/v1/demand'
];

const PRIVATE_FIELDS = ['bounty_rate_committed', 'saac_fee', 'liquidity_split',
                        'total_usdc_committed', 'total_lp_tokens_held',
                        'pool_depth_usdc', 'commitment_rate_bps'];

test('live endpoints pass the member-register gate', { skip: !BASE }, async (t) => {
  for (const ep of ENDPOINTS) {
    await t.test(ep, async () => {
      const res = await fetch(BASE + ep, { headers: { Accept: 'application/json' } });
      const body = await res.text();
      const { clean, hits } = scan(body);
      assert.ok(clean, `${ep} leaked banned vocabulary: ${hits.join(', ')}`);
      for (const f of PRIVATE_FIELDS) {
        assert.ok(!body.includes(f), `${ep} leaked private field ${f}`);
      }
    });
  }
});

test('MCP tool output passes the gate', { skip: !BASE }, async (t) => {
  const call = async (name, args = {}) => {
    const res = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } })
    });
    return res.text();
  };

  await t.test('tools/list carries no banned vocabulary', async () => {
    const res = await fetch(BASE + '/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    });
    const body = await res.text();
    const { clean, hits } = scan(body);
    assert.ok(clean, `tools/list leaked: ${hits.join(', ')}`);
    assert.ok(!/ecosystem_funding|funding|treasury/i.test(body),
      'no funding or treasury tool may be exposed (§6 standing constraint)');
  });

  await t.test('where_it_pays output is clean', async () => {
    const body = await call('where_it_pays', { brand: 'anything' });
    assert.ok(scan(body).clean, `where_it_pays leaked: ${scan(body).hits.join(', ')}`);
  });

  // The dangerous case is a REAL discovery-layer hit: that row carries a
  // vendor-named id column and a tracked affiliate_url upstream. A miss proves
  // nothing, so assert against a brand that is actually in the network.
  await t.test('a real discovery-layer hit leaks no vendor field', async () => {
    const body = await call('where_it_pays', { brand: 'nike' });
    const { clean, hits } = scan(body);
    assert.ok(clean, `coverage hit leaked banned vocabulary: ${hits.join(', ')}`);
    assert.ok(!/affiliate_url|merchant_url|logo_url/.test(body),
      'upstream URL columns must never be selected or surfaced');
    assert.ok(!/_id"/.test(body), 'no vendor-named id column may appear');
    const result = JSON.parse(JSON.parse(/data: (\{.*)/s.exec(body)[1]).result.content[0].text);
    assert.equal(result.in_network, true, 'nike should resolve in the discovery layer');
    assert.equal(result.coverage_complete, true, 'both systems must be reachable in prod');
  });

  await t.test('coverage_complete is true in production — both systems wired', async () => {
    const body = await call('where_it_pays', { brand: 'a-brand-that-does-not-exist-xyz' });
    const result = JSON.parse(JSON.parse(/data: (\{.*)/s.exec(body)[1]).result.content[0].text);
    assert.equal(result.coverage_complete, true);
    assert.equal(result.in_network, false,
      'with both systems answering, a genuine miss is false, not null');
  });
});

test('excluded brands are unreachable on every public surface', { skip: !BASE }, async (t) => {
  for (const slug of EXCLUDED_SLUGS.keys()) {
    await t.test(slug, async () => {
      const list = await (await fetch(`${BASE}/v1/bounties`)).json();
      assert.ok(!(list.brands || []).some((b) => b.public_slug === slug),
        `${slug} still appears in /v1/bounties`);

      for (const path of [`/v1/bounties/${slug}`, `/v1/earn/${slug}`]) {
        const res = await fetch(BASE + path);
        assert.equal(res.status, 404, `${path} should 404`);
        const body = await res.json();
        assert.equal(body.error, 'brand_not_found',
          `${path} must not disclose that the brand exists`);
      }

      // where_it_pays must not report an excluded brand as in-network.
      const res = await fetch(BASE + '/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
          params: { name: 'where_it_pays', arguments: { brand: slug } } })
      });
      const text = await res.text();
      const payload = JSON.parse(/data: (\{.*)/s.exec(text)[1]);
      const result = JSON.parse(payload.result.content[0].text);
      assert.notEqual(result.in_network, true,
        `where_it_pays reported excluded ${slug} as in-network`);
    });
  }
});

test('live /.well-known/bounty.json conforms to the published schema', { skip: !BASE }, async () => {
  const [schemaRes, docRes] = await Promise.all([
    fetch('https://raw.githubusercontent.com/Hoya25/open-bounty-schema/main/schema/bounty.schema.json'),
    fetch(BASE + '/.well-known/bounty.json')
  ]);
  assert.equal(docRes.status, 200);
  const schema = await schemaRes.json();
  const doc = await docRes.json();

  for (const key of schema.required) assert.ok(key in doc, `missing required ${key}`);
  for (const key of Object.keys(doc)) {
    assert.ok(schema.properties[key], `${key} is not permitted by the schema`);
  }
  assert.ok(schema.properties.earn.properties.type.enum.includes(doc.earn.type));
  assert.match(doc.updated_at, new RegExp(schema.properties.updated_at.pattern));
  assert.ok(scan(doc).clean, `well-known object leaked: ${scan(doc).hits.join(', ')}`);
  assert.ok(!/\d/.test(doc.earn.display), 'earn.display must not carry a rate');
});

test('the schema endpoints serve the real schema', { skip: !BASE }, async (t) => {
  for (const path of ['/schema/bounty/v1.json', '/schema/bounty/v0.2.json']) {
    await t.test(path, async () => {
      const res = await fetch(BASE + path);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /schema\+json/);
      const doc = await res.json();
      assert.equal(doc.$schema, 'https://json-schema.org/draft/2020-12/schema');
      assert.equal(doc.$id, 'https://api.nctr.live' + path);
      assert.ok(doc.required.includes('bounty_schema_version'));
      assert.ok(scan(doc).clean);
    });
  }
});
