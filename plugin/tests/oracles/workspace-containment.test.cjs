const { test } = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

const DIST = path.join(__dirname, '..', '..', 'dist', 'containment.js')
const { resolveWorkspaceContainment } = require(DIST)

/**
 * Real directories on purpose. Every path below EXISTS, so canonicalisePath's realpathSync actually
 * runs rather than falling back to the unresolved spelling -- the trap that made an earlier oracle in
 * this suite assert nothing. No POSIX literals: `path.join(base, '..')` is meaningful on every
 * platform, and `path.resolve('/ws')` is not.
 */
const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ws-contain-'))
const SESSION = path.join(BASE, 'session')
const INSIDE = path.join(SESSION, 'packages', 'app')
const EXTERNAL = path.join(BASE, 'external')
const ALLOWLISTED = path.join(BASE, 'granted')
const OUTSIDE = path.join(BASE, 'elsewhere')
for (const d of [SESSION, INSIDE, EXTERNAL, ALLOWLISTED, OUTSIDE]) fs.mkdirSync(d, { recursive: true })

const call = (requested, extra = {}) =>
  resolveWorkspaceContainment({
    requested,
    sessionRoot: SESSION,
    allowedRoots: [ALLOWLISTED],
    canPrompt: false,
    ...extra,
  })

test('containment: an omitted workspaceDir is trusted at the session root', () => {
  const r = call(undefined)
  assert.equal(r.trusted, true)
  assert.equal(r.needsApproval, false)
  assert.equal(r.source, 'session-root')
  assert.equal(r.dir, SESSION, 'the effective base must be the session root')
})

test('containment: a subdirectory of the session root is trusted', () => {
  const r = call(INSIDE)
  assert.equal(r.trusted, true)
  assert.equal(r.source, 'within-session-root')
  assert.equal(r.dir, INSIDE)
})

test('containment: the session root itself is trusted', () => {
  const r = call(SESSION)
  assert.equal(r.trusted, true)
  assert.equal(r.source, 'within-session-root')
})

test('containment: an allowlisted root outside the session is trusted', () => {
  const r = call(ALLOWLISTED)
  assert.equal(r.trusted, true, 'the operator grant is what makes this writable')
  assert.equal(r.source, 'emitAllowlist')
})

test('containment: a directory inside an allowlisted root is trusted', () => {
  const nested = path.join(ALLOWLISTED, 'sub')
  fs.mkdirSync(nested, { recursive: true })
  const r = call(nested)
  assert.equal(r.trusted, true)
  assert.equal(r.source, 'emitAllowlist')
})

test('containment: outside every root and unable to prompt is REFUSED, not silently allowed', () => {
  const r = call(OUTSIDE, { canPrompt: false })
  assert.equal(r.trusted, false)
  assert.equal(r.needsApproval, false)
  assert.equal(r.source, 'outside-refused')
  assert.match(String(r.reason), /emitAllowlist/, 'the refusal must name the way to authorise it')
  assert.match(String(r.reason), /refused/i)
})

test('containment: outside every root WITH approval reachable asks rather than refuses', () => {
  const r = call(OUTSIDE, { canPrompt: true })
  assert.equal(r.trusted, false, 'asking is not trusting; the caller must obtain approval')
  assert.equal(r.needsApproval, true)
  assert.equal(r.source, 'outside-awaiting-approval')
  assert.equal(r.dir, OUTSIDE, 'the intended directory is reported so the prompt can name it')
})

test('containment: a .. escape from the session root is refused', () => {
  const r = call(path.join(SESSION, '..', 'external'), { canPrompt: false })
  assert.equal(r.trusted, false, '.. must resolve before the check, not after')
  assert.equal(r.needsApproval, false)
})

test('containment: no allowlist at all still trusts the session root', () => {
  const r = resolveWorkspaceContainment({
    requested: SESSION,
    sessionRoot: SESSION,
    allowedRoots: [],
    canPrompt: false,
  })
  assert.equal(r.trusted, true)
})

test('containment: blank and whitespace requested values behave as omitted', () => {
  for (const requested of ['', '   ', null, undefined]) {
    const r = call(requested)
    assert.equal(r.trusted, true, JSON.stringify(requested) + ' must be treated as omitted')
    assert.equal(r.dir, SESSION)
  }
})

test('containment: a requested path equal to the allowlist root is not a prefix accident', () => {
  // A sibling whose name merely STARTS with the allowlist root's name must not be trusted. String
  // prefix matching would allow it; isPathWithin, which compares path segments, must not.
  const sneaky = ALLOWLISTED + '-sibling'
  fs.mkdirSync(sneaky, { recursive: true })
  const r = call(sneaky, { canPrompt: false })
  assert.equal(r.trusted, false, 'a name-prefix sibling is NOT inside the root')
})
