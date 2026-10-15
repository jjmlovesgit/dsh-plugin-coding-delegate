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
// Identity alone cannot see a MUTATION, though, so the last case below drives registration with the block
// mutated after load and requires it to refuse.
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

test('tool surface: the schema keys are checked against the canonical list AT COMPILE TIME', () => {
  // The runtime half of a build-time assertion. `DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER` is typed so
  // that it only COMPILES when the schema's keys and `DelegateWorkerParameter` are the same set -- which
  // makes a mismatched parameter impossible to build, not merely detectable afterwards.
  //
  // The assertion this replaces did nothing twice, and both failures are worth keeping in view. A type ALIAS
  // is never checked unless referenced, so it was decoration; and a one-directional conditional accepts a
  // schema with EXTRA keys, because structural assignability permits extra properties. Both were confirmed
  // by mutating the schema and watching tsc pass anyway. A check that cannot fail is the exact defect this
  // repository keeps finding, and it found a third instance here.
  assert.equal(
    plugin.DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER,
    true,
    'the compile-time schema/canonical assertion must be present and true in the built artefact'
  )
})

test('tool surface: the canonical parameter list lives in contracts.ts', () => {
  // Where it lives is part of the contract: `contracts.ts` owns the shared shapes and imports nothing from
  // delegation, so the canonical list cannot drift into a module that the schema also depends on.
  const contracts = require(path.join(HERE, '..', '..', 'dist', 'contracts.js'))
  assert.ok(contracts, 'contracts must be loadable independently of the schema')
  // The type itself is erased at runtime, which is the point: the coupling is enforced by tsc, and this
  // file only proves the asserting VALUE survived compilation.
  assert.equal(typeof plugin.DELEGATE_WORKER_SCHEMA_COVERS_EVERY_PARAMETER, 'boolean')
})

test('tool surface: the attesting parameters are ABSENT, so a caller cannot author a human claim', () => {
  // These three were REMOVED, and this case is the tripwire that keeps them removed.
  //
  // They let a caller choose who to name as the reviewing human and what evidence to record, and `index.ts`
  // honoured them by writing an OPERATOR_ATTESTED registry record out of those values. Scoping the targets
  // to files this unit had written never addressed the claim itself, because the identity and the evidence
  // both came from the same caller who benefited from the record. A caller-authored attestation is not an
  // attestation; it is the caller's claim about itself, and there is no version of that route a caller
  // cannot author.
  //
  // Asserted against the SCHEMA and not merely the handler, because the schema is what makes a parameter
  // reachable: a property in the schema is an invitation the model will accept, and the historical shape of
  // this bug was a parameter present in one copy of the schema and silently dropped by the other.
  const props = CANONICAL.function.parameters.properties
  for (const name of ['attestTargets', 'attestEvidence', 'attestOperator']) {
    assert.ok(
      !(name in props),
      "'" +
        name +
        "' must NOT be a property of the tool schema: it made a human-review claim a model-settable value. " +
        'If it is being reinstated deliberately, the reinstating change must also rewrite this assertion and ' +
        'say what makes the new route unforgeable by the caller who benefits from it.'
    )
  }
  // The one surviving prose check, which was never about attestation: a fast path that has to be opted into
  // is only safe if its default is stated where the model reads it.
  assert.match(
    props.verificationRepeats.description,
    /defaults? to 3/i,
    'verificationRepeats must state its default, since the fast path is the opt-in'
  )
})

test('tool surface: a parameter block mutated after load is refused, not registered', () => {
  // The drift assertion in index.ts used to compare the canonical object to ITSELF -- a check that cannot
  // fail, which is worse than none because it reads as evidence. What registration CAN still check is the
  // risk that object identity cannot see: the shared block being mutated after module load, by a
  // monkey-patch or by framework code decorating what it was handed. This drives that case.
  //
  // Fail-before: with the self-comparison in place both mounts below registered, so the second assertion
  // failed. The control mount matters as much as the mutation: without it, a version that registered
  // NOTHING would pass this case, which is the vacuity this file exists to prevent.
  const params = CANONICAL.function.parameters
  const registered = []
  const mount = () => {
    const ctx = { on: () => {}, get: () => undefined, tools: { register: (def) => registered.push(def) } }
    process.env.NODE_ENV = 'test'
    plugin.apply(ctx, {})
  }

  mount()
  assert.equal(registered.length, 1, 'the reviewed block must register')

  // The refusal must be THIS check. Registration can also fail for unrelated reasons, and a case that
  // accepted any failure would pass while the drift assertion did nothing.
  const warnings = []
  const realWarn = console.warn
  console.warn = (...args) => {
    warnings.push(args.join(' '))
  }

  params.properties.__injected = { type: 'string', description: 'added after load' }
  try {
    mount()
    assert.equal(registered.length, 1, 'a block mutated after load must not reach the host')
    assert.ok(
      warnings.some((line) => /delegate_worker schema drift/.test(line)),
      'the refusal must be the drift assertion and not another registration failure; warnings were: ' +
        warnings.join(' | ')
    )
  } finally {
    delete params.properties.__injected
    console.warn = realWarn
  }

  mount()
  assert.equal(registered.length, 2, 'and undoing the mutation restores the surface it guards')
})
