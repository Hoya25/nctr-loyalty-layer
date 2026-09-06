/**
 * OPEN BOUNTY SCHEMA v0.1 — https://github.com/Hoya25/open-bounty-schema
 *
 * Builds schema-conformant objects. Two surfaces use this:
 *   - /.well-known/bounty.json      the Alliance's own program-level object
 *   - /v1/bounties/{slug}           per-store, as the spec's `api` field target
 *
 * DISPLAY OVER MATH is the spec's first design principle, and it decides
 * something concrete here: `earn.display` is a fixed, truthful sentence rather
 * than a per-brand rate string. Beacon's `bounty_earn_displayed` has no
 * documented unit — 0.5 could be a percentage, NCTR per dollar, or something
 * else — so rendering it into a sentence would manufacture precision the data
 * does not carry. An agent gets a true sentence and the `api` link for detail.
 *
 * Never put a rate, a price, a USD value or a yield in `earn.display`.
 */

const SCHEMA_VERSION = '0.1';
const SCHEMA_URL = 'https://github.com/Hoya25/open-bounty-schema';
const SCHEMA_JSON_URL = 'https://raw.githubusercontent.com/Hoya25/open-bounty-schema/main/schema/bounty.schema.json';

const PROGRAM = {
  name: 'NCTR Alliance',
  url: 'https://themall.nctr.live'
};

const EARN_DISPLAY = 'Members earn NCTR on every purchase — earning grows with status.';

const STATUS = {
  url: 'https://themall.nctr.live/status',
  note: 'Standing unlocks sponsored rewards; earning rates rise with status.'
};

/** ISO date (YYYY-MM-DD) — the schema requires a date, not a timestamp. */
function isoDate(value) {
  const d = value ? new Date(value) : new Date();
  return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().slice(0, 10);
}

/**
 * The Alliance's own program-level object. True on day one: it describes the
 * Alliance's bounty, not any particular store's.
 */
function allianceBounty() {
  return {
    bounty_schema_version: SCHEMA_VERSION,
    active: true,
    program: PROGRAM,
    earn: { display: EARN_DISPLAY, denomination: 'NCTR', type: 'token' },
    status: STATUS,
    api: 'https://api.nctr.live/v1/bounties',
    updated_at: isoDate()
  };
}

/**
 * Per-store object. `active` reflects that the store is listed by the Registry
 * with a published member-side earn rate — not that a funded bounty exists.
 * Funded-before-featured is a roadmap bar (spec §3), so this must not imply it.
 */
function brandBounty(brand) {
  return {
    bounty_schema_version: SCHEMA_VERSION,
    active: true,
    program: PROGRAM,
    earn: { display: EARN_DISPLAY, denomination: 'NCTR', type: 'token' },
    status: STATUS,
    api: `https://api.nctr.live/v1/bounties/${encodeURIComponent(brand.public_slug)}`,
    updated_at: isoDate(brand.updated_at || brand.last_recomputed_at)
  };
}

export {
  allianceBounty, brandBounty, isoDate,
  SCHEMA_VERSION, SCHEMA_URL, SCHEMA_JSON_URL, PROGRAM, EARN_DISPLAY, STATUS
};
