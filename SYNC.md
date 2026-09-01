
## B5 Complete - 2026-05-02 20:00 MDT

Public agent endpoints live on api.nctr.live (Cloudflare Worker, nctr-loyalty-layer).

Endpoints:
- GET /agent/stores/:slug/profile - returns agent_safe_brand_profiles_public mapped to clean agent JSON
- GET /agent/stores/:slug/offers - returns agent_offer_feeds (empty until B9 ships)

Worker: nctr-loyalty-layer
Account: bellanderson@gmail.com
Account ID: d1c238517bb94f5117f50d83c980b071
Repo: Hoya25/nctr-loyalty-layer (canonical, single-file index.js)
Deploy workspace: ~/Desktop/nctr-loyalty-worker on laptop
Commit: 2c20784 (local on Mac mini, push to GitHub pending PAT scope extension)

New Cloudflare Worker secrets:
- BEACON_SUPABASE_URL = https://pcvssgteplcmcxzcmbyo.supabase.co
- BEACON_ANON_KEY = (anon JWT for Beacon Supabase, set via wrangler secret put)

Verified live against Anderson's store (ri7pme-15-myshopify-com):
- Profile returned all 5 categories, score 48, badge false, mission redacted
- Offers returned empty array (correct, B9 not yet run)
- Health endpoint untouched (regression check passed)

D19 - Cloudflare Worker as Beacon's public agent gateway
- Beacon Supabase data exposed via api.nctr.live worker
- Worker reads from agent_safe_brand_profiles_public view (anon-readable)
- 60-second edge cache via Cache-Control header
- CORS enabled for browser-based agents
- Same pattern can be reused for B10 (agent-session-create) when it lands

D19a (deferred) - GitHub PAT scope needs extension
- Mac mini PAT currently scoped to nctr-nexus only
- Push of nctr-loyalty-layer commit 2c20784 blocked
- Fix: regenerate PAT at github.com/settings/tokens with both repos in scope
- Not blocking; commit is safe locally and the worker is deployed from the laptop deploy workspace

D19b (deferred) - Mac mini and laptop deploy workspaces have different file layouts
- Mac mini canonical: ~/repos/nctr-loyalty-layer/index.js (root)
- Laptop deploy workspace: ~/Desktop/nctr-loyalty-worker/src/index.js (in src/)
- Sync flow: edit on Mac mini, scp to laptop, deploy from laptop
- Future improvement: align directory structures or set up wrangler on Mac mini

Phase B status:
- B1 ✅ tables + storage bucket
- B2 ✅ Brand Proof intake UI verified
- B3 ✅ recompute function + cron
- B4 ✅ AgentReadinessCard with four-section scoring
- B5 ✅ public agent endpoints
- B6 ✅ webhook state machine
- D11/D13/D14/D15/D16/D17/D18/D19 ✅ all locked
- B7 ← next (Knowledge Pack UI in Beacon Lovable)
- B8, B9, B10 queued

Today's progress summary: shipped B1, B2, B3, B4, B5, B6 plus all major cleanup. Phase B roughly 60% complete in single session.

## B9 Complete - 2026-05-03 05:26 MDT

Shopify product sync edge function shipped. agent_offer_feeds populated with real product data; B5 public endpoint now returns full catalog instead of empty array.

Edge function: sync-shopify-products
Auth paths: x-sync-secret header, service-role bearer, user JWT (verified store ownership)
Routing:
- POST {store_id} - sync one store
- POST {all: true} - service role only, batch sync all is_active shopify stores

Per-store pipeline:
- Determines mode: full if last_synced_at NULL or > 7 days old, else incremental with updated_at_min = last_synced_at - 5min overlap
- Fetches Shopify Admin API /products.json with pagination via Link header (cap 100 pages)
- Throttles on X-Shopify-Shop-Api-Call-Limit > 0.8 (sleep 500ms)
- Retries 429 once after 2s
- Maps to agent_offer_feeds rows: shopify_product_id, handle, title, description_md (raw HTML), price_cents (variants[0].price * 100), currency='USD', availability via mapShopifyAvailability, product_url, image_url, nctr_bounty_rate (denormalized from store), attributes_inherited=[]
- Batch upserts in chunks of 100 with onConflict='store_id,shopify_product_id'
- Per-row fallback if batch upsert fails
- Discontinue sweep (full mode only): UPDATE agent_offer_feeds SET availability='discontinued' WHERE last_synced_at < syncStartedAt — timestamp-based, no NOT IN list, scales infinitely
- Logs to beacon_run_events with mode, products_seen/upserted/failed, api_pages, duration_ms

