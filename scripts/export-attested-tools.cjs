#!/usr/bin/env node
/**
 * Build a self-verifying, air-gapped bundle of the Tier 1 primitives (Option C.3).
 *
 * WHY A BUNDLE AND NOT AN IMPORT PATH. Two consumers need the primitives and neither can reach them
 * through the package graph. DSH loads the plugin as an MCP stdio package, which by design contains
 * no `tools/`; Laya runs air-gapped, where a relative import into someone else's checkout is not a
 * dependency, it is a copy. So the honest distribution unit is bytes plus receipts, and the bundle is
 * that unit: source, contract, mutant, the signed note that covers each one, and a verifier that
 * needs no network, no git and no npm.
 *
 * THE BUNDLE IS BUILT FROM HEAD, NOT FROM DISK. Reading the working tree would make the artefact
 * depend on uncommitted state, and would make generating the bundle dirty the tree that the next
 * generation then has to tolerate. Every byte here comes out of `git cat-file blob HEAD:<path>`, so
 * the bundle is exactly the committed tree the notes attest, and the manifest records the commit.
 *
 * EVERY ENTRY IS RESOLVED BY DIGEST, NOT BY NAME. The covering note is the one whose payload lists
 * this path with this SHA-256; a note for an older version of the file is not a covering note, and a
 * primitive with none is a hard failure rather than an omission. Each envelope is verified before it
 * is written, so the bundle never ships a signature the generator could not check itself.
 *
 * Usage: node scripts/export-attested-tools.cjs [--out <dir>] [--tar]
 */
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { loadPolicyConfig } = require('./policy-config.cjs')
const { verifyEnvelope } = require('../plugin/dist/crypto-attestation.js')

const REPO_ROOT = path.resolve(__dirname, '..')
const { config } = loadPolicyConfig(REPO_ROOT)
const TIER1 = new RegExp(config.tiers.corePrimitives.contractGoverned)
const OPERATOR_KEY = 'keys/delegation-operator.pub'
const REVIEWER_KEY = 'keys/delegation-reviewer.pub'

