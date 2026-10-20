// Complexity ceilings for Tier 3 paths (POL-SEC-AISDLC-001 §6.2, ADR §3).
//
// Flat config, ESLint 9. The numbers and the file list come from `scripts/policy-config.cjs`, so the
// ceiling enforced here is the one the policy states rather than a second copy of it.
//
// WHY THE BASELINE EXISTS, AND WHY IT IS A RATCHET. The policy took effect on 2026-10-18 and every
// script in this repository predates it -- `verify-delegation-ledger.cjs` is 863 lines. Applying a
// 40-line function ceiling to that tree on day one fails the build for code nobody is touching, and
// the usual response to a linter that reds out everything is to stop running it. So the files that
// predate the policy are listed in `complexity.baseline` and exempted here; files added afterwards
// are governed from their first commit. The list only shrinks.
//
// WHAT IS DELIBERATELY NOT LINTED. `plugin/src` is Tier 2, and the policy's verification standard
// for Tier 2 is loopback and golden-trace suites, not cyclomatic ceilings. Pointing a complexity
// rule at it would produce noise that says nothing about the tier's actual obligation, so this
// config does not pretend to govern it -- `npm run gate:arch` is where its boundary is checked.
import { createRequire } from 'node:module'
import tsParser from '@typescript-eslint/parser'
import importPlugin from 'eslint-plugin-import'

const require = createRequire(import.meta.url)
const { loadPolicyConfig } = require('./scripts/policy-config.cjs')
const { config } = loadPolicyConfig(process.cwd())

const { max, maxLinesPerFunction, baseline } = config.complexity
// Today's Tier 3 plus the paths the policy reserves for it. ESLint ignores patterns that match no
// file, so declaring `src/routes/**` now costs nothing and means the ceiling applies the moment that
// directory appears -- the same arming the dependency fence needed and did not have.
const tier3 = [
  ...config.tiers.imperativeShell.globs,
  ...(config.tiers.imperativeShell.futureGlobs || []),
]

export default [
  {
    ignores: ['node_modules/**', 'plugin/dist/**', 'plugin/node_modules/**', 'docs/**', '**/*.d.ts'],
  },
  {
    files: tier3,
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'commonjs',
    },
    rules: {
      complexity: ['error', max],
      'max-lines-per-function': [
        'error',
        { max: maxLinesPerFunction, skipBlankLines: true, skipComments: true },
      ],
      // GOODHART'S LAW, PATCHED. A line-count ceiling invites collapsing control flow into dense
      // expressions -- measured here: the first Tier 3 adapter passed every ceiling by writing five
      // nested ternaries, which is legal, compact, and worse than the switch it replaced. The
      // complexity ceiling already permits a five-case switch (each case is +1), so the compression
      // was never required. Forbidding the pattern removes the incentive rather than arguing with it.
      'no-nested-ternary': 'error',
    },
  },
  {
    // Tier 3 is not all CommonJS: `scripts/probe-thinking.mjs` is an ES module. The ceiling still
    // applies to it -- it is glue either way -- but the parser has to be told, or the file fails to
    // parse and reports a syntax error that looks like a code defect. Later config objects win, so
    // this overrides only the language options.
    files: ['**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module' },
  },
  {
    // The reserved Tier 3 paths are TypeScript (`src/routes/**`, `src/ui/**`), and the flat config's
    // default parser is espree, which cannot read a type annotation. Without this block the ceiling
    // would be armed on those files and then fail on the first `:` as a parse error -- a red build
    // that says nothing about complexity. `scripts/**` stays on espree because it is CommonJS.
    files: ['**/*.ts'],
    languageOptions: { parser: tsParser, ecmaVersion: 2023, sourceType: 'module' },
  },
  {
    // THE SPECIFIER, NOT THE RESOLVED PATH. `dependency-cruiser` cannot enforce this rule: it matches
    // resolved module paths, and resolution appends the extension whether or not the source wrote it,
    // so an extensionless import and an explicit one are indistinguishable there. ESLint sees the
    // literal string, which is the thing Node's type stripping cares about -- it resolves `.ts`
    // specifiers literally, so `import x from './y'` works under one runner and fails under another.
    // `ignorePackages` keeps npm specifiers exempt: their exports maps are their own contract.
    files: ['src/**/*.ts'],
    plugins: { import: importPlugin },
    rules: {
      'import/extensions': ['error', 'ignorePackages', { ts: 'always' }],
    },
  },
  {
    // TIER 1 CEILINGS. These apply to the leaf primitives themselves, not only to the shell that calls
    // them. Until now a Tier 1 file was bounded by its discrimination contract and nothing else, so a
    // 300-line function with a ternary ladder was legal as long as its tests passed -- compliance by
    // accident rather than by construction. The limits are the same numbers as Tier 3 because the
    // concern is the same: a primitive that cannot be read cannot be verified by reading it.
    //
    // Note what this does NOT do: it does not replace the contract, the mutant fixture or the ledger.
    // Complexity is a readability proxy; the contract is the behavioural claim.
    files: ['tools/**/*.ts', 'src/core/primitives/**/*.ts'],
    rules: {
      complexity: ['error', max],
      'max-lines-per-function': [
        'error',
        { max: maxLinesPerFunction, skipBlankLines: true, skipComments: true },
      ],
      'no-nested-ternary': 'error',
    },
  },
  {
    // TIER 2 PROTOCOL CEILINGS. `src/core/protocol/**` is Tier 2 in the policy, and until this block
    // existed it matched NO ceiling rule at all -- the file would have been linted for import
    // extensions and nothing else, so "passes the Tier 2 ceilings" was a claim with nothing behind it.
    //
    // `plugin/src/**` is the other Tier 2 surface and is deliberately NOT included here: its files
    // predate the ceilings and adding them would fail a build for code nobody is changing. That gap is
    // recorded rather than papered over; it needs a baseline of its own, not a silent exemption.
    files: ['src/core/protocol/**/*.ts'],
    rules: {
      complexity: ['error', max],
      'max-lines-per-function': [
        'error',
        { max: maxLinesPerFunction, skipBlankLines: true, skipComments: true },
      ],
      'no-nested-ternary': 'error',
    },
  },
  {
    // The ratchet. Later config objects override earlier ones for the files they name, so these
    // files keep every other rule while the two ceilings are switched off for them.
    files: baseline,
    rules: {
      complexity: 'off',
      'max-lines-per-function': 'off',
      // The baseline predates this rule too, and for the same reason: two legacy scripts contain a
      // nested ternary, and rewriting them is a change to code nobody is touching. Files added after
      // the rule landed are governed from their first commit.
      'no-nested-ternary': 'off',
    },
  },
]
