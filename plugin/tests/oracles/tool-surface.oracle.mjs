// Oracle for the tool surface: every parameter a caller may send must be IN the schema the caller sees.
//
// WHY THIS EXISTS, and the failure was not theoretical. `delegate_worker`'s parameters were declared
// twice -- inline in index.ts and again as DELEGATE_WORKER_OPENAI_SCHEMA in delegation.ts -- and
// `attestTargets`/`attestEvidence` were added to only the first. The result was silent in the worst way:
// the tool call succeeded, the unit verified, and the parameters were simply stripped on the way in. The
// response looked completely healthy and the feature did nothing.
//
// The duplication is now removed -- index.ts references the canonical schema -- and this asserts the
// property that makes the removal safe: the registered surface and the exported schema are the SAME
// OBJECT, not two copies that happen to agree today. Two copies that agree today is exactly what failed.
//
// The second half is the user-facing consequence. A parameter that exists in the implementation but not
// in the schema is unreachable: a model reading the schema cannot know to send it, and a caller who sends
// it anyway has it dropped. So the set of parameters is asserted explicitly rather than inferred, and
// adding a capability without exposing it fails here.
//
// Written as `.mjs` because the plugin's write guard classifies `.cjs` as source and refuses it to a cloud
// context. Running it needs no registry and no server: it is a pure inspection of the built artefact.
//
// Run directly:  node --test plugin/tests/oracles/tool-surface.oracle.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const plugin = require(path.join(HERE, '..', '..', 'dist', 'index.js'))

const CANONICAL = plugin.DELEGATE_WORKER_OPENAI_SCHEMA

test('tool surface: the registered schema and the exported schema are one object', () => {
  // Identity, not equality. Two structurally equal copies is the state that already broke once; the only
  // durable fix is that there is nothing to keep in sync.
  assert.equal(
    plugin.DELEGATE_WORKER_SCHEMA,
    CANONICAL,
    'DELEGATE_WORKER_SCHEMA must be the canonical schema itself, not a copy'
  )
  assert.ok(CANONICAL && CANONICAL.function, 'the schema must carry a function wrapper')
  assert.equal(CANONICAL.function.name, 'delegate_worker', 'and name the tool it describes')
})

test('tool surface: every parameter a caller may send is present in the schema', () => {
  const params = CANONICAL.function.parameters
  assert.ok(params && params.properties, 'the schema must declare properties')

  // Asserted as an explicit set rather than "at least these", so a parameter is never removed from the
  // surface without someone reading this line and deciding to.
  const expected = [
    'taskName',
    'instruction',
    'targetFiles',
    'runVerification',
    'verificationRepeats',
    'contractFiles',
    'contextFiles',
    'workspaceDir',
    'attestTargets',
    'attestEvidence',
    'attestOperator',
  ]
  const actual = Object.keys(params.properties)
  for (const name of expected) {
    assert.ok(
      actual.includes(name),
      "'" +
        name +
        "' is implemented but missing from the tool schema, which makes it unreachable: a model reading " +
        'the schema cannot know to send it, and a caller who sends it anyway has it dropped. This is the ' +
        'exact shape of the attestTargets bug.'
    )
  }
  assert.deepEqual(
    actual.slice().sort(),
    expected.slice().sort(),
    'the schema exposes a parameter this test does not know about -- add it here too, deliberately'
  )
  assert.deepEqual(params.required, ['taskName', 'instruction'], 'and the required set is unchanged')
})

test('tool surface: each attesting parameter documents what it actually does', () => {
  // The descriptions are the only documentation a model gets at call time, and this project has already
  // shipped one that claimed a capability the code did not have. These assertions are deliberately weak --
  // they check the claim is present, not that it is good -- because a stronger check would be a test of
  // prose and would fail on rewording.
  const props = CANONICAL.function.parameters.properties
  assert.match(
    props.attestTargets.description,
    /refused for a unit that did not pass/i,
    'attestTargets must say it is gated on a passing unit'
  )
  assert.match(
    props.attestOperator.description,
    /no fallback/i,
    'attestOperator must say there is no agent-id fallback, because inventing one was the first bug'
  )
  assert.match(
    props.verificationRepeats.description,
    /defaults? to 3/i,
    'verificationRepeats must state its default, since the fast path is the opt-in'
  )
})
