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

// ─── Structural assertions: the gate must actually RUN this decision ────────────────────────────────
//
// The same reason as the attestation oracle next door, and the lesson was learned twice: a pure
// function with a green oracle proves nothing about whether index.ts calls it. In the attestation unit
// the first wiring attempt landed an import and nothing else, and a full green gate -- build, 377/377,
// coherence, committed-dist -- reported success with the fix entirely inert.
//
// Here the stakes are the base directory for every containment check, so the wire-up is asserted
// rather than trusted. The source is read because the source IS the artefact that failed: dist is
// generated from it, and a check on dist alone would not say which side drifted.

const SRC_INDEX = path.join(__dirname, '..', '..', 'src', 'index.ts')
const DIST_INDEX = path.join(__dirname, '..', '..', 'dist', 'index.js')

test('structural: index.ts imports AND calls resolveWorkspaceContainment directly', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  assert.match(
    src,
    /import\s*\{[^}]*\bresolveWorkspaceContainment\b[^}]*\}\s*from\s*['"]\.\/containment['"]/,
    'index.ts must import resolveWorkspaceContainment from ./containment'
  )
  // Assigned FROM the call, with no expression before it. A `||`/`!==` fallback is a trivial way to
  // keep the call syntactically while making the real decision something else -- the exact mutation
  // that slipped past the first version of the attestation assertion.
  assert.match(
    src,
    /const\s+containment\s*=\s*resolveWorkspaceContainment\s*\(\s*\{/,
    'containment must be assigned directly from the call; a fallback expression defeats the gate'
  )
  assert.doesNotMatch(
    src,
    /const\s+containment\s*=\s*[^\n]{0,80}(?:\|\||&&|\?\?|!==|===)\s*[^\n]{0,80}resolveWorkspaceContainment/,
    'resolveWorkspaceContainment must not be the right-hand side of a fallback expression'
  )
})

test('structural: both non-trusted outcomes are handled, refuse and ask', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  assert.match(
    src,
    /if\s*\(!containment\.trusted\s*&&\s*!containment\.needsApproval\)/,
    'there must be a refusal path for untrusted destinations when no approval is reachable'
  )
  assert.match(
    src,
    /if\s*\(!containment\.trusted\s*&&\s*containment\.needsApproval\)/,
    'there must be an approval path for untrusted destinations when approval is reachable'
  )
  assert.match(
    src,
    /await\s+requestApprovalForWorkspace\s*\(/,
    'the approval path must actually consult the operator'
  )
})

test('structural: the refusal is a real CONTEXT_REFUSED verdict, not a bare object', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  // The worker is never called on this path, so the shape must be complete: a caller reading
  // testResults or tokens must not get undefined. Mirrors the CONTEXT_REFUSED returns in delegation.ts.
  //
  // Anchored on the refusal SITE with a bounded window rather than on the presence of each field
  // anywhere in a 1800-line file. A file-wide `status: 'CONTEXT_REFUSED'` check would pass even if the
  // containment refusal returned a bare `{ error }`, because a match elsewhere would satisfy it.
  const site = src.indexOf('if (!containment.trusted && !containment.needsApproval)')
  assert.ok(site >= 0, 'the refusal site must exist')
  const window = src.slice(site, site + 700)
  assert.match(window, /status:\s*'CONTEXT_REFUSED'/, 'the refusal must carry the CONTEXT_REFUSED status')
  assert.match(
    window,
    /testResults:\s*\{\s*passed:\s*0,\s*failed:\s*0,\s*output:\s*'The worker was not called\.'\s*\}/,
    'the refusal must carry a real zeroed testResults, not null and not a missing field'
  )
  assert.match(window, /tokens:\s*\{\s*prompt:\s*0,\s*completion:\s*0\s*\}/, 'and a real zeroed tokens block')
})

/** Slice a top-level function body by brace matching, so a later `return false` cannot mask an earlier `return true`. */
function functionBody(src, signature) {
  const start = src.indexOf(signature)
  if (start < 0) return ''
  const open = src.indexOf('{', start)
  if (open < 0) return ''
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) return src.slice(open, i + 1)
    }
  }
  return src.slice(open)
}

test('structural: the helper fails closed on every error path', () => {
  const src = fs.readFileSync(SRC_INDEX, 'utf8')
  assert.match(
    src,
    /export\s+async\s+function\s+requestApprovalForWorkspace\s*\(/,
    'requestApprovalForWorkspace must be defined'
  )
  const body = functionBody(src, 'export async function requestApprovalForWorkspace(')
  assert.ok(body, 'the helper body must be locatable')

  // Absent service, absent agent, thrown request: each must return false rather than proceeding.
  assert.match(body, /if\s*\(!service\s*\|\|\s*typeof\s+service\.request\s*!==\s*'function'\)\s*return\s+false/, 'an unreachable approval service must not be consent')
  assert.match(body, /if\s*\(!exec\?\.agent\)\s*return\s+false/, 'no agent means no approval')

  // The grant must be the OPERATOR'S ANSWER, not a constant. An earlier version of this check looked
  // for the string 'allowed-once' anywhere in the body, and a mutation replacing the return with
  // `return true` kept the string in the comparison above it while removing the check entirely.
  assert.match(body, /return\s+outcome\s*===\s*'allowed-once'/, 'only an explicit grant is consent')
  assert.doesNotMatch(body, /return\s+true/, 'the helper must never return true directly; only the outcome check grants')

  // Every catch in the helper must REFUSE, and must not grant. The weaker shape
  // `catch[\s\S]*return false` passed a mutation that inserted `return true` at the top of the handler,
  // because the false further down still satisfied it. Logging before refusing is correct, so this
  // does not demand that the return be first -- only that no catch can ever return true.
  const catches = body.split('catch').slice(1)
  assert.ok(catches.length >= 1, 'the helper must handle a thrown request at all')
  for (const c of catches) {
    assert.match(c, /return\s+false/, 'a thrown request must resolve to refusal')
    assert.doesNotMatch(c, /return\s+true/, 'a catch must never grant approval')
  }
})

test('structural: the built bundle agrees with the source', () => {
  const dist = fs.readFileSync(DIST_INDEX, 'utf8')
  assert.ok(
    dist.includes('resolveWorkspaceContainment'),
    'dist/index.js must carry the containment call; rebuild if this fails'
  )
})

