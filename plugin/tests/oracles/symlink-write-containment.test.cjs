// Oracle for the dangling-symlink containment escape (external security review, finding 2, CWE-22).
//
// The defect: `fs.existsSync` FOLLOWS links, so it answers false for a link whose target does not
// exist. The walk in canonicalisePath treated such a link as a directory the write would create, and
// re-appended the link's own name to a canonically in-workspace parent. The returned "canonical" path
// therefore stayed inside the workspace while the write itself followed the link out of it, and the
// containment gate -- which compared that spelling -- authorised the escape.
//
// Everything here is asserted through the shipped gate and the shipped write path, never through a
// reimplementation: `evaluateEmissionPath` is the decision, `extractAndEmitFiles` is the write. A test
// against a helper nobody calls would prove nothing about whether an escape is actually refused.
//
// Tests 1 to 3 are RED against the pre-fix build, so a green run cannot mean the file was written to
// match the implementation. Test 4 is the over-blocking guard: a fix that refused everything would pass
// tests 1 to 3 while breaking every real emission.
//
// Conventions, following workspace-containment.test.cjs: real directories and real links on disk under
// an OS temp dir, the plugin's own exports from dist/, and no backtick character anywhere in this file.
//
// On Windows, creating a symlink needs Developer Mode or elevation; this host has neither and the
// process is not elevated, so fs.symlinkSync with 'file' or 'dir' fails EPERM for every form. The one
// form that does work is a DIRECTORY JUNCTION, which is a real reparse-point link -- lstat reports
// isSymbolicLink true -- and unlike a file symlink it can also be created while its target is still
// missing. That is precisely the dangling case under test, so the regression is genuinely exercised
// here rather than skipped. makeLink reports which form it used, and the reason if it used none.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const PLUGIN = path.resolve(__dirname, '..', '..')
const {
  canonicalisePath,
  isPathWithin,
  describeSymlinkInPath,
} = require(PLUGIN + '/dist/paths.js')
const { evaluateEmissionPath, extractAndEmitFiles } = require(PLUGIN + '/dist/index.js')

const BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-symlink-contain-'))
const WS = path.join(BASE, 'workspace')
fs.mkdirSync(WS, { recursive: true })

// Test 1 needs a link to a directory that does not exist yet: the dangling shape.
const DANGLING_TARGET = path.join(BASE, 'outside-absent')
const DANGLING_LINK = path.join(WS, 'dangling')

// Tests 2 and 3 need a link whose target does exist, outside and inside the workspace respectively.
const OUTSIDE_REAL_DIR = path.join(BASE, 'outside-real')
const OUTSIDE_REAL_FILE = path.join(OUTSIDE_REAL_DIR, 'outside.ts')
const EXISTING_DIR_LINK = path.join(WS, 'linked-dir')
const EXISTING_FILE_LINK = path.join(WS, 'linked-file.ts')
const INSIDE_DIR = path.join(WS, 'realdir')
const INSIDE_DIR_LINK = path.join(WS, 'link-to-inside')

let linkForm = null
let linkFailure = null

/**
 * Create a real on-disk link named `link` pointing at `target`.
 *
 * 'junction' is a Windows directory reparse point: the same link semantics as a directory symlink but
 * creatable without the symlink privilege. It is tried after 'dir', so a host with Developer Mode gets
 * a genuine symlink. Files have no junction equivalent, so they can only be attempted as symlinks and
 * can genuinely fail on a Windows host without the privilege.
 */
function makeLink(target, link, kind) {
  const forms = kind === 'dir' ? ['dir', 'junction'] : ['file', null]
  const errors = []
  for (const form of forms) {
    try {
      if (form === null) fs.symlinkSync(target, link)
      else fs.symlinkSync(target, link, form)
      if (!linkForm) linkForm = form === null ? 'symlink (type inferred)' : 'symlink type=' + form
      return true
    } catch (err) {
      errors.push((form === null ? 'default' : form) + ':' + (err && err.code))
    }
  }
  if (!linkFailure) linkFailure = errors.join(' ')
  return false
}

let haveDanglingLink = false
let haveExistingDirLink = false

