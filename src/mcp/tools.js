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
import { checkCoverage } from '../v1/coverage.js';

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
    description: 'Check whether a brand is in the NCTR Alliance network and earns rewards. Searches both Alliance supply systems: direct merchant partners and NCTR\'s own discovery layer of 6,000-plus brand earning opportunities. Anonymous — no member identity required. Returns in_network: null rather than false if a system could not be reached.',
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
      return checkCoverage(brand, env);
    default:
      throw new Error(`unknown tool: ${name}`);
  }
}

export { TOOLS, callTool };
