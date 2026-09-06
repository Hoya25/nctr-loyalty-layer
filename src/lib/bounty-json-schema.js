/**
 * The Open Bounty Schema, served from a URL the Registry controls.
 *
 * Vendored rather than proxied to GitHub raw on purpose: a validation endpoint
 * an app depends on should not inherit a third party's rate limits, branch
 * names, or repo renames. The published repo remains canonical for the SPEC;
 * this is the same document at a stable address.
 *
 * DRIFT IS THE RISK with any vendored copy, so a test fetches the published
 * schema and asserts this matches it field for field. If the repo moves and
 * this does not, the gate fails rather than the app silently validating against
 * a stale contract.
 *
 *   /schema/bounty/v1.json    stable alias — tracks the latest 0.x
 *   /schema/bounty/v0.2.json  pinned — frozen at 0.2, never updated in place
 *
 * When 0.3 ships: update V1, add a new frozen V0_3, leave V0_2 alone.
 */

const SCHEMA_V0_2 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://api.nctr.live/schema/bounty/v0.2.json",
  "title": "Open Bounty Schema",
  "description": "Describes value paid to the shopper at the purchase. One object answers: does buying here pay the shopper?",
  "type": "object",
  "required": [
    "bounty_schema_version",
    "active",
    "program",
    "earn",
    "updated_at"
  ],
  "additionalProperties": false,
  "properties": {
    "bounty_schema_version": {
      "type": "string",
      "description": "Spec version this object conforms to.",
      "pattern": "^[0-9]+\\.[0-9]+$",
      "examples": [
        "0.1"
      ]
    },
    "active": {
      "type": "boolean",
      "description": "Whether a bounty is currently offered. False is a meaningful, honest answer."
    },
    "program": {
      "type": "object",
      "description": "The rewards program behind the bounty.",
      "required": [
        "name",
        "url"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1
        },
        "url": {
          "type": "string",
          "format": "uri"
        }
      }
    },
    "earn": {
      "type": "object",
      "required": [
        "display"
      ],
      "additionalProperties": false,
      "properties": {
        "display": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "ONE human sentence describing what the buyer earns. Agents show this verbatim, so it must be plain and truthful. Capped to keep it a sentence rather than a pitch."
        },
        "denomination": {
          "type": "string",
          "description": "What the earn is paid in.",
          "examples": [
            "NCTR",
            "points",
            "USD"
          ]
        },
        "type": {
          "type": "string",
          "enum": [
            "points",
            "token",
            "cash",
            "other"
          ]
        }
      }
    },
    "status": {
      "type": "object",
      "description": "For status-based programs: where standing lives and what it does.",
      "additionalProperties": false,
      "properties": {
        "url": {
          "type": "string",
          "format": "uri"
        },
        "note": {
          "type": "string",
          "maxLength": 200
        }
      }
    },
    "api": {
      "type": "string",
      "format": "uri",
      "description": "Live endpoint with authoritative, current bounty detail. Authoritative over any embedded copy."
    },
    "terms_url": {
      "type": "string",
      "format": "uri"
    },
    "updated_at": {
      "type": "string",
      "format": "date",
      "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
      "description": "ISO date of last change."
    }
  }
};

const SCHEMA_V1 = {
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://api.nctr.live/schema/bounty/v1.json",
  "title": "Open Bounty Schema",
  "description": "Describes value paid to the shopper at the purchase. One object answers: does buying here pay the shopper?",
  "type": "object",
  "required": [
    "bounty_schema_version",
    "active",
    "program",
    "earn",
    "updated_at"
  ],
  "additionalProperties": false,
  "properties": {
    "bounty_schema_version": {
      "type": "string",
      "description": "Spec version this object conforms to.",
      "pattern": "^[0-9]+\\.[0-9]+$",
      "examples": [
        "0.1"
      ]
    },
    "active": {
      "type": "boolean",
      "description": "Whether a bounty is currently offered. False is a meaningful, honest answer."
    },
    "program": {
      "type": "object",
      "description": "The rewards program behind the bounty.",
      "required": [
        "name",
        "url"
      ],
      "additionalProperties": false,
      "properties": {
        "name": {
          "type": "string",
          "minLength": 1
        },
        "url": {
          "type": "string",
          "format": "uri"
        }
      }
    },
    "earn": {
      "type": "object",
      "required": [
        "display"
      ],
      "additionalProperties": false,
      "properties": {
        "display": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "ONE human sentence describing what the buyer earns. Agents show this verbatim, so it must be plain and truthful. Capped to keep it a sentence rather than a pitch."
        },
        "denomination": {
          "type": "string",
          "description": "What the earn is paid in.",
          "examples": [
            "NCTR",
            "points",
            "USD"
          ]
        },
        "type": {
          "type": "string",
          "enum": [
            "points",
            "token",
            "cash",
            "other"
          ]
        }
      }
    },
    "status": {
      "type": "object",
      "description": "For status-based programs: where standing lives and what it does.",
      "additionalProperties": false,
      "properties": {
        "url": {
          "type": "string",
          "format": "uri"
        },
        "note": {
          "type": "string",
          "maxLength": 200
        }
      }
    },
    "api": {
      "type": "string",
      "format": "uri",
      "description": "Live endpoint with authoritative, current bounty detail. Authoritative over any embedded copy."
    },
    "terms_url": {
      "type": "string",
      "format": "uri"
    },
    "updated_at": {
      "type": "string",
      "format": "date",
      "pattern": "^[0-9]{4}-[0-9]{2}-[0-9]{2}$",
      "description": "ISO date of last change."
    }
  }
};

export { SCHEMA_V0_2, SCHEMA_V1 };