Cron: sync-shopify-products-daily, schedule '0 3 * * *' (3am UTC), Bearer JWT auth (same pattern as job 9 / recompute-agent-profile-6h)

Verified live against Anderson's store (e19bc9ac-...):
- Full sync: 9 products, 1 page, 2.0s, all clean data with images and prices
- Incremental sync: 0 changes, 1 page, 646ms (correctly skipped sweep)
- Score jumped 48 → 58 with Protocol section now at 35/35 (MCP product feed flipped green)
- Public endpoint /agent/stores/ri7pme-15-myshopify-com/offers returns 9 product objects (no longer empty array)

D20 - Timestamp-based discontinue sweep
- NOT IN (id_list) approach abandoned (would break with thousands of products via URL length limits)
- Replaced with .lt('last_synced_at', syncStartedAt).neq('availability', 'discontinued')
- Logic: every product touched in this sync got last_synced_at bumped during upsert; anything still bearing the OLD timestamp is a deletion
- Scales infinitely; no list size dependency

Out of scope (deferred):
- Variants beyond v[0]
- Multi-currency
- Shopify webhooks for real-time sync (vs daily cron)
- Storefront API
- Multiple product images
- Metafields, custom collections, smart collections

Phase B status:
- B1, B2, B3, B4, B5, B6, B9 ✅ all shipped
- D11/D13/D14/D15/D16/D17/D18/D19/D20 ✅ all locked
- B7 (Knowledge Pack UI) ← natural next step
- B8 (Agent Activity widget) - depends on B10 having data
- B10 (agent-session-create) - public Cloudflare Worker endpoint, similar pattern to B5

Anderson's score: 58/100, "On your way" tier. 22 points from agent-ready badge. Path: fund reserve (+10) and settle first bounty (+20) gets to 88.

## B7 + B7a Complete - 2026-05-03 06:40 MDT

Knowledge Pack UI shipped with merchant-facing guidance enhancements. First markdown-aware editor in Beacon. Knowledge packs now flow into agent_safe_knowledge_packs_public view for agent consumption.

Files created:
- src/components/MarkdownEditor.tsx (textarea + react-markdown preview, themed)
- src/pages/KnowledgePacks.tsx (list view, /settings/knowledge-packs)
- src/pages/KnowledgePackEdit.tsx (create/edit, /settings/knowledge-packs/:id, :id=new for create)

Files modified:
- src/components/settings/SettingsTabs.tsx (added Knowledge Packs tab)
- src/App.tsx (registered new routes)
- package.json (added react-markdown ^9.0.1)

Backend:
- New view agent_safe_knowledge_packs_public exposing published packs filtered by is_active stores
- Joins merchant_knowledge_packs to beacon_stores to agent_safe_brand_profiles_public for slug
- GRANT SELECT to anon, authenticated
- No schema changes to merchant_knowledge_packs (B1 schema was already complete)
- recompute-agent-profile already correctly checks has_about_kp (section='about' AND is_published=true) and has_3_published_kps (count where is_published=true >= 3)

UI features (B7 baseline):
- Section dropdown with 8 options (about, sourcing, sustainability, returns, sizing, care, faq, custom)
- Title field (max 120 chars), trimmed on save
- Body markdown editor with 2-pane desktop / tabbed mobile preview
- Display order field (default 0, drag-reorder deferred to v2)
- Published toggle per pack
- Save vs Save & Publish button split
- Published/Draft status badges
- Eye icon to toggle publish state from list view
- Pencil icon for edit
- Trash icon with AlertDialog confirm for delete
- Loading states with spinners
- Dirty-tracking via initialRef pattern

