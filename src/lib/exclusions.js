/**
 * PUBLIC FEED EXCLUSIONS — named slugs withheld from every public surface.
 *
 * WHY A NAMED LIST AND NOT A HEURISTIC.
 * The obvious filters do not work here. Both stores in Beacon are
 * `is_active = true`, so activity says nothing. A hostname pattern
 * (`*.myshopify.com`) would catch a genuine merchant who has not yet mapped a
 * custom domain. A "looks like a test" string match on the mission statement is
 * guessing at intent. Each of those silently drops brands nobody chose to drop.
 *
 * A named list is auditable — every entry states why it is here and what
 * removes it — and it is self-deleting: when the reason resolves, the entry goes
 * and nothing else has to change. It fails in the safe direction too. A new
 * merchant is published by default; only an explicitly named slug is withheld.
 *
 * SCOPE. Exclusion is enforced on EVERY surface that can reveal a brand:
 * /v1/bounties, /v1/bounties/{slug}, /v1/earn/{slug}, and the where_it_pays MCP
 * tool. An excluded slug returns the SAME `brand_not_found` as a slug that does
 * not exist — the exclusion itself is not advertised, because "this brand exists
 * but we are hiding it" is not information a public caller needs.
 *
 * Excluding a brand does NOT touch Beacon. Nothing is deactivated, renamed, or
 * written. This is a read-side projection decision and it is reversible by
 * deleting a line.
 */

const EXCLUDED_SLUGS = new Map([
  ['ri7pme-15-myshopify-com', {
    store_id: 'e19bc9ac-3ca4-4c7b-8579-7df0214b2e0b',
    reason: 'Shopify development store carrying placeholder brand data ' +
            '(mission_statement "Test mission for B2 smoke test"; all attributes ' +
            'self_attested with has_document false). The Earn Rate Registry ' +
            'labels this same store_id "NCTR Merch Store" and scopes a 2/1 ' +
            'beacon_brand_rate to it, so its identity is genuinely unresolved.',
    removes_when: 'The earn-rate cutover workstream resolves the store scoping. ' +
                  'See ~/nctr-internal/MERCH-STORE-SCOPE-FINDING.md',
    added: '2026-09-03'
  }]
]);

/** True when a slug must not appear on any public surface. */
function isExcluded(slug) {
  return EXCLUDED_SLUGS.has(String(slug || '').toLowerCase());
}

/** Drops excluded rows from a brand list. Pure; safe on null. */
function withoutExcluded(rows, slugKey = 'public_slug') {
  if (!Array.isArray(rows)) return [];
  return rows.filter((r) => !isExcluded(r && r[slugKey]));
}

export { EXCLUDED_SLUGS, isExcluded, withoutExcluded };
