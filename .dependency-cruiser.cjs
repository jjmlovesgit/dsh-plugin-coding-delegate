#!/usr/bin/env node
/**
 * AST import fences for the AI-SDLC tiers (POL-SEC-AISDLC-001 §6.1, NIST SA-11).
 *
 * Every path and ceiling here comes from `scripts/policy-config.cjs`, so this file holds rules and
 * no policy numbers. A rule whose path matches nothing is worse than no rule: it reports a clean
 * graph over a tree it never inspected, which is the shape of green this repository treats as a
 * defect. `--config` is therefore paired with an explicit file list in the npm script, and the
 * `tier1-is-a-leaf` rule is checked against real files today.
 *
 * THE THREE FENCES, and what each one stops:
 *
 *   1. `tier1-is-a-leaf` -- a Tier 1 primitive may import NOTHING. Not another primitive, not a
 *      Node builtin, not a type. That is the ADR's "total leaf isolation" mitigation for transitive
 *      type-only leaks: the only way to be sure a type import never emits runtime code is to have
 *      no imports at all, and the operator can verify it by reading one line of the module.
 *
 *   2. `no-tier3-behind-the-fence` -- nothing in Tier 1 or Tier 2 may import Tier 3. This is the
 *      "inward" direction the policy names: glue code and scripts are where an un-attested analogue
 *      of a primitive would otherwise be smuggled back into the engine.
 *
 *   3. `tier2-owns-its-package` -- `plugin/src` must resolve entirely inside `plugin/`. The plugin
 *      ships as `plugin/dist` and is installed into a DSH profile on its own; an import reaching
 *      `../../tools` would work in this checkout and fail in every install.
 */
'use strict'

const { loadPolicyConfig } = require('./scripts/policy-config.cjs')

const { config, source } = loadPolicyConfig(__dirname)
const { tiers } = config

module.exports = {
  forbidden: [
    {
      name: 'tier1-is-a-leaf',
      severity: 'error',
      comment:
        'Tier 1 primitives must not depend on anything -- no runtime import, no Node builtin, no ' +
        'type-only import. See docs/architecture/ADR-SEC-AISDLC-001.md §5.2.',
      from: { path: tiers.corePrimitives.contractGoverned },
      to: { pathNot: tiers.corePrimitives.pattern },
    },
    {
      name: 'no-tier3-behind-the-fence',
      severity: 'error',
      comment:
        'Tier 1 and Tier 2 may not import Tier 3. Glue code is not an attestable substitute for a ' +
        'primitive. See POL-SEC-AISDLC-001 §6.1.',
      from: { path: tiers.corePrimitives.pattern + '|' + tiers.protocolEngines.pattern },
      to: { path: tiers.imperativeShell.pattern },
    },
    {
      name: 'tier2-owns-its-package',
      severity: 'error',
      comment:
        'plugin/src must resolve inside plugin/: the package ships as plugin/dist and is installed ' +
        'on its own, so a path that climbs out of the package works here and nowhere else. Stated ' +
        'as the trees it may not reach rather than as "everything except plugin/src", because Node ' +
        'builtins and npm packages resolve outside plugin/src by design and are not the hazard.',
      from: { path: tiers.protocolEngines.pattern },
      to: { path: '^(tools|scripts|tests|experiments)/' },
    },
  ],

  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: {
      path: 'node_modules|plugin/dist|plugin/node_modules|\\.git/',
    },
    // Treat type-only imports as dependencies. The leak this guards against is a TYPE that drags
    // its module into the graph, so excluding them would hide exactly the edge that matters.
    tsPreCompilationDeps: true,
    combinedDependencies: true,
    reporterOptions: {
      text: { highlightFocused: true },
    },
  },
}
