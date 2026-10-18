#!/usr/bin/env node
/**
 * One source of truth for the AI-SDLC policy numbers, consumed by both linter configs.
 *
 * WHY THIS FILE EXISTS AT ALL. Two independent tools need the same three facts: which paths are
 * Tier 1, which ways may code flow between tiers, and how large a Tier 3 function may get. Written
 * twice -- once in `.dependency-cruiser.cjs`, once in `eslint.config.mjs` -- those facts drift, and
 * the drift is silent: a path added to one list is still governed by the other, so the gate reports
 * a pass over the tiers it happens to know about. One module, two readers, no second opinion.
 *
 * It lives in `scripts/` rather than a new `lib/` because that is where this repository keeps
 * operator tooling, and because a new top-level directory would sit outside both existing guards:
 * `check-file-hygiene.cjs` scans `tools/` and `plugin/src/`, and contract parity scans `tools/*.ts`.
 * Anything under `scripts/` is at least visible to a reader looking for the toolchain.
 *
 * OVERRIDES ARE OPT-IN AND FAIL CLOSED. A repository may place `ai-sdlc.config.cjs` beside this
 * package's root; it is merged over the defaults and then validated. An unknown key is an error
 * rather than a silent no-op -- a typo in `complexity.max` would otherwise leave the ceiling at the
 * default while the operator believed they had raised it.
 *
 * THE TIER PATHS ARE REGEXES, because that is what dependency-cruiser matches with, and the globs
 * beside them are what ESLint matches with. Storing both here keeps the two tools describing the
 * same tier rather than two translations of it.
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

/** Filename a repository may drop at its root to override the defaults below. */
const CONFIG_BASENAME = 'ai-sdlc.config.cjs'

/**
 * The policy's numbers, as shipped.
 *
 * The `futurePaths` entries are the ADR's Tier 2/3 directories. They are listed because the policy
 * names them, and a repository that grows an `src/engine/` should be governed without editing this
 * file -- but nothing in this repository matches them today, and a rule that matches no file is not
 * evidence of anything.
 */
const SENSIBLE_DEFAULTS = Object.freeze({
  schemaVersion: 1,

  /** Git ref holding the signed delegation ledger (POL-SEC-AISDLC-001 §7.1). */
  ledgerRef: 'refs/notes/delegations',

  /** The only model authorised to produce Tier 1 primitives (POL §3.1). */
  workerModel: 'qwen/qwen3.8-27b',

  tiers: Object.freeze({
    corePrimitives: Object.freeze({
      pattern: '^tools/',
      /**
       * The subset the leaf rule binds: one `.ts` file directly under `tools/`, which is exactly the
       * set `check-contracts.cjs` governs (it filters `.ts` and never `.d.ts`). `tools/` also holds
       * `.mjs` dispatchers and probes -- operator tooling that legitimately imports Node builtins and
       * is not a primitive. Measured: with the whole directory bound, the fence reported seven
       * violations, every one of them a dispatcher importing `fs` or `http`.
       */
      contractGoverned: '^tools/[^/]+\\.ts$',
      futurePaths: Object.freeze(['^src/core/primitives/']),
      globs: Object.freeze(['tools/**']),
    }),
    protocolEngines: Object.freeze({
      pattern: '^plugin/src/',
      futurePaths: Object.freeze(['^src/core/protocol/', '^src/engine/']),
      globs: Object.freeze(['plugin/src/**']),
    }),
    imperativeShell: Object.freeze({
      pattern: '^scripts/',
      futurePaths: Object.freeze(['^src/routes/', '^src/ui/']),
      globs: Object.freeze(['scripts/**']),
    }),
  }),

  /**
   * Delegation defaults (POL-SEC-AISDLC-001 §5.3).
   *
   * `flakeIterations` is the minimum number of consecutive, deterministic contract runs a unit must
   * pass before it can settle. It is a policy number rather than a harness constant so the two
   * cannot disagree: a harness that quietly ran the contract twice would still satisfy a document
   * claiming three.
   */
  delegation: Object.freeze({
    flakeIterations: 3,
  }),

  complexity: Object.freeze({
    /** Cyclomatic ceiling for Tier 3 functions (POL §6.2). */
    max: 10,
    maxLinesPerFunction: 40,
    /**
     * Tier 3 files that predate the ceiling. Listed, not inferred: the policy took effect on
     * 2026-10-18 and every file below already existed, several of them far over the limit
     * (`verify-delegation-ledger.cjs` is 863 lines). Enforcing the ceiling on them would fail a
     * build for code nobody is changing today; leaving them unlisted would do the same thing.
     * This list is a ratchet -- files leave it as they are rewritten, none are added.
     */
    baseline: Object.freeze([
      'scripts/apply-patch.cjs',
      'scripts/apply-staged-patch.cjs',
      'scripts/attest-unit.cjs',
      'scripts/capture-worker-request.cjs',
      'scripts/check-contract-fixtures.cjs',
      'scripts/check-contract.cjs',
      'scripts/check-contracts.cjs',
      'scripts/check-dist-in-sync.cjs',
      'scripts/check-file-hygiene.cjs',
      'scripts/check-host-types-pin.cjs',
      'scripts/check-oracle-isolation.cjs',
      'scripts/check-promotion.cjs',
      'scripts/check-readme-consistency.cjs',
      'scripts/generate-reviewer-key.cjs',
      'scripts/measure-reading-cost.cjs',
      'scripts/measure-skeleton-ratio.cjs',
      'scripts/operator-key.cjs',
      'scripts/probe-worker.cjs',
      'scripts/proxy-worker.cjs',
      'scripts/redteam-probe.cjs',
      'scripts/simulate-worker.cjs',
      'scripts/verification-golden.cjs',
      'scripts/verify-delegation-ledger.cjs',
    ]),
  }),
})

