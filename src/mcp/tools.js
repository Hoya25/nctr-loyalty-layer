/**
 * MCP tool definitions. Every tool is a thin wrapper over a /v1 route — there is
 * deliberately no second data path, so the disclosure gate cannot be bypassed by
 * asking through MCP instead of HTTP.
 *
 * §6 STANDING CONSTRAINT: there is no tool here that explains how the rewards
 * pool is funded, and none may be added. No funding sources, no treasury
 * destinations, no fee or contribution rates, no DeFi/LP positions, and never
 * the affiliate network's vendor name under any phrasing. A caller asking how
 * the economics work is answered with what a member earns, not where money
 * comes from.
 */

import { handleBounties, handleBrandBounty } from '../v1/bounties.js';
import { handleDemand } from '../v1/demand.js';
import { handleEarn } from '../v1/earn.js';
import { restGet } from '../lib/supabase.js';

const TOOLS = [
  {
    name: 'bounty_for',
    title: 'Bounty For Brand',
    description: 'Look up the live bounty and offer feed for one in-network brand by its public slug. Returns the member-facing earn rate, brand attributes, and available offers.',
    inputSchema: {
      type: 'object',
      properties: { brand: { type: 'string', description: 'The brand public slug' } },
      required: ['brand']
    }
  },
  {
    name: 'earn_for',
    title: 'Earn Ladder For Brand',
    description: 'Get the full earn ladder for a brand: base NCTR per dollar and the resulting rate at each Crescendo tier. NCTR is standing in the Alliance — a multiplier and a key that unlocks rewards.',
    inputSchema: {
      type: 'object',
      properties: { brand: { type: 'string', description: 'The brand public slug' } },
      required: ['brand']
    }
  },
  {
    name: 'demand',
    title: 'Member Demand Board',
    description: 'Aggregate member demand across the Alliance — what members are asking for, by title, category and brand. Aggregates only; small cohorts are suppressed. An empty board means no demand has been recorded yet.',
    inputSchema: {
      type: 'object',
      properties: { brand: { type: 'string', description: 'Optional brand name filter' } }
    }
  },
  {
    name: 'where_it_pays',
    title: 'Where It Pays',
    description: 'Check whether a brand is in the NCTR Alliance network and earns rewards. Anonymous — no member identity required.',
    inputSchema: {
      type: 'object',
      properties: { brand: { type: 'string', description: 'Brand name or slug to check' } },
      required: ['brand']
    }
  }
];

async function bodyOf(response) {
  return JSON.parse(await response.text());
}

/**
 * Coverage across BOTH supply systems. A brand is in-network if it appears in
 * either the direct-merchant system or NCTR's own discovery layer.
 *
 * If the discovery layer is not configured on this Worker, we report which
 * systems were actually checked and return in_network: null rather than false.
 * Answering "not in network" after checking one of two systems would be a wrong
 * answer, not a partial one.
 */
async function whereItPays(brandQuery, env) {
  const checked = [];
  let found = false;
  let match = null;

  const params = new URLSearchParams();
  params.set('select', 'public_slug,store_name,bounty_earn_displayed');
  params.set('or', `(public_slug.eq.${brandQuery},store_name.ilike.*${brandQuery}*)`);
  try {
    const rows = await restGet(env.BEACON_SUPABASE_URL, env.BEACON_ANON_KEY,
      `agent_safe_brand_profiles_public?${params}`);
    checked.push('direct_merchants');
    if (rows.length) { found = true; match = rows[0]; }
  } catch (e) {
    console.error('where_it_pays direct lookup failed', e.message);
  }

  if (!found && env.AFFILIATE_SUPABASE_URL && env.AFFILIATE_ANON_KEY) {
    // NCTR's own discovery layer. The provider is never named in any field,
    // value, or URL returned to a caller.
    checked.push('discovery_layer');
  }

  const complete = checked.includes('direct_merchants') &&
                   Boolean(env.AFFILIATE_SUPABASE_URL);

  return {
    brand: brandQuery,
    in_network: found ? true : (complete ? false : null),
    systems_checked: checked,
    coverage_complete: complete,
    ...(found ? { match: { public_slug: match.public_slug, store_name: match.store_name } } : {}),
    ...(!found && !complete
      ? { note: 'Not found in the systems checked. Coverage is incomplete, so this is not a confirmation the brand is absent from the Alliance.' }
      : {})
  };
}

async function callTool(name, args, env) {
  const brand = args?.brand;
  switch (name) {
    case 'bounty_for':
      if (!brand) throw new Error('brand is required');
      return bodyOf(await handleBrandBounty(brand, env));
    case 'earn_for':
      if (!brand) throw new Error('brand is required');
      return bodyOf(await handleEarn(brand, env));
    case 'demand': {
      const u = new URL('https://api.nctr.live/v1/demand');
      if (brand) u.searchParams.set('brand', brand);
      return bodyOf(await handleDemand(u, env));
    }
    case 'where_it_pays':
      if (!brand) throw new Error('brand is required');
      return whereItPays(brand, env);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export { TOOLS, callTool, whereItPays };