function setup() {
  haveDanglingLink = makeLink(DANGLING_TARGET, DANGLING_LINK, 'dir')

  fs.mkdirSync(OUTSIDE_REAL_DIR, { recursive: true })
  fs.writeFileSync(OUTSIDE_REAL_FILE, 'export const already = true\n', 'utf8')
  haveExistingDirLink = makeLink(OUTSIDE_REAL_DIR, EXISTING_DIR_LINK, 'dir')

  fs.mkdirSync(INSIDE_DIR, { recursive: true })
  makeLink(INSIDE_DIR, INSIDE_DIR_LINK, 'dir')
  makeLink(OUTSIDE_REAL_FILE, EXISTING_FILE_LINK, 'file')
}
setup()

// A run in which the links could not be created would report green while proving nothing about links,
// which is the failure mode this file exists to prevent. Say so on stderr, loudly, once.
if (!haveDanglingLink || !haveExistingDirLink) {
  console.error(
    '[dsh-symlink-containment] WARNING: no usable link could be created (' +
      (linkFailure || 'unknown') +
      '). The symlink regressions below are SKIPPED, and a green run of this file must not be read as ' +
      'evidence that link containment works on this host.'
  )
}

const NO_LINK = 'no symbolic link or junction could be created on this host'

/**
 * Skip with the host's real reason.
 *
 * THIS DELIBERATELY DOES NOT SET A FAILING EXIT CODE, and the reason is worth recording so it is not
 * "fixed" back. The first version set `process.exitCode = 1` on the first skip so that a run without the
 * symlink privilege could not be mistaken for a pass. That made the ORACLE SUITE RED on every Windows
 * host without Developer Mode -- including CI -- for a reason that says nothing about the code, which is
 * the permanently-red check this repository's own ledger audit calls "worse than no check, because it
 * trains people to ignore it". The gap stays visible without failing the suite: the stderr warning
 * above fires, the skip carries its reason, and the runner reports it in `# skipped`.
 *
 * The coverage actually lost is small: the skipped case is a link to an existing FILE, and the refusal
 * it asserts goes through the same lstat walk as the junction cases, which do run. What it would catch
 * that they do not is a regression specific to file reparse points, which no test on this host can
 * create.
 */
function skipUnless(ctx, ok) {
  if (ok) return false
  ctx.skip(NO_LINK + ' (' + (linkFailure || 'unknown') + ')')
  return true
}

process.on('exit', () => {
  try {
    fs.rmSync(BASE, { recursive: true, force: true })
  } catch {
    // A temp directory the OS will reap is not worth failing a test run over.
  }
})

/** The fenced emission a delegated worker produces, pointed at `relative`. */
function emissionFor(relative) {
  const fence = '\x60\x60\x60'
  return [fence + 'typescript file="' + relative + '"', 'export const escaped = true', fence].join('\n')
}

// ---------------------------------------------------------------------------
// 1 - the dangling-link escape itself. RED before the fix.
// ---------------------------------------------------------------------------

test('a destination written THROUGH a dangling link resolves outside, and is refused', (ctx) => {
  if (skipUnless(ctx, haveDanglingLink)) return

  // Guard the test itself: the link must really be dangling, or the ordinary realpath path would
  // resolve it and this would prove nothing about the existsSync blindness.
  assert.equal(
    fs.existsSync(DANGLING_LINK),
    false,
    'the regression is only meaningful while existsSync cannot see the link'
  )
  assert.equal(
    fs.lstatSync(DANGLING_LINK).isSymbolicLink(),
    true,
    'lstat, which does not follow the link, must report it as one'
  )

  const target = path.join(DANGLING_LINK, 'payload.ts')
  const expected = path.join(DANGLING_TARGET, 'payload.ts')

  // THE LOAD-BEARING ASSERTION. Pre-fix this returned the in-workspace spelling, i.e. a path naming
  // nothing that exists for a write that lands in DANGLING_TARGET.
  assert.equal(
    canonicalisePath(target),
    expected,
    'canonicalisePath must name where the bytes land, not an in-workspace spelling'
  )
  assert.equal(
    isPathWithin(WS, canonicalisePath(target)),
    false,
    'a path that resolves outside the workspace must not be reported as within it'
  )

  // The same conclusion through the shipped gate.
  const verdict = evaluateEmissionPath(target, WS)
  assert.equal(
    verdict.allowed,
    false,
    'containment must refuse a destination that only appears to be inside the workspace'
  )
  assert.match(String(verdict.reason), /symbolic link/i, 'and the refusal must name the mechanism')

  // ...and through the shipped WRITE path, which is the only thing that can put bytes on disk.
  const result = extractAndEmitFiles(emissionFor('dangling/payload.ts'), undefined, WS)
  assert.equal(result.filesWritten.length, 0, 'no file may be written through the link')
  assert.ok(
    !fs.existsSync(expected),
    'the bytes must not land outside the workspace at ' + expected
  )
  assert.ok(result.errors.length > 0, 'the refusal must be reported, not silent')
})