/** The verifier shipped inside the bundle. Zero dependencies: node builtins only. */
const VERIFIER_SOURCE = `#!/usr/bin/env node
'use strict'
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

const here = (p) => path.join(__dirname, p)
const cleanKey = (pem) => String(pem).replace(/\\r\\n?/g, '\\n').trim()
const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')
const keyFingerprint = (pem) => crypto.createHash('sha256').update(cleanKey(pem), 'utf8').digest('hex')

// RFC 8785 canonicalization, PORTED from plugin/src/canonical-json.ts. It must be a port rather
// than a reimplementation: the reviewer signature covers these exact bytes, and any divergence in
// key ordering, number formatting or string escaping rejects every historical note. The seventeen
// notes in the ledger are the fixture set that proves the port.
function canonicalizeJson(value) {
  const out = []
  writeValue(value, out)
  return out.join('')
}

function writeValue(value, out) {
  if (value === null) { out.push('null'); return }
  const type = typeof value
  if (type === 'boolean') { out.push(value ? 'true' : 'false'); return }
  if (type === 'number') { out.push(writeNumber(value)); return }
  if (type === 'string') { out.push(quoteString(value)); return }
  if (type === 'object') { Array.isArray(value) ? writeArray(value, out) : writeObject(value, out); return }
  throw new Error(type + ' has no JSON representation')
}

function writeNumber(value) {
  if (!Number.isFinite(value)) throw new Error(String(value) + ' is not representable in JSON')
  return String(value)
}

function compareCodeUnits(a, b) { return a < b ? -1 : a > b ? 1 : 0 }

function writeObject(value, out) {
  const keys = Object.keys(value).sort(compareCodeUnits)
  out.push('{')
  let first = true
  for (const key of keys) {
    const member = value[key]
    if (member === undefined || typeof member === 'function' || typeof member === 'symbol') continue
    if (!first) out.push(',')
    first = false
    out.push(quoteString(key), ':')
    writeValue(member, out)
  }
  out.push('}')
}

function writeArray(value, out) {
  out.push('[')
  for (let i = 0; i < value.length; i++) {
    if (i > 0) out.push(',')
    const element = value[i]
    if (element === undefined || typeof element === 'function' || typeof element === 'symbol') {
      throw new Error('array element ' + i + ' has no JSON representation')
    }
    writeValue(element, out)
  }
  out.push(']')
}

function quoteString(value) {
  assertNoLoneSurrogate(value)
  return JSON.stringify(value)
}

function assertNoLoneSurrogate(value) {
  for (let i = 0; i < value.length; i++) {
    const unit = value.charCodeAt(i)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = i + 1 < value.length ? value.charCodeAt(i + 1) : -1
      if (next < 0xdc00 || next > 0xdfff) throw new Error('lone high surrogate at ' + i)
      i += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new Error('lone low surrogate at ' + i)
    }
  }
}

function fail(message) {
  console.error('  FAIL  ' + message)
  return false
}

/**
 * The reviewer's own signature: canonical payload with the reviewer.signature field removed, verified
 * the reviewer key. A note that predates spec 1.2 has no reviewer block, and there is nothing to check.
 *
 * THIS IS WHAT THE OPERATOR ENVELOPE CANNOT PROVE. The envelope authenticates the payload that
 * CONTAINS the reviewer block, so a forged reviewer is caught only if the operator key is honest.
 * The reviewer's separate signature is the check that survives a compromised operator key, which is
 * why the bundle carries the reviewer public key rather than trusting the identity string.
 */
function verifyReviewer(entry, payload, reviewerPem) {
  const reviewer = payload.reviewer
  if (!reviewer || typeof reviewer !== 'object') return true
  if (!reviewerPem) return fail(entry.name + ': the note carries a reviewer block but the bundle has no reviewer key')
  let ok = true
  if (typeof reviewer.keyFingerprint !== 'string' || keyFingerprint(reviewerPem).slice(0, 8) !== reviewer.keyFingerprint) {
    ok = fail(entry.name + ': reviewer keyFingerprint does not match the bundled reviewer key')
  }
  const unsigned = JSON.parse(JSON.stringify(payload))
  delete unsigned.reviewer.signature
  let valid = false
  try {
    valid = crypto.verify(
      null,
      Buffer.from(canonicalizeJson(unsigned), 'utf8'),
      reviewerPem,
      Buffer.from(String(reviewer.signature || ''), 'base64')
    )
  } catch (error) {
    valid = false
  }
  if (!valid) ok = fail(entry.name + ': reviewer signature does not verify over the canonical payload')
  return ok
}

function verifyEntry(entry, pinnedPem, reviewerPem) {
  let ok = true
  const primitive = fs.readFileSync(here(entry.primitiveFile))
  const contract = fs.readFileSync(here(entry.contractFile))
  const mutant = fs.readFileSync(here(entry.mutantFile))

  if (sha256(primitive) !== entry.primitiveSha256) ok = fail(entry.name + ': primitive digest mismatch')
  if (sha256(contract) !== entry.contractSha256) ok = fail(entry.name + ': contract digest mismatch')
  if (sha256(mutant) !== entry.mutantSha256) ok = fail(entry.name + ': mutant digest mismatch')

  const envelope = JSON.parse(fs.readFileSync(here(entry.noteFile), 'utf8'))
  if (typeof envelope.payload !== 'string' || typeof envelope.signature !== 'string') {
    return fail(entry.name + ': note envelope is not a signed payload')
  }
  if (cleanKey(envelope.publicKeyPem) !== cleanKey(pinnedPem)) {
    ok = fail(entry.name + ': the note is signed by a key that is not the pinned operator key')
  }

  let signatureOk = false
  try {
    signatureOk = crypto.verify(null, Buffer.from(envelope.payload, 'utf8'), pinnedPem, Buffer.from(envelope.signature, 'base64'))
  } catch (error) {
    signatureOk = false
  }
  if (!signatureOk) ok = fail(entry.name + ': envelope signature does not verify')

  const payload = JSON.parse(envelope.payload)
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : []
  const recorded = artifacts.find((a) => a && a.path === entry.originalPath)
  if (!recorded) {
    ok = fail(entry.name + ': the note records no artifact for ' + entry.originalPath)
  } else if (recorded.sha256 !== entry.primitiveSha256) {
    ok = fail(entry.name + ': the note records a different digest than the bundled bytes')
  }

  if (!verifyReviewer(entry, payload, reviewerPem)) ok = false

  if (ok) {
    const reviewer = entry.reviewerIdentity ? ' [' + entry.reviewerIdentity + ']' : ' [no reviewer block]'
    console.log('  ok    ' + entry.name + ' <- ' + String(entry.anchorCommit).slice(0, 7) + reviewer)
  }
  return ok
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(here('manifest.json'), 'utf8'))
  const pinnedPem = fs.readFileSync(here(manifest.operatorPublicKeyPath), 'utf8')
  const reviewerPem = manifest.reviewerPublicKeyPath && fs.existsSync(here(manifest.reviewerPublicKeyPath))
    ? fs.readFileSync(here(manifest.reviewerPublicKeyPath), 'utf8')
    : null
  console.log('=== attested tools bundle: ' + manifest.primitives.length + ' primitive(s) from ' + String(manifest.generatedFromCommit).slice(0, 7) + ' ===')
  console.log('    operator key: ' + manifest.operatorPublicKeyPath + ' (fingerprint ' + keyFingerprint(pinnedPem).slice(0, 12) + ')')
  console.log('    reviewer key: ' + (manifest.reviewerPublicKeyPath || '(none bundled)'))

  let failed = 0
  for (const entry of manifest.primitives) {
    if (!verifyEntry(entry, pinnedPem, reviewerPem)) failed += 1
  }

  if (failed > 0) {
    console.error('')
    console.error(failed + ' of ' + manifest.primitives.length + ' primitive(s) failed verification.')
    process.exit(1)
  }
  console.log('')
  console.log('All ' + manifest.primitives.length + ' primitive(s) match their recorded digests and are covered by a signed note.')
}

main()
`

