# DECISIONS — Alliance Registry Worker

Rulings for the `nctr-loyalty-layer` Worker behind `api.nctr.live`.

Numbering is shared with the Beacon phase-B series (`SYNC.md`, `~/repos/beacon/decisions-log.md`),
which occupies **D11–D19**. D9 and D10 were unused and are claimed here.

Related records:
- **D8 — NCTR Merch Store scope + three conflicting rates:** `~/nctr-internal/MERCH-STORE-SCOPE-FINDING.md`
  (earn-rate cutover lane, paused — recorded only, no fixes)
- Phase-B endpoint decisions: `SYNC.md`
- Cutover state: `~/nctr-internal/SESSION-STATE-2026-08-29.md`

---

## D9 — `crescendo_schedule_public` does not exist; `/loyalty/tiers` stays publicly degraded

**Ruled 2026-09-01.** Status: **open upstream**, closed for this Worker.

### What was ruled

`GET /loyalty/tiers` keeps publishing the honest fallback meta:

```json
"meta": { "last_synced_at": null, "age_seconds": null, "stale": null,
          "schema_version": "v15", "source": "worker_constant", "degraded": true }
```

An earlier change stripped `source` and `degraded` from the public surface and omitted
`meta` entirely on the fallback path, on the reasoning that they are internal plumbing
vocabulary an agent cannot act on. That change was **reverted**. The rule that decides it:

> Trimming the label is only correct once the thing it describes is fixed. While the
> schedule genuinely is not syncing, an agent reading a response with no freshness
> block cannot distinguish "fresh" from "never synced" — which is the exact silent-staleness
> failure the meta block exists to prevent.

Freshness-only meta is the **target** shape, and becomes correct the moment the upstream
is healthy. It is not correct today.

### Root cause — this is not an outage

The fetch does not fail intermittently. The relation has never existed.

| Probe | Result |
|---|---|
| `GET {BH}/rest/v1/crescendo_schedule_public` (anon) | **PGRST205** — "Could not find the table `public.crescendo_schedule_public` in the schema cache" |
| BH `information_schema.tables`, `public`, matching `%crescendo%` / `%tier%` / `%schedule%` | `ambassador_tier_applications`, `ambassador_tier_config`, `bounty_schedule_defaults`, `bounty_schedule_overrides`, `crescendo_login_tokens` — **no tier schedule** |
| Direct probe of 11 plausible names (`crescendo_tiers`, `tier_schedule`, `membership_tiers`, `loyalty_tiers`, `earn_multipliers`, …) | all **404** |
| `grep` over `~/repos/bh` migrations + `src` for `earn_multiplier` / `nctr_required` | **zero hits**; only `crescendo_login_tokens` carries the `crescendo` prefix |

There is no view to repair and no table behind it. Building one is **X1b, the BH tier
mirror** — an open item in the earn-rate cutover lane (`SESSION-STATE-2026-08-29.md` §3),
not a Worker fix.

### Why the Registry cannot substitute

The Earn Rate Registry (`xbzonbjgcvvugsrsrwbg`) holds the five
`crescendo_earn_multiplier` rows — 110 / 130 / 150 / 180 / 250, canon v15 — and
`/v1/earn` already reads them through `get-display-rate`. But it holds **no
`nctr_required` thresholds and no benefits**. Repointing `/loyalty/tiers` at the Registry
would supply one of the three columns the endpoint publishes and invent the other two.
Rejected.

### Correctness is not affected

`handleWrap()` computes member credits from the `TIERS` constant, never from the view
(deliberate scope limit, Phase 5). The published multipliers are canon v15 and match what
actually pays members. The drift guard has nothing to compare against and stays silent.

### To close D9

X1b lands a real tier schedule in BH (table + `crescendo_schedule_public` view + v15 seed,
via a diff-first Lovable prompt — BH is gatekept). Then, and only then, trim `meta` to
freshness-only: `last_synced_at`, `age_seconds`, `stale`.

### Access correction

`SESSION-STATE-2026-08-29.md` §5 records BH access as **NONE** (Lovable `query_database`
returning 499). As of 2026-09-01 that is **stale** — read-only `query_database` against
project `232b8746-3a58-43d9-b1ff-fb0c14b94446` works. Management API and anon RLS remain
denied. X1b is therefore no longer blocked on *read* access; it still needs a gatekept
write, i.e. a Lovable prompt.

---

## D10 — `/v1/earn` publishes the Alliance-wide ladder, never a brand-specific rate

**Ruled 2026-09-01.** Status: **closed**, standing constraint.

`GET /v1/earn/{brand}` resolves every rate through the Registry's public
`get-display-rate` edge function, which applies the canonical supersedes walk server-side.
It does **not** apply `beacon_brand_rate`, and says so in the response:

```json
"base": { "brand_rate_applied": false,
          "note": "Alliance-wide base rate. A brand-specific rate, where one exists, is not reflected here." }
```

`beacon_brand_rate` is scoped by Beacon `store_id`, and reading it needs a privileged
Registry credential this Worker deliberately does not hold (see below). Publishing the
global rate under a brand's slug without that disclaimer would present an Alliance rate as
if it were negotiated. Saying so explicitly is the ruling.

### The Worker holds no Registry credential — measured, not assumed

| Probe | Result |
|---|---|
| `GET {registry}/rest/v1/earn_rate_registry?select=id` with the **anon** key | **HTTP 200, `[]`** |
| `POST {registry}/functions/v1/get-display-rate` with **no key at all** | **HTTP 200**, full body |

Registry RLS denies `anon` and `authenticated` all access by design
(`20260514000003_earn_rate_registry_rls.sql`: all reads/writes via edge functions using
`service_role`). A denied read therefore returns **200 with an empty array, not an error** —
so any code reaching for `REGISTRY_ANON_KEY` would silently resolve a rate to "unavailable"
rather than failing loudly.

**`REGISTRY_ANON_KEY` is therefore not set on the Worker, and should not be.** It grants
no access it does not already have, and its presence would invite exactly that
silent-empty failure. `get-display-rate` is deployed `verify_jwt=false` and needs no
credential. `REGISTRY_SUPABASE_URL` (a plain var, not a secret) is all this route requires.

`REGISTRY_DEMAND_KEY` is a *different* credential — a shared secret sent as `x-registry-key`
to BH's `alliance-demand` function — and is genuinely required by `/v1/demand`.
