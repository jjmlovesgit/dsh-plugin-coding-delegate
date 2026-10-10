const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const DIST = path.join(__dirname, '..', '..', 'dist', 'routing.js')
const { classifyDestination } = require(DIST)

// The documented cloud-only setup: both sides point at the same provider id.
const CLOUD_ONLY = {
  provider: 'deepseek-official',
  localProvider: 'deepseek-official',
  cloudProvider: 'deepseek-official',
}

// A genuine local model, distinct from the cloud.
const HYBRID = {
  provider: 'deepseek-official',
  localProvider: 'lm-studio',
  cloudProvider: 'deepseek-official',
}

test('locality: cloud-only + entropy-only + dlpAction local is REFUSED, not pinned to the cloud', () => {
  const r = classifyDestination({ ...CLOUD_ONLY, dlpTripped: true, entropyOnly: true, dlpAction: 'local' })
  assert.equal(r.decision, 'block', 'the pin would send the payload to the same provider')
  assert.equal(r.destination, 'cloud', 'and it must not claim to be local')
  assert.equal(r.rerouteLocal, false)
  assert.match(String(r.reason), /identical to cloudProvider|Cannot guarantee/i)
})

test('locality: cloud-only + entropy-only + dlpAction undefined is REFUSED too', () => {
  const r = classifyDestination({ ...CLOUD_ONLY, dlpTripped: true, entropyOnly: true })
  assert.equal(r.decision, 'block', 'entropy-only used to reroute here; with nowhere to go it must refuse')
  assert.equal(r.destination, 'cloud')
})

test('locality: cloud-only + entropy-only + dlpAction block is refused outright', () => {
  const r = classifyDestination({ ...CLOUD_ONLY, dlpTripped: true, entropyOnly: true, dlpAction: 'block' })
  assert.equal(r.decision, 'block')
  assert.equal(r.destination, 'cloud')
})

test('locality: a distinct local provider accepts the reroute', () => {
  const r = classifyDestination({ ...HYBRID, dlpTripped: true, entropyOnly: true, dlpAction: 'local' })
  assert.equal(r.decision, 'proceed')
  assert.equal(r.destination, 'local')
  assert.equal(r.rerouteLocal, true, 'the caller needs this to pin the request')
})

test('locality: high-confidence with dlpAction local still reroutes', () => {
  const r = classifyDestination({ ...HYBRID, dlpTripped: true, entropyOnly: false, dlpAction: 'local' })
  assert.equal(r.destination, 'local')
  assert.equal(r.rerouteLocal, true)
})

test('locality REGRESSION GUARD: high-confidence with dlpAction undefined must be REFUSED', () => {
  // This case originally asserted proceed, reasoning that egress would stop the payload because the
  // destination was cloud. That reasoning was wrong and the assertion hid a real hole: with a DISTINCT
  // local provider the classifier matched `provider === localProvider` and returned proceed/LOCAL, so
  // the credential passed the DLP gate and source egress saw a local route as well. Four existing
  // dlp-gate tests failed with "Missing expected rejection" once shouldBlock was removed.
  //
  // The rule is the one the original expression encoded: only an entropy-only hit, or an explicit
  // 'local' action, may be rerouted. High confidence with no policy is refused.
  const r = classifyDestination({ ...HYBRID, dlpTripped: true, entropyOnly: false })
  assert.equal(r.decision, 'block', 'a high-confidence secret with no explicit local policy is refused')
  assert.equal(r.rerouteLocal, false)
})

test('locality REGRESSION GUARD: entropy-only with dlpAction undefined still reroutes', () => {
  const r = classifyDestination({ ...HYBRID, dlpTripped: true, entropyOnly: true })
  assert.equal(r.destination, 'local')
  assert.equal(r.rerouteLocal, true)
})

test('locality: high-confidence with dlpAction block is refused', () => {
  const r = classifyDestination({ ...HYBRID, dlpTripped: true, entropyOnly: false, dlpAction: 'block' })
  assert.equal(r.decision, 'block')
})

test('locality: an ordinary cloud request is cloud, and this is the case the first draft got wrong', () => {
  // No DLP, no reroute. A classifier that answers "local" here would let source egress permit source
  // to the cloud on NORMAL traffic -- worse than the defect being fixed.
  const r = classifyDestination({ ...HYBRID, dlpTripped: false, entropyOnly: false })
  assert.equal(r.destination, 'cloud')
  assert.equal(r.decision, 'proceed')
  assert.equal(r.rerouteLocal, false)
})

test('locality: cloud-only with an ordinary request is still cloud', () => {
  const r = classifyDestination({ ...CLOUD_ONLY, dlpTripped: false, entropyOnly: false })
  assert.equal(r.destination, 'cloud', 'provider equals localProvider, but that is not locality')
})

test('locality: a provider equal to a DISTINCT localProvider is local', () => {
  // Spread order matters: HYBRID carries provider: 'deepseek-official', so it must come FIRST and the
  // provider override LAST. The first draft had them the other way round, so this case silently tested
  // a cloud provider and asserted 'local'. The test was wrong, not the classifier.
  const r = classifyDestination({ ...HYBRID, provider: 'lm-studio', dlpTripped: false, entropyOnly: false })
  assert.equal(r.destination, 'local')
})

