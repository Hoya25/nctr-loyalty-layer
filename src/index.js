/**
 * NCTR Loyalty Layer + Alliance Registry — Cloudflare Worker
 * api.nctr.live
 *
 * Handles two commerce tracks:
 *   Track 1 (traditional): 90-day settlement hold, database credit, no on-chain action
 *   Track 2 (x402): on-chain delivery + liquidity commitment proof
 *
 * Endpoints:
 *   POST /loyalty/wrap                — Issue NCTR participation rewards
 *   GET  /loyalty/stats               — Public liquidity statistics
 *   GET  /loyalty/tiers               — Membership + tier ladder
 *   GET  /loyalty/verify              — Verify a commitment on-chain (OFFLINE)
 *   GET  /loyalty/lock-status         — Lock expiry and extension history
 *   GET  /agent/stores/:slug/profile  — Public agent-facing brand profile
 *   GET  /agent/stores/:slug/offers   — Public agent-facing offer feed
 *   POST /agent/sessions/create       — Agent declares intent, gets session_token
 *   GET  /agent/sessions/:token       — Look up an existing agent session
 *   GET  /v1/bounties                 — Alliance Registry: brands with live bounties
 *   GET  /v1/bounties/:slug           — One brand plus its offer feed
 *   GET  /v1/earn/:slug               — Earn ladder derived from the Rate Registry
 *   GET  /v1/demand                   — Aggregate member demand
 *   POST /mcp                         — Remote MCP server (Streamable HTTP)
 *   GET  /health                      — Health check
 *
 * @custom:compliance
 *   Never "yield", "returns", "investment", "APY"
 *   Liquidity commitment is "backing" not "staking"
 *   NCTR is "earned through participation"
 *   Every /v1 and /mcp response passes lib/disclosure.js before it is returned.
 */

import { CORS_HEADERS, jsonResponse } from './lib/http.js';
import { cached } from './lib/cache.js';
import { DisclosureViolation } from './lib/disclosure.js';

import { VERIFY_ENDPOINT_ENABLED } from './loyalty/contract.js';
import { handleWrap } from './loyalty/wrap.js';
import { handleStats } from './loyalty/stats.js';
import { handleTiers } from './loyalty/tiers.js';
import { handleVerify } from './loyalty/verify.js';
import { handleLockStatus } from './loyalty/lock-status.js';
import { handleAgentProfile, handleAgentOffers } from './agent/stores.js';
import { handleAgentSessionCreate, handleAgentSessionLookup } from './agent/sessions.js';

import { handleBounties, handleBrandBounty } from './v1/bounties.js';
import { handleEarn } from './v1/earn.js';
import { handleDemand } from './v1/demand.js';
import { handleMcp } from './mcp/server.js';
import { allianceBounty } from './lib/bounty-schema.js';

const VERSION = '2.2.0';

// Cache TTLs. /v1/demand matches the origin's own max-age=3600.
const TTL = { bounties: 120, brand: 300, earn: 300, demand: 3600, wellKnown: 3600 };

export default {
  async fetch(request, env, ctx) {
    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // Route handling
      if (path === '/health') {
        return jsonResponse({
          status: 'healthy',
          service: 'nctr-loyalty-layer',
          version: VERSION,
          tracks: { track_1: 'traditional', track_2: 'x402_onchain' },
          timestamp: new Date().toISOString()
        });
      }

      if (path === '/loyalty/tiers') {
        return await handleTiers(env);
      }

      if (path === '/loyalty/stats') {
        return await handleStats(env);
      }

      if (path === '/loyalty/lock-status') {
        return await handleLockStatus(env);
      }

      if (path === '/loyalty/verify') {
        if (!VERIFY_ENDPOINT_ENABLED) {
          return jsonResponse({
            error: 'endpoint_unavailable',
            message: 'Commitment verification is temporarily unavailable. The liquidity commitment contract remains live and independently readable on BaseScan.',
            contract: env.COMMITMENT_CONTRACT_ADDRESS || null,
            verifiable_at: env.COMMITMENT_CONTRACT_ADDRESS
              ? `https://basescan.org/address/${env.COMMITMENT_CONTRACT_ADDRESS}`
              : null
          }, 503);
        }
        const txHash = url.searchParams.get('tx');
        return await handleVerify(txHash, env);
      }

      if (path === '/loyalty/wrap' && request.method === 'POST') {
        return await handleWrap(request, env);
      }

      // Agent endpoints (Beacon brand profiles)
      const agentMatch = path.match(/^\/agent\/stores\/([^/]+)\/(profile|offers)$/);
      if (agentMatch) {
        const slug = decodeURIComponent(agentMatch[1]);
        if (agentMatch[2] === 'profile') {
          return await handleAgentProfile(slug, env);
        }
        return await handleAgentOffers(slug, env);
      }

      // Agent session endpoints
      const sessionMatch = path.match(/^\/agent\/sessions\/(create|[a-zA-Z0-9_]+)$/);
      if (sessionMatch) {
        const param = sessionMatch[1];
        if (param === 'create' && request.method === 'POST') {
          return await handleAgentSessionCreate(request, env);
        }
        if (request.method === 'GET') {
          return await handleAgentSessionLookup(param, env);
        }
        return jsonResponse({ error: 'method not allowed' }, 405);
      }

      // ── Open Bounty Schema: the Alliance's own program-level object ───────
      // Program-level, so it is true on day one regardless of how many stores
      // the index lists. https://github.com/Hoya25/open-bounty-schema
      if (path === '/.well-known/bounty.json') {
        return await cached(request, ctx, TTL.wellKnown, async () =>
          jsonResponse(allianceBounty()));
      }

      // ── Alliance Registry (v1) ────────────────────────────────────────────
      if (path === '/v1/bounties') {
        return await cached(request, ctx, TTL.bounties, () => handleBounties(url, env));
      }

      const brandMatch = path.match(/^\/v1\/bounties\/([^/]+)$/);
      if (brandMatch) {
        const slug = decodeURIComponent(brandMatch[1]);
        const format = url.searchParams.get('format');
        return await cached(request, ctx, TTL.brand, () => handleBrandBounty(slug, env, format));
      }

      const earnMatch = path.match(/^\/v1\/earn\/([^/]+)$/);
      if (earnMatch) {
        const slug = decodeURIComponent(earnMatch[1]);
        return await cached(request, ctx, TTL.earn, () => handleEarn(slug, env));
      }

      if (path === '/v1/demand') {
        return await cached(request, ctx, TTL.demand, () => handleDemand(url, env));
      }

      // ── Remote MCP server ─────────────────────────────────────────────────
      if (path === '/mcp') {
        return await handleMcp(request, env);
      }

      return jsonResponse({ error: 'Not found' }, 404);

    } catch (err) {
      // A disclosure violation means a response was about to breach canon.
      // Fail the request. A 500 is strictly better than a leaked field, and the
      // offending terms are logged, never returned.
      if (err instanceof DisclosureViolation) {
        console.error('DISCLOSURE GATE BLOCKED RESPONSE:', err.hits.join(', '), 'path:', path);
        return jsonResponse({ error: 'Internal error' }, 500);
      }
      console.error('Worker error:', err);
      return jsonResponse({
        error: 'Internal error',
        message: err.message
      }, 500);
    }
  }
};
