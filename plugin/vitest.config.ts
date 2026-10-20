import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { defineConfig } from 'vitest/config'

// Every unit test runs with plugin state redirected out of the operator's real ~/.dsh.
//
// The delegation tests write files on the worker's behalf, and `rememberDelegated` persists what it
// wrote to the plugin data directory -- so `npm test` used to append to the operator's live
// delegated-registry.json. Measured, not assumed: one run added one record. That is undeclared state
// mutation from a test run, and it is invisible unless you go looking in the registry.
//
// `DSH_HOME` is used rather than `DSH_LOCAL_ROUTER_DATA_DIR` deliberately. The data-dir override is
// taken verbatim, which would break `resolveDataDir`'s own assertion that the result ends in
// `local-router`; DSH_HOME is joined with that segment, so the assertion keeps its meaning.
const TEST_DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-vitest-home-'))

export default defineConfig({
  test: {
    // The unit tests are TypeScript. tests/oracles/ holds node:test suites -- run separately by
    // `npm run test:oracles` -- and vitest's default `**/*.test.*` pattern swept those up and
    // failed with "No test suite found in file". Scoping the include to `.ts` keeps the two
    // runners out of each other's way.
    include: ['tests/**/*.test.ts'],
    // THE BUDGET IS NOT A PERFORMANCE TARGET. Several suites shell out to real `git` -- `makeRepo`
    // initialises a repository, runs commits and reads back refs -- and a shared CI runner can take
    // longer than five seconds to do that under load. Measured: `attestation-drift.test.ts >
    // refuses to attest when the verification command commits` timed out at 5000 ms on one run and
    // passed on the rerun with no code change, which is the definition of a flake. A timeout that
    // reports a slow machine as a defect teaches people to rerun instead of read.
    testTimeout: 20000,
    env: {
      DSH_HOME: TEST_DSH_HOME,
    },
  },
})