test('locality: no localProvider configured means cloud, and a reroute is refused', () => {
  const bare = { provider: 'deepseek-official', localProvider: '', cloudProvider: 'deepseek-official' }
  const normal = classifyDestination({ ...bare, dlpTripped: false, entropyOnly: false })
  assert.equal(normal.destination, 'cloud')

  const reroute = classifyDestination({ ...bare, dlpTripped: true, entropyOnly: true, dlpAction: 'local' })
  assert.equal(reroute.decision, 'block', 'nothing local to route to')
})

test('locality: provider id casing and surrounding space do not change the answer', () => {
  const r = classifyDestination({
    provider: '  LM-Studio  ',
    localProvider: 'lm-studio',
    cloudProvider: 'deepseek-official',
    dlpTripped: false,
    entropyOnly: false,
  })
  assert.equal(r.destination, 'local')
})

// ─── Structural assertions: the gate must actually CALL this classifier, with real inputs ──────────
//
// The behavioural cases above all pass against a classifier that nothing invokes -- the attestation
// unit shipped exactly that through a fully green gate. But there is a second failure mode here that
// those cases cannot see either: the call site passing a STALE or pre-computed value. If index.ts
// forwards a reroute decision derived from the old `entropyOnly || dlpAction === 'local'` expression
// instead of the raw inputs, half 1 of the finding comes back while every case above still passes.
//
// So this checks the wiring AND the argument names, not just the presence of a call.

const SRC_INDEX = path.join(__dirname, '..', '..', 'src', 'index.ts')
const DIST_INDEX = path.join(__dirname, '..', '..', 'dist', 'index.js')

test('structural: index.ts imports and calls classifyDestination directly', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  assert.match(
    src,
    /import\s*\{[^}]*\bclassifyDestination\b[^}]*\}\s*from\s*['"]\.\/routing['"]/,
    'index.ts must import classifyDestination from ./routing'
  )
  assert.match(
    src,
    /const\s+classification\s*=\s*classifyDestination\s*\(\s*\{/,
    'classification must be assigned directly from the call'
  )
  assert.doesNotMatch(
    src,
    /const\s+classification\s*=\s*[^\n]{0,80}(?:\|\||&&|\?\?|!==|===)\s*[^\n]{0,80}classifyDestination/,
    'no fallback expression may precede the call'
  )
})

test('structural: the call passes the RAW policy inputs, not a pre-computed reroute decision', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  const at = src.indexOf('classifyDestination({')
  assert.ok(at >= 0, 'the call must exist')
  const args = src.slice(at, at + 500)

  // These are what the classifier needs to make the decision itself. A caller that passes a
  // derived boolean instead has moved the policy OUT of the tested unit, which is how half 1 hid.
  //
  // `dlpTripped` and `entropyOnly` are passed as SHORTHAND properties, so they appear with no colon.
  // The first draft of this check required `dlpTripped:` and failed against correct code -- the second
  // time in this file that a check was wrong rather than the thing it checked.
  for (const key of ['provider:', 'localProvider:', 'cloudProvider:', 'dlpAction:']) {
    assert.ok(args.includes(key), 'the call must pass ' + key + ' -- the classifier owns this decision')
  }
  for (const shorthand of ['dlpTripped', 'entropyOnly']) {
    assert.match(
      args,
      new RegExp('(?:^|[^\\w.])' + shorthand + '\\s*[,}]'),
      'the call must pass ' + shorthand + ', as a value or shorthand, not omit it'
    )
  }
  assert.ok(
    !/rerouteLocal\s*:/.test(args),
    'the call must not pass a pre-computed rerouteLocal; that is the output, not an input'
  )
})

test('structural: rerouteLocal comes FROM the classification, and the dead branch is gone', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  assert.match(src, /const\s+rerouteLocal\s*=\s*classification\.rerouteLocal/, 'the reroute must come from the classification')
  assert.doesNotMatch(
    src,
    /const\s+rerouteLocal\s*=\s*dlpTripped\s*&&/,
    'the old inline reroute expression must be gone'
  )
  // CODE, not prose. The identifier still appears in a comment explaining why the branch was removed,
  // and a bare word check flagged that as a regression -- the third wrong check in this file.
  assert.doesNotMatch(
    src,
    /if\s*\(\s*shouldBlock\s*\)/,
    'the superseded shouldBlock branch must not be executable'
  )
  assert.doesNotMatch(
    src,
    /const\s+shouldBlock\s*=/,
    'and its binding must not be reintroduced'
  )
})

test('structural: exactly one DLP block throw survives, and it names the offending pattern', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  const throws = src.match(/DLP firewall blocked this request/g) || []
  assert.equal(throws.length, 1, 'removing the wrong branch would leave two throws or none -- found ' + throws.length)
  // Naming the pattern is what tells an operator what to remove, and dlp-gate.test.cjs asserts it.
  assert.match(
    src,
    /const violations = dlpResult\.violations\.join\(', '\)/,
    'the block must report the matched patterns, not only the policy'
  )
  assert.match(src, /DLP_FIREWALL_REROUTE/, 'the reroute warning must survive the cleanup')
})

test('structural: the built bundle carries the classifier call', () => {
  const dist = fs.readFileSync(DIST_INDEX, 'utf8')
  assert.ok(dist.includes('classifyDestination'), 'dist/index.js must carry the call; rebuild if this fails')
})