// ---------------------------------------------------------------------------
// 2 - a link to an EXISTING outside directory. RED before the fix (no refusal existed).
// ---------------------------------------------------------------------------

test('a link to an existing outside directory cannot be used to write a new file outside', (ctx) => {
  if (skipUnless(ctx, haveExistingDirLink)) return

  const target = path.join(EXISTING_DIR_LINK, 'via-link.ts')
  const outside = path.join(OUTSIDE_REAL_DIR, 'via-link.ts')
  assert.equal(fs.existsSync(target), false, 'the file under test must not exist yet')

  // The path really is inside the workspace as spelled, which is why the LINK, not containment, has to
  // be the thing that refuses it.
  assert.equal(isPathWithin(WS, target), true, 'the spelled path is inside the workspace')

  const verdict = evaluateEmissionPath(target, WS)
  assert.equal(verdict.allowed, false, 'a write through a link must be refused')
  assert.match(String(verdict.reason), /symbolic link/i, 'the refusal must name the link')
  assert.match(String(verdict.reason), /linked-dir/, 'and must say which component it was')

  const result = extractAndEmitFiles(emissionFor('linked-dir/via-link.ts'), undefined, WS)
  assert.equal(result.filesWritten.length, 0, 'no file may be written through the link')
  assert.ok(!fs.existsSync(outside), 'the bytes must not land outside the workspace')
  assert.ok(result.errors.length > 0, 'the refusal must be reported, not silent')
})

// ---------------------------------------------------------------------------
// 3 - a link pointing INSIDE the workspace, and a file link. RED before the fix.
//
// Containment alone cannot refuse these: the destination really is inside. Only the prohibition on
// links themselves can, which is the property this test pins.
// ---------------------------------------------------------------------------

test('a link pointing back INSIDE the workspace is still refused', (ctx) => {
  if (skipUnless(ctx, haveExistingDirLink)) return

  const target = path.join(INSIDE_DIR_LINK, 'inside.ts')
  const landing = path.join(INSIDE_DIR, 'inside.ts')

  assert.equal(
    isPathWithin(WS, canonicalisePath(target)),
    true,
    'this link really does point inside the workspace, so containment alone would allow it'
  )

  const verdict = evaluateEmissionPath(target, WS)
  assert.equal(verdict.allowed, false, 'the prohibition is unconditional, not a containment check')
  assert.match(String(verdict.reason), /symbolic link/i, 'and it must say why')

  // The write must not happen either. This is the assertion that would catch a refusal that only
  // reported a problem while the bytes still landed.
  const result = extractAndEmitFiles(emissionFor('link-to-inside/inside.ts'), undefined, WS)
  assert.equal(result.filesWritten.length, 0, 'nothing may be written through the link')
  assert.ok(!fs.existsSync(landing), 'the byte must not land inside the workspace through a link')
})

test('a link to an existing file is refused at write time', (ctx) => {
  const stat = fs.lstatSync(EXISTING_FILE_LINK, { throwIfNoEntry: false })
  if (skipUnless(ctx, stat !== undefined && stat.isSymbolicLink())) return

  const verdict = evaluateEmissionPath(EXISTING_FILE_LINK, WS)
  assert.equal(verdict.allowed, false, 'a file link must be refused like any other link')
  assert.match(String(verdict.reason), /symbolic link/i)
})

test('the detection primitive names the link component without following it', (ctx) => {
  if (skipUnless(ctx, haveExistingDirLink)) return

  const found = describeSymlinkInPath(path.join(EXISTING_DIR_LINK, 'x.ts'))
  assert.ok(found, 'lstat-based detection must find the link component')
  assert.equal(found.path, EXISTING_DIR_LINK, 'it must name the link itself, not the file below it')

  // A plain path is not a link, and neither is a plain path that does not exist yet.
  assert.equal(describeSymlinkInPath(path.join(WS, 'plain', 'x.ts')), null)
  assert.equal(describeSymlinkInPath(WS), null)
})

