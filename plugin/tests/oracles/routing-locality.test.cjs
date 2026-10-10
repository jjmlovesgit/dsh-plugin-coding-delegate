const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

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

test('locality REGRESSION GUARD: high-confidence with dlpAction undefined must NOT be rerouted', () => {
  // Undefined means "not block, not local", and the behaviour it must preserve is: entropy-only
  // reroutes, high-confidence does not. Getting this wrong silently widens what may travel.
  const r = classifyDestination({ ...HYBRID, dlpTripped: true, entropyOnly: false })
  assert.equal(r.destination, 'cloud', 'a high-confidence secret with no policy is not rerouted')
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