UI features (B7a guidance enhancements):
- Section descriptions in dropdown items AND visible below dropdown after selection
- Body field starts EMPTY on new packs (no auto-fill)
- "Use a starter template" subtle button below editor (sparkle icon, ghost-style)
- Click template button when body is empty: inserts template
- Click template button when body has content: AlertDialog confirm "Replace your draft?"
- Templates per section with bracketed placeholders ([your brand], [Belief 1], etc.)
- Visible character counter "X / 20,000 characters" below editor
- Counter color shifts: muted < 16k, primary 16k-19k, destructive >= 19k
- Hard cap input at 20k chars
- Unsaved changes guard via useBlocker for route changes + beforeunload listener
- AlertDialog "You have unsaved changes" with Cancel / Discard buttons
- Empty state copy: "Most agent-ready brands publish at least: About, Sourcing, and FAQ. Start with About to introduce your brand."
- Recommended Next panel: shows when 1-2 packs published, lists which of about/sourcing/faq are missing, dynamically updates "X more published packs unlocks the agent-readiness boost", hides at 3+

D21 - Knowledge Pack templates with bracketed placeholders
- Templates use [bracket] syntax for fill-in-the-blank prompts
- Render literally in preview (not greyed/placeholder-styled) — small UX gap noted but not blocking
- Future enhancement could style brackets distinctly or strip them on publish

Verified live against Anderson's store (e19bc9ac-...):
- Created 3 published packs: About (NCTR Alliance), Sourcing (How we work with brands), FAQ (Common questions about NCTR)
- All real first-draft content, not throwaway
- Score: 58 → 64 confirmed via dashboard
- Tier label: "On your way" → "Almost agent-ready" 
- Discovery Boosts: 0/10 → 6/10
- About knowledge pack ✅
- 3+ published knowledge packs ✅
- agent_safe_knowledge_packs_public view exposes the 3 published packs to anon
- Recommended Next panel correctly hides at 3+ packs

Bug found and resolved during apply:
- Initial /settings/knowledge-packs/new render was a blank screen (Supabase 400 + uncaught JS error)
- Cause: minified error trace pointed to mounting issue
- Resolved during Lovable's follow-up apply (specific fix not surfaced in apply report, but page rendered correctly on retest)
- /settings/knowledge-packs/:id (edit existing) was unaffected throughout