function fail(code, message) {
  console.error('FATAL [' + code + ']: ' + message)
  process.exit(1)
}

function git(args, encoding) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding, maxBuffer: 128 * 1024 * 1024 })
  if (result.error || result.status !== 0) fail('GIT', 'git ' + args.join(' ') + ' failed: ' + String(result.stderr || ''))
  return result.stdout
}

const gitText = (args) => git(args, 'utf8')
const gitBytes = (args) => git(args, undefined)
const hash = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

function parseArgs(argv) {
  const params = { out: path.join(os.tmpdir(), 'attested-tools'), tar: false }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--out') {
      const value = argv[i + 1]
      if (!value) fail('ARGS', '--out needs a path')
      params.out = path.resolve(REPO_ROOT, value)
      i += 1
    } else if (argv[i] === '--tar') {
      params.tar = true
    } else {
      fail('ARGS', 'unknown argument ' + argv[i])
    }
  }
  return params
}

function write(root, relative, data) {
  const target = path.join(root, relative)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, data)
  return target
}

function tier1Files() {
  return gitText(['ls-tree', '-r', '--name-only', 'HEAD'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => TIER1.test(file))
    .sort()
}

function readNotes() {
  const listing = gitText(['notes', '--ref', config.ledgerRef, 'list'])
  const notes = []
  for (const line of listing.split('\n').filter(Boolean)) {
    const commit = line.trim().split(/\s+/)[1]
    try {
      const envelope = JSON.parse(gitText(['notes', '--ref', config.ledgerRef, 'show', commit]))
      notes.push({ commit, envelope, payload: JSON.parse(envelope.payload) })
    } catch {
      /* the audit reports a note it cannot parse; the bundle must not count it as coverage */
    }
  }
  return notes
}

function coverFor(notes, file, sha256) {
  return notes.find(
    (note) =>
      Array.isArray(note.payload.artifacts) &&
      note.payload.artifacts.some((artifact) => artifact && artifact.path === file && artifact.sha256 === sha256)
  )
}

function exportOne(file, notes, out) {
  const name = path.basename(file, '.ts')
  const primitive = gitBytes(['cat-file', 'blob', 'HEAD:' + file])
  const sha256 = hash(primitive)
  const note = coverFor(notes, file, sha256)
  if (!note) fail('UNCOVERED', file + ' has no note recording sha256 ' + sha256.slice(0, 12))
  if (!verifyEnvelope(note.envelope)) fail('BAD_SIGNATURE', 'the covering note for ' + file + ' does not verify')

  const contract = gitBytes(['cat-file', 'blob', 'HEAD:tests/contracts/' + name + '.contract.cjs'])
  const mutant = gitBytes(['cat-file', 'blob', 'HEAD:tests/contracts/fixtures/' + name + '.negative.ts'])
  write(out, 'primitives/' + name + '.ts', primitive)
  write(out, 'contracts/' + name + '.contract.cjs', contract)
  write(out, 'mutants/' + name + '.negative.ts', mutant)
  write(out, 'notes/' + name + '.note.json', JSON.stringify(note.envelope, null, 2) + '\n')

  return {
    name,
    originalPath: file,
    primitiveFile: 'primitives/' + name + '.ts',
    primitiveSha256: sha256,
    contractFile: 'contracts/' + name + '.contract.cjs',
    contractSha256: hash(contract),
    mutantFile: 'mutants/' + name + '.negative.ts',
    mutantSha256: hash(mutant),
    noteFile: 'notes/' + name + '.note.json',
    anchorCommit: note.commit,
    workerModel: (note.payload.worker && note.payload.worker.model) || null,
    reviewerIdentity: (note.payload.reviewer && note.payload.reviewer.identity) || null,
  }
}

/**
 * Why a banner is not GNU tar, or null when it is.
 *
 * Kept as a pure predicate rather than inline in the archive step so the refusal can be tested on a
 * host that HAS GNU tar: the branch that matters is the one this machine never takes. bsdtar has
 * `--mtime` but no `--sort=name` or `--owner`, so it silently produces a different archive for the
 * same tree -- which is the exact property the reproducibility claim rests on.
 */
function gnuTarBannerProblem(banner) {
  const text = String(banner || '')
  if (/GNU tar/i.test(text)) return null
  const firstLine = text.split('\n')[0].trim()
  return (
    'deterministic archives require GNU tar (--sort=name, --mtime, --owner); this host reports "' +
    (firstLine || 'no version banner') +
    '", which cannot be relied on for a reproducible digest'
  )
}

/** Refuse to build an archive the reproducibility claim does not cover. */
function assertGnuTar() {
  const version = spawnSync('tar', ['--version'], { encoding: 'utf8' })
  if (version.error || version.status !== 0) {
    fail('TAR', 'cannot invoke tar to check its implementation: ' + String(version.error || version.status))
  }
  const problem = gnuTarBannerProblem(String(version.stdout || '') + String(version.stderr || ''))
  if (problem) fail('TAR', problem)
}

function makeTarball(out, commitDate) {
  // Run tar from the parent directory with RELATIVE names. Passing an absolute Windows path to -f
  // makes tar read `C:` as a remote host spec and fail with "Child returned status 128" -- measured.
  //
  // The flags are what make the ARCHIVE BYTES reproducible, not just its contents: sorted entries,
  // the commit's own timestamp instead of the wall clock, and no host uid/gid/user names. Two
  // exports of the same commit then produce the same .tar.gz digest on any machine running GNU tar.
  const parent = path.dirname(out)
  const base = path.basename(out)
  const archiveName = base + '.tar.gz'
  assertGnuTar()
  const args = [
    '--sort=name',
    '--mtime=' + commitDate,
    '--owner=0',
    '--group=0',
    '--numeric-owner',
    '-czf',
    archiveName,
    base,
  ]
  const result = spawnSync('tar', args, { cwd: parent, encoding: 'utf8' })
  if (result.error || result.status !== 0) fail('TAR', 'tar failed: ' + String(result.stderr || result.error))
  console.log('  tar   ' + path.join(parent, archiveName))
}

function main() {
  const params = parseArgs(process.argv.slice(2))
  const commit = gitText(['rev-parse', 'HEAD']).trim()
  // The COMMIT's date, not the wall clock: a manifest timestamp is part of what a consumer hashes,
  // and `new Date().toISOString()` made two exports of the same commit differ forever.
  const commitDate = gitText(['log', '-1', '--format=%cI', 'HEAD']).trim()
  const notes = readNotes()
  const files = tier1Files()

  if (fs.existsSync(params.out)) fs.rmSync(params.out, { recursive: true, force: true })
  fs.mkdirSync(params.out, { recursive: true })

  console.log('=== attested tools bundle: ' + files.length + ' primitive(s) from ' + commit.slice(0, 7) + ' ===')
  const primitives = files.map((file) => exportOne(file, notes, params.out))
  for (const entry of primitives) console.log('  ok    ' + entry.originalPath + ' <- ' + entry.anchorCommit.slice(0, 7))

  write(params.out, OPERATOR_KEY, gitBytes(['cat-file', 'blob', 'HEAD:' + OPERATOR_KEY]))
  if (fs.existsSync(path.join(REPO_ROOT, REVIEWER_KEY))) {
    write(params.out, REVIEWER_KEY, gitBytes(['cat-file', 'blob', 'HEAD:' + REVIEWER_KEY]))
  }

  const manifest = {
    schemaVersion: 1,
    generatedFromCommit: commit,
    commitDate,
    ledgerRef: config.ledgerRef,
    operatorPublicKeyPath: OPERATOR_KEY,
    reviewerPublicKeyPath: fs.existsSync(path.join(params.out, REVIEWER_KEY)) ? REVIEWER_KEY : null,
    note: 'Verification reads only this directory: node verify-bundle.cjs',
    primitives,
  }
  write(params.out, 'manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  write(params.out, 'verify-bundle.cjs', VERIFIER_SOURCE)

  if (params.tar) makeTarball(params.out, commitDate)
  console.log('  done  ' + params.out)
}

if (require.main === module) main()

// The tar guard is exported so its refusal branch can be exercised on a host that HAS GNU tar --
// the branch that matters is the one this machine never takes.
module.exports = { gnuTarBannerProblem }