const TOP_LEVEL_KEYS = new Set(['schemaVersion', 'ledgerRef', 'workerModel', 'tiers', 'delegation', 'complexity'])
const TIER_KEYS = new Set(['pattern', 'contractGoverned', 'futurePaths', 'globs'])
const COMPLEXITY_KEYS = new Set(['max', 'maxLinesPerFunction', 'baseline'])
const DELEGATION_KEYS = new Set(['flakeIterations'])

/** Refuse an override that carries a key this module would otherwise ignore. */
function assertKnownKeys(value, allowed, where) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(
        where + ': unknown key "' + key + '". Known keys: ' + [...allowed].sort().join(', ') +
          '. An unrecognised key is refused rather than ignored, so a typo cannot leave a ceiling ' +
          'at its default while the configuration appears to raise it.'
      )
    }
  }
}

/** True for a plain object, so arrays and null are replaced rather than merged into. */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Merge an override over a base, validating the shape as it goes. Arrays replace, objects merge. */
function merge(base, override, where) {
  if (override === undefined) return base
  if (!isPlainObject(base) || !isPlainObject(override)) return override
  const out = { ...base }
  for (const [key, value] of Object.entries(override)) {
    const at = where + '.' + key
    out[key] = isPlainObject(value) ? merge(base[key] ?? {}, value, at) : value
  }
  return out
}

/** One ceiling: an integer of at least 1, or the configuration is refused. */
function assertCeiling(value, name) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error('ai-sdlc: ' + name + ' must be a positive integer, got ' + String(value))
  }
}

/** One tier: present, carrying only known keys, and with a usable path pattern. */
function assertTier(config, tier) {
  if (!config.tiers || !config.tiers[tier]) throw new Error('ai-sdlc: tiers.' + tier + ' is required')
  assertKnownKeys(config.tiers[tier], TIER_KEYS, 'tiers.' + tier)
  if (typeof config.tiers[tier].pattern !== 'string') {
    throw new Error('ai-sdlc: tiers.' + tier + '.pattern must be a regular-expression string')
  }
}

/** Validate the merged configuration: the ceilings must be usable numbers, and the lists arrays. */
function validate(config) {
  assertCeiling(config.complexity.max, 'complexity.max')
  assertCeiling(config.complexity.maxLinesPerFunction, 'complexity.maxLinesPerFunction')
  assertCeiling(config.delegation && config.delegation.flakeIterations, 'delegation.flakeIterations')
  if (!Array.isArray(config.complexity.baseline)) {
    throw new Error('ai-sdlc: complexity.baseline must be an array')
  }
  for (const tier of ['corePrimitives', 'protocolEngines', 'imperativeShell']) assertTier(config, tier)
  if (typeof config.ledgerRef !== 'string' || !config.ledgerRef.startsWith('refs/notes/')) {
    throw new Error('ai-sdlc: ledgerRef must be a refs/notes/* ref, got ' + String(config.ledgerRef))
  }
  return config
}

/**
 * Read the policy for a repository root.
 *
 * @param {string} [rootDir] repository root; defaults to the current working directory.
 * @returns {{config: object, source: string}} the resolved policy and what produced it.
 */
function loadPolicyConfig(rootDir = process.cwd()) {
  assertKnownKeys(SENSIBLE_DEFAULTS, TOP_LEVEL_KEYS, 'defaults')
  assertKnownKeys(SENSIBLE_DEFAULTS.complexity, COMPLEXITY_KEYS, 'defaults.complexity')

  const overridePath = path.join(rootDir, CONFIG_BASENAME)
  if (!fs.existsSync(overridePath)) {
    return { config: validate(merge(SENSIBLE_DEFAULTS, {}, 'ai-sdlc')), source: 'defaults' }
  }

  // `require` rather than a parser: the override is a .cjs module, and requiring it is the same
  // trust decision the rest of the toolchain makes about this repository's own scripts.
  const override = require(overridePath)
  if (!isPlainObject(override)) {
    throw new Error('ai-sdlc: ' + CONFIG_BASENAME + ' must export a plain object')
  }
  assertKnownKeys(override, TOP_LEVEL_KEYS, CONFIG_BASENAME)
  if (override.complexity) assertKnownKeys(override.complexity, COMPLEXITY_KEYS, CONFIG_BASENAME + '.complexity')
  if (override.delegation) assertKnownKeys(override.delegation, DELEGATION_KEYS, CONFIG_BASENAME + '.delegation')

  return { config: validate(merge(SENSIBLE_DEFAULTS, override, 'ai-sdlc')), source: overridePath }
}

module.exports = { SENSIBLE_DEFAULTS, CONFIG_BASENAME, loadPolicyConfig }