Out of scope (deferred):
- Drag-to-reorder packs (display_order set to 0 manually for now)
- Image embedding in markdown
- Per-pack analytics
- Pack versioning / history
- AI-assisted writing (intentional skip per user steering)
- Cloudflare Worker endpoint to surface knowledge packs (B5 returns brand profile only; pack data accessible via direct Supabase REST per public view's anon RLS)

Phase B status:
- B1, B2, B3, B4, B5, B6, B7, B9 ✅ all shipped
- D11/D13/D14/D15/D16/D17/D18/D19/D20/D21 ✅ all locked
- B8 (Agent Activity widget) - depends on B10 having data
- B10 (agent-session-create) - public Cloudflare Worker endpoint

Anderson's score: 64/100, "Almost agent-ready" tier. 16 points from agent-ready badge.
Path: fund reserve (+10) + settle first bounty (+20) = 94, well past threshold. Plus optional lifestyle fit (+2) and brand proof doc (+2).

## B10 Complete - 2026-05-03 07:45 MDT

Public agent session creation/lookup endpoints live on api.nctr.live. Beacon now has the full agent commerce loop: brand discovery (B5 profile) → product offers (B5 offers, B9 sync) → session intent declaration (B10 create) → session lookup (B10 lookup).

Architecture:
- Cloudflare Worker proxy pattern (NOT direct DB writes from worker)
- Worker validates request shape, then forwards to Beacon edge functions
- Worker holds anon key only; service role stays in Beacon
- Same handoff pattern as recompute-agent-profile cron flow

Endpoints:
- POST /agent/sessions/create
  - Validates: slug (required), agent_id (required, max 100), agent_model (max 100), referrer_url (max 2048, must parse as URL), product_handle (max 200)
  - Proxies to: BEACON_SUPABASE_URL/functions/v1/agent-session-create
  - Returns: session_token, slug, store_id, created_at, expires_in_days, ack message, endpoints discovery block
  
- GET /agent/sessions/:token
  - Validates token format (nctr_sess_ + 22 chars)
  - Proxies to: BEACON_SUPABASE_URL/functions/v1/agent-session-lookup?token=...
  - Returns: full session details, is_converted, is_expired, expires_in_days_remaining

Beacon edge functions (new):
- supabase/functions/agent-session-create/index.ts — service-role INSERT, generates token via crypto.getRandomValues + base62
- supabase/functions/agent-session-lookup/index.ts — service-role SELECT, joins to agent_safe_brand_profiles_public for slug

Cloudflare Worker:
- Local commit 68da87b on Mac mini (not pushed; PAT scope still pending)
- Diff: -130 + 34 net (proxy version vs original direct-write that we redirected)
- Deploy: scp from Mac mini to laptop, npx wrangler deploy from laptop
- No new secrets needed (uses existing BEACON_SUPABASE_URL and BEACON_ANON_KEY from B5)

Token format: nctr_sess_<22-char base62> = 32 chars total, ~131 bits entropy.

Verified live with end-to-end test:
- POST create returned valid session_token
- GET lookup returned full session details with correct slug, agent_id, agent_model, product_handle
- is_converted=false, is_expired=false, expires_in_days_remaining=30
- Health + profile endpoints unchanged (regression passed)
- Anderson's score: 64 → 66 (Discovery Boosts has_recent_referral flipped +2)

D22 - Service role placement principle
- Service role keys belong in Beacon's environment, never in Cloudflare Worker
- Cloudflare Worker holds only anon key (public-by-design)
- Pattern: worker proxies to edge function, edge function holds elevated credentials
- Caught during initial B10 build when first version put service role in worker
- Saved as architectural standard for any future endpoints that need DB writes

Out of scope (deferred):
- Conversion tracking (separate flow tied to existing webhook)
- Per-agent rate limiting (relies on Cloudflare layer)
- Session deletion / archival
- nctr_bounty_paid_to_agent population (settled at conversion time)
- Lookup endpoint Cache-Control header (currently returns no cache; could add private/max-age=10 in future)

Phase B status:
- B1, B2, B3, B4, B5, B6, B7, B9, B10 ✅ all shipped
- D11/D13/D14/D15/D16/D17/D18/D19/D20/D21/D22 ✅ all locked
- B8 (Agent Activity widget) — natural next step, depends on agent_referral_sessions data which now flows

Anderson's score: 66/100, "Almost agent-ready" tier.
Path to 80: fund reserve (+10) + settle first bounty (+20) = 96, well past threshold.

Today's session shipped: B7 + B7a (Knowledge Pack UI with guidance), B10 (agent session endpoints), D22 (service role placement principle), bug fix on /knowledge-packs/new render.

## Deploy moved to the Mac mini - 2026-08-21

The laptop deploy workspace (`~/Desktop/nctr-loyalty-worker`) is gone. D19b is resolved:
this repo is now both canonical source AND the deploy workspace. No more scp step.

Added: `package.json` (viem pinned to **2.47.12**, matching what production runs),
`wrangler.toml`, `.gitignore`. Auth comes from the `CLOUDFLARE_API_TOKEN` env var
already present on this machine — `npx wrangler whoami` resolves to account
`d1c238517bb94f5117f50d83c980b071`, which matches the account recorded above.

Config in wrangler.toml was read from the Cloudflare API on 2026-08-21 so a deploy
from here cannot silently reshape the worker:
- `compatibility_date = "2024-01-01"` (as deployed)
- `api.nctr.live` declared as a Custom Domain route (idempotent; already attached)
- `BH_SUPABASE_URL` declared under `[vars]` — it is the worker's only `plain_text`
  binding, and plain vars are REPLACED by `[vars]` at deploy time. Dropping it would
  break the BH integration.
- The seven `secret_text` bindings are deliberately absent. Wrangler preserves
  secrets across deploys; never declare them in wrangler.toml.

Verify before deploying: `npm run dry-run` (builds, deploys nothing).
Deploy: `npm run deploy`. Watch: `npm run tail`.

### Known item - deferred, clean when Beacon is next touched
`commitLiquidity()` still returns `total_usdc_committed`, `total_lp_tokens`,
`pool_depth_usdc` and `commitment_rate` into `/loyalty/wrap`'s `liquidity_proof`.
Same disclosure-canon issue fixed in `/loyalty/stats` and `/loyalty/lock-status`
on 2026-08-21, but `/loyalty/wrap` is a write path whose response Beacon may
consume, so the shape was left alone rather than risk breaking an integration.
Note the amounts are raw base units - USDC has 6 decimals, so 260000 is 0.26 USDC.
