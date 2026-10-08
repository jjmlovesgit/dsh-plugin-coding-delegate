// Contract oracle: the role comes from the host's session LINEAGE, not from a provider correlation.
//
// `roles.ts` has always said what it was doing: "This is a correlation, not lineage: the plugin sees an
// `agent` on `agent/request` and an `agent` on `tools/pre-execute`, and it assumes the same id means the
// same agent." That was honest and it was the weak point -- a read decision made on a guess.
//
// The 0.2.0-rc.2 core added `Session.header` with `origin?: 'subagent'` and `delegationDepth?: number`,
// so a root agent is now distinguishable from a subagent by what the host recorded, not by inference.
// Correlation stays as the fallback, because a host that says nothing should not make the plugin assume.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-role-data-'));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const PLUGIN = path.resolve(__dirname, '..', '..');
const DIST = PLUGIN + '/dist/index.js';

test('a root session is the architect, a subagent session is the lead', () => {
  const { roleFromLineage } = require(DIST);
  assert.equal(roleFromLineage({}), 'architect', 'no subagent markers means the root agent');
  assert.equal(roleFromLineage({ origin: undefined, delegationDepth: 0 }), 'architect');
  assert.equal(roleFromLineage({ origin: 'subagent' }), 'lead', 'the host says so outright');
  assert.equal(roleFromLineage({ delegationDepth: 1 }), 'lead', 'a delegated session is not the root');
  assert.equal(roleFromLineage(undefined), 'unknown', 'a missing header is not evidence of anything');
  assert.equal(roleFromLineage(null), 'unknown');
});

test('lineage beats the observed correlation, and correlation remains the fallback', () => {
  const { rememberAgentRole, roleForAgent, resetAgentRoles } = require(DIST);
  resetAgentRoles();
  rememberAgentRole('agent-x', 'lead');

  assert.equal(roleForAgent('agent-x'), 'lead', 'with no lineage, the correlation is all there is');
  assert.equal(
    roleForAgent('agent-x', { session: { header: {} } }),
    'architect',
    'lineage overrides a correlation that says otherwise'
  );
  assert.equal(
    roleForAgent('agent-x', { session: { header: { origin: 'subagent' } } }),
    'lead',
    'and agrees with the host when the host says subagent'
  );
  assert.equal(roleForAgent('unseen', { session: { header: {} } }), 'architect', 'lineage needs no history');
  assert.equal(roleForAgent('unseen'), 'unknown', 'and an unobserved id is still not guessed at');

  resetAgentRoles();
});
