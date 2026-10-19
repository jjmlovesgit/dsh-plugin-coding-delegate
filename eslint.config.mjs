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
    // The ratchet. Later config objects override earlier ones for the files they name, so these
    // files keep every other rule while the two ceilings are switched off for them.
    files: baseline,
    rules: {
      complexity: 'off',
      'max-lines-per-function': 'off',
    },
  },
]
