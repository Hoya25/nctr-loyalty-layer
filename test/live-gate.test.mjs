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
