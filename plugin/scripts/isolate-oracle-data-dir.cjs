#!/usr/bin/env node
/**
 * Preload for the `.cjs` oracle runner: redirect the plugin's data directory out of the operator's
 * real `~/.dsh`.
 *
 * Why this exists rather than a redirect in each oracle. `npm test` (vitest) redirects `DSH_HOME`
 * through `vitest.config.ts`, but the oracles run under `node --test`, which never loads that config.
 * Only 7 of 28 oracles set the variable themselves, so the rest appended their fixtures to the real
 * `~/.dsh/local-router/router-debug.log`. That file is the instrument `docs/live-verification.md` is
 * built from, so the leak was attacking this project's own evidence base. A per-file convention had
 * already been tried, and had already failed, for exactly the oracles nobody remembered to update;
 * this is the one central redirect instead.
 *
 * `DSH_HOME` is used rather than `DSH_LOCAL_ROUTER_DATA_DIR`, matching `vitest.config.ts`: the
 * data-dir override is taken verbatim, so it would break `resolveDataDir`'s own assertion that the
 * result ends in `local-router`, while `DSH_HOME` is joined with that segment and keeps its meaning.
 *
 * The directory is decided once, in the parent `node --test` process, and inherited by every test
 * child through `DSH_ORACLE_HOME`. Deciding it per child would also isolate correctly but would leave
 * one temp directory behind per test file on every run instead of one per run.
 *
 * `logging.ts` computes its log path at module load time, so this must run before anything requires
 * `dist`. That is what `--require` guarantees and what a redirect inside a test file cannot provide.
 *
 * Rollback: delete this file and drop `--require ./scripts/isolate-oracle-data-dir.cjs` from the
 * `test:oracles` script in `package.json`. `scripts/check-oracle-isolation.cjs` will go red again,
 * which is the point of it existing.
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// The parent decides; a test child inherits. `DSH_ORACLE_HOME` is the signal for "already decided",
// and it is a variable the plugin itself never reads.
if (!process.env.DSH_ORACLE_HOME) {
  process.env.DSH_ORACLE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-oracles-home-'))
}
process.env.DSH_HOME = process.env.DSH_ORACLE_HOME

// An ambient override would win over `DSH_HOME` in `resolveDataDir`, which is the one way this
// redirect could silently stop working. Oracles that set it themselves do so after this preload runs,
// so they still choose their own directory.
delete process.env.DSH_LOCAL_ROUTER_DATA_DIR

// Fail loudly rather than quietly polluting. If the redirect ever stops resolving where it should --
// a renamed variable, a changed precedence rule -- the oracle run dies here instead of writing test
// fixtures into the operator's live log for another few months.
const resolved = path.resolve(path.join(process.env.DSH_HOME, 'local-router'))
const live = path.resolve(path.join(os.homedir(), '.dsh', 'local-router'))
if (resolved === live) {
  throw new Error(
    'oracle data-dir isolation failed: the plugin would resolve its data directory to the live ' +
      'location ' +
      live +
      '. Refusing to run the oracles against the operator\u2019s real state.'
  )
}