// ---------------------------------------------------------------------------
// 4 - ordinary paths must keep working. The over-blocking guard.
// ---------------------------------------------------------------------------

test('ordinary paths are unchanged by the link handling', () => {
  // An existing directory canonicalises through realpath exactly as before.
  assert.equal(canonicalisePath(WS), fs.realpathSync(WS))

  // A destination that does not exist yet still resolves through its nearest existing ancestor, and
  // still reports as inside. This is the shape of every legitimate emission.
  const unborn = path.join(WS, 'sub', 'file.ts')
  assert.equal(isPathWithin(WS, canonicalisePath(unborn)), true)
  assert.equal(evaluateEmissionPath(unborn, WS).allowed, true)

  // A .. escape is still refused -- the pre-existing property, pinned so the link work cannot regress it.
  assert.equal(evaluateEmissionPath(path.join(WS, '..', 'escape.ts'), WS).allowed, false)

  // The emission pipeline still writes an ordinary file. Without this, a fix that refuses everything
  // would be indistinguishable from a fix that works.
  const result = extractAndEmitFiles(emissionFor('sub/inside.ts'), undefined, WS)
  assert.equal(result.errors.length, 0, 'unexpected refusal: ' + result.errors.join('; '))
  assert.equal(result.filesWritten.length, 1)
  assert.equal(fs.existsSync(path.join(WS, 'sub', 'inside.ts')), true)
})

// ---------------------------------------------------------------------------
// 5 - a circular link must terminate rather than hang the request.
// ---------------------------------------------------------------------------

test('a link cycle terminates instead of recursing forever', (ctx) => {
  if (skipUnless(ctx, haveExistingDirLink)) return

  const cycleA = path.join(WS, 'cycle-a')
  const cycleB = path.join(WS, 'cycle-b')
  if (!makeLink(cycleB, cycleA, 'dir')) return
  if (!makeLink(cycleA, cycleB, 'dir')) return

  const start = Date.now()
  const canonical = canonicalisePath(path.join(cycleA, 'x.ts'))
  assert.equal(typeof canonical, 'string', 'a cycle must still produce a path')
  assert.ok(Date.now() - start < 5000, 'resolution must not spin on a cycle')
})

// ---------------------------------------------------------------------------
// 6 - a link ABOVE the workspace must not refuse ordinary writes. The scope guard.
// ---------------------------------------------------------------------------

test('a link above the workspace root does not refuse an ordinary write', (ctx) => {
  // The environment's links are not the artifact's: a junctioned project directory, a mapped drive, or
  // /var on macOS. Nothing a worker can create lives above its workspace, and containment already
  // resolves the root, so counting those links refused EVERY write in such a checkout. Measured before
  // the boundary existed: a plain emission under a junctioned parent reported one error and wrote zero
  // files, which would have taken the plugin out entirely for anyone whose checkout sat under a link.
  const HOST_REAL = path.join(BASE, 'host-real')
  const HOST_LINK = path.join(BASE, 'host-link')
  fs.mkdirSync(HOST_REAL, { recursive: true })
  if (!makeLink(HOST_REAL, HOST_LINK, 'dir')) return
  if (skipUnless(ctx, fs.lstatSync(HOST_LINK).isSymbolicLink())) return

  const nested = path.join(HOST_LINK, 'nested-ws')
  fs.mkdirSync(nested, { recursive: true })

  assert.equal(
    describeSymlinkInPath(nested, nested),
    null,
    'a link above the root is not a link in the artifact'
  )
  assert.equal(
    evaluateEmissionPath(path.join(nested, 'ok.ts'), nested).allowed,
    true,
    'an ordinary destination under a linked parent must still be writable'
  )

  // Through the real write path, because an allowed verdict that does not write is not the property.
  const result = extractAndEmitFiles(emissionFor('plain-ok.ts'), undefined, nested)
  assert.equal(result.errors.length, 0, 'unexpected refusal: ' + result.errors.join('; '))
  assert.equal(result.filesWritten.length, 1, 'the write must actually happen')
  assert.equal(fs.existsSync(path.join(nested, 'plain-ok.ts')), true)
})
