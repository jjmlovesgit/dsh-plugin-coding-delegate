#!/usr/bin/env node
/**
 * Sign and attach a delegation attestation for one unit, under attestation spec 1.1.
 *
 * WHY THIS EXISTS AS A SCRIPT. The signing flow was written by hand eight times during this project,
 * each time as a throwaway file that was deleted after one use. Every one of those retypings is a place
 * the flow can drift: a payload field left out, a verification block given the wrong shape, a path left
 * in Windows form, a digest taken over an unsorted array. The ledger verifier was institutionalised for
 * the same reason, and an ad-hoc signer is the same class of hazard as an ad-hoc audit.
 *
 * THE CONTRACT IS RUN HERE, NOT TRUSTED. An earlier draft of this script accepted a placeholder
 * `output: 'verified'`, which would have made the envelope's `stdoutHash` a digest of a literal string
 * rather than of anything the contract printed -- a record that looks like evidence and is not. This
 * version executes the contract, records its REAL exit code, failure count and output hash, and refuses
 * to sign at all when the contract does not pass.
 *
 * THE ARTIFACT MUST BE IN THE COMMIT IT ANCHORS TO. A record that names a hash the anchored tree does
 * not contain cannot be reproduced by checking that commit out, which is the one thing the record is
 * for. A modified or untracked artifact is refused rather than signed. `--allow-dirty` overrides it,
 * for the case where a record is genuinely wanted before the commit exists.
 *
 * USAGE
 *   node scripts/attest-unit.cjs <artifact> <contract> [options]
 *
 *   --model <id>        model identifier to record       (default: qwen/qwen3.8-27b)
 *   --commit <sha>      commit to anchor the note to     (default: HEAD)
 *   --artifact <path>   record an additional artifact    (repeatable)
 *   --contract <path>   add an additional contract       (repeatable; all are digested together)
 *   --allow-dirty       sign even when an artifact or contract differs from the anchored commit
 *   --dry-run           run the whole flow, print the payload summary, attach NOTHING
 *
 * `contractHash` is taken over the whole contract set, normalised to POSIX separators and sorted, by
 * buildAttestationPlan itself -- this script does not re-implement any of it. The payload records the
 * set, so a reader recomputes the digest from the document rather than guessing a path convention.
 *
 * THE OPERATOR KEY IS PINNED BY FINGERPRINT, before anything is signed. The local key is cross-checked
 * against `keys/delegation-operator.pub`, and both are checked against the trust-root digest that
 * `scripts/operator-key.cjs` defines and the ledger audit enforces. Agreement between two files is not
 * enough on its own: a writer can change both together, and a signature is the irreversible step here.
 *
 * Requires the operator private key locally; no secret is ever written to the repository.
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync, spawnSync } = require('node:child_process')

const {
  buildAttestationPlan,
  signManifest,
  publicKeyFromPrivate,
  verifyEnvelope,
  hashBuffer,
} = require('../plugin/dist/crypto-attestation.js')
const { buildNotesCommand } = require('../plugin/dist/attestation-notes.js')
const { canonicalizeJson } = require('../plugin/dist/canonical-json.js')

const REPO_ROOT = path.resolve(__dirname, '..')
const NOTES_REF = 'refs/notes/delegations'
const PRIVATE_KEY_PATH = path.join(os.homedir(), '.dsh', 'keys', 'delegation_ed25519.pem')
const REPO_PUBLIC_KEY_PATH = path.join(REPO_ROOT, 'keys', 'delegation-operator.pub')

/**
 * The trust root and its PEM normalisation come from ONE module shared with the ledger audit.
 *
 * The signer needs the same pin the auditor enforces, and it must be the SAME DEFINITION rather than a
 * second copy of a 64-character digest. A duplicated constant rots silently in both directions, and the
 * direction that matters here is the one that wastes the work: a signer holding a digest the auditor does
 * not recognise produces a note that passes every check the signer can make locally and is then REJECTED
 * at audit time, after the unit is built and the note is on the ref.
 *
 * CLEANING THE PEM KEEPS THE RECORD CANONICAL TOO. `derivedPublicKey` is embedded in the envelope, so
 * normalising it is what stops the line endings of the signing machine from leaking into the ledger and
 * making a sound record look unattributed to an auditor on a different platform.
 */
const {
  TRUSTED_OPERATOR_PUBKEY_SHA256,
  cleanKey,
  keyFingerprint,
  spkiFingerprint,
} = require('./operator-key.cjs')

function fatal(message) {
  console.error('ATTEST FATAL  ' + message)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

const argv = process.argv.slice(2)
const positionals = []
const extraContracts = []
const extraArtifacts = []
let modelIdentifier = 'qwen/qwen3.8-27b'
let commitArg = null
let allowDirty = false
let dryRun = false

for (let i = 0; i < argv.length; i += 1) {
  const token = argv[i]
  const value = () => {
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) fatal(token + ' needs a value')
    i += 1
    return next
  }
  if (token === '--model') modelIdentifier = value()
  else if (token === '--commit') commitArg = value()
  else if (token === '--artifact') extraArtifacts.push(value())
  else if (token === '--contract') extraContracts.push(value())
  else if (token === '--allow-dirty') allowDirty = true
  else if (token === '--dry-run') dryRun = true
  else if (token.startsWith('--')) fatal('unknown option ' + token)
  else positionals.push(token)
}

if (positionals.length < 2) {
  fatal('usage: node scripts/attest-unit.cjs <artifact> <contract> [--model <id>] [--commit <sha>] [--artifact <p>] [--contract <p>] [--allow-dirty]')
}

const artifactArgs = [positionals[0], ...extraArtifacts]
const contractArgs = [positionals[1], ...extraContracts]

// ---------------------------------------------------------------------------
// Path resolution, with containment
// ---------------------------------------------------------------------------

/** Resolve a repository-relative path, refusing anything that escapes the repository. */
function resolveInside(input, label) {
  const absolute = path.resolve(REPO_ROOT, input)
  if (absolute !== REPO_ROOT && !absolute.startsWith(REPO_ROOT + path.sep)) {
    fatal(label + ' resolves outside the repository, so it cannot be attested: ' + absolute)
  }
  const relative = path.relative(REPO_ROOT, absolute).split(path.sep).join('/')
  return { absolute, relative }
}

const artifacts = artifactArgs.map((arg) => resolveInside(arg, 'artifact'))
const contracts = contractArgs.map((arg) => resolveInside(arg, 'contract'))

for (const file of [...artifacts, ...contracts]) {
  if (!fs.existsSync(file.absolute)) fatal('missing on disk: ' + file.relative)
}
for (const file of artifacts) {
  if (contracts.some((c) => c.relative === file.relative)) {
    fatal(file.relative + ' is listed as both an artifact and a contract')
  }
}

/**
 * Every contract must be covered by the discrimination gate, checked HERE because signing is the
 * irreversible step.
 *
 * WHY THIS IS A SIGNER RULE AND NOT ONLY A GATE RULE. `scripts/check-contract-fixtures.cjs` discovers
 * contracts by scanning `tests/contracts`, so a contract anywhere else is never run against a negative
 * fixture -- and a contract that has never been shown to fail a plausible wrong implementation makes
 * `"passed": true` mean "this file ran", not "this property holds". Measured: `tests/currency.contract.cjs`
 * was the only contract in the repository outside that directory, and it was covered by nothing, which
 * the ledger audit could not see because a record carries a contract hash and not a fixture verdict.
 * The audit now checks coverage too; this refuses to create the record in the first place, so the failure
 * arrives before the note is on the ref rather than afterwards, when the only remedy left is rewriting
 * published history.
 *
 * The check is on the PATH as well as the fixture, because a fixture only counts when the gate can pair
 * it with a contract under that directory -- `tests/contracts/fixtures/<name>.negative.ts` beside
 * `tests/contracts/<name>.contract.cjs` is the pairing the gate performs, and a fixture anywhere else is
 * dead weight that looks like coverage.
 */
function requireContractCoverage(contractFiles) {
  for (const contract of contractFiles) {
    const directory = path.posix.dirname(contract.relative)
    const fileName = path.posix.basename(contract.relative)
    const base = fileName.replace(/\.contract\.cjs$/, '')
    if (directory !== 'tests/contracts' || !fileName.endsWith('.contract.cjs')) {
      fatal(
        'the contract ' + contract.relative + ' is not one the discrimination gate discovers, which is ' +
          'only tests/contracts/<name>.contract.cjs. A contract outside that shape has therefore never ' +
          'been run against a negative fixture, so passing verification against it would mean only that ' +
          'it ran. Move it into that convention -- as tests/currency.contract.cjs was moved to ' +
          'tests/contracts/currency.contract.cjs, with its module at tools/currency.ts.'
      )
    }
    const fixtures = [
      path.join(REPO_ROOT, 'tests', 'contracts', 'fixtures', base + '.negative.ts'),
      path.join(REPO_ROOT, 'tests', 'contracts', 'fixtures', base + '.negative.cjs'),
    ]
    if (!fixtures.some((candidate) => fs.existsSync(candidate))) {
      fatal(
        'the contract ' + contract.relative + ' has no negative fixture at ' +
          'tests/contracts/fixtures/' + base + '.negative.ts, so it has never been shown to fail a ' +
          'plausible wrong implementation. A contract that cannot fail one is not evidence; write the ' +
          'fixture first, and let scripts/check-contract-fixtures.cjs report that it discriminates.'
      )
    }
  }
}

requireContractCoverage(contracts)

// ---------------------------------------------------------------------------
// Operator key, cross-checked against the committed pin
// ---------------------------------------------------------------------------

if (!fs.existsSync(PRIVATE_KEY_PATH)) {
  fatal('no signing key at ' + PRIVATE_KEY_PATH)
}
const privateKeyPem = cleanKey(fs.readFileSync(PRIVATE_KEY_PATH, 'utf8'))
const derivedPublicKey = cleanKey(publicKeyFromPrivate(privateKeyPem))

if (fs.existsSync(REPO_PUBLIC_KEY_PATH)) {
  const pinnedRaw = fs.readFileSync(REPO_PUBLIC_KEY_PATH, 'utf8')
  const pinned = cleanKey(pinnedRaw)
  if (/\r/.test(pinnedRaw)) {
    console.warn('  warn  keys/delegation-operator.pub contained CR line endings; normalised to LF before comparison')
  }
  if (pinned !== derivedPublicKey) {
    fatal(
      'the signing key does not correspond to keys/delegation-operator.pub. Signing with it would ' +
        'produce a record the committed pin cannot attribute -- the ledger audit would report it as ' +
        'forged, and correctly so.'
    )
  }
}

// THE PIN, TOO, AND BEFORE ANYTHING IS SIGNED. The check above is an agreement between two files a
// writer can change together; this one is against the constant that defines trust, so it holds even when
// the local key directory and the committed pin have been altered in step. Signing is the irreversible
// step in this script -- it puts a record on refs/notes/delegations -- so the refusal has to land here
// rather than being discovered by the audit afterwards, when the only remaining remedy is to rewrite
// published history.
const signingFingerprint = keyFingerprint(derivedPublicKey)
if (signingFingerprint !== TRUSTED_OPERATOR_PUBKEY_SHA256) {
  fatal(
    'the signing key does not match the pinned operator fingerprint.\n' +
      '  pinned fingerprint : ' + TRUSTED_OPERATOR_PUBKEY_SHA256 + '\n' +
      '  signing fingerprint: ' + signingFingerprint + '\n' +
      '  spki sha256        : ' + spkiFingerprint(derivedPublicKey) + '\n' +
      '  This is the same pin scripts/verify-delegation-ledger.cjs enforces, so signing now would attach\n' +
      '  a note the audit rejects. If the two fingerprints differ ONLY because the PEM was reformatted,\n' +
      '  restore the committed formatting. If this is a deliberate rotation, change\n' +
      '  TRUSTED_OPERATOR_PUBKEY_SHA256 in scripts/operator-key.cjs in the same commit that changes the\n' +
      '  key, and sign a note for that commit so the rotation is itself an attested record.'
  )
}

// ---------------------------------------------------------------------------
// The anchor commit, and whether the inputs are actually in it
// ---------------------------------------------------------------------------

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
}

let baseCommit = commitArg
if (baseCommit) {
  try {
    baseCommit = String(git(['rev-parse', '--verify', commitArg + '^{commit}'])).trim()
  } catch {
    fatal('--commit ' + commitArg + ' does not resolve to a commit')
  }
} else {
  baseCommit = String(git(['rev-parse', 'HEAD'])).trim()
}

const dirty = []
for (const file of [...artifacts, ...contracts]) {
  let tracked = ''
  try {
    tracked = String(git(['ls-tree', '-r', '--name-only', baseCommit, '--', file.relative])).trim()
  } catch {
    tracked = ''
  }
  if (!tracked) {
    dirty.push(file.relative + ' (not present in ' + baseCommit.slice(0, 8) + ')')
    continue
  }
  const diff = spawnSync('git', ['diff', '--quiet', baseCommit, '--', file.relative], { cwd: REPO_ROOT })
  if (diff.status !== 0) dirty.push(file.relative + ' (modified since ' + baseCommit.slice(0, 8) + ')')
}

if (dirty.length > 0) {
  const message =
    'these inputs are not what the anchored commit contains, so the record would not be reproducible ' +
    'by checking that commit out:\n  - ' +
    dirty.join('\n  - ')
  if (!allowDirty) fatal(message + '\nRe-run with --allow-dirty to sign anyway.')
  console.warn('ATTEST WARN  ' + message + '\n  signing anyway because --allow-dirty was given')
}

// ---------------------------------------------------------------------------
// Run the contract. Its real result is what gets recorded.
// ---------------------------------------------------------------------------

const command = 'node ' + contracts.map((c) => c.relative).join(' ')
const runs = contracts.map((contract) => {
  const result = spawnSync(process.execPath, [contract.absolute], { cwd: REPO_ROOT, encoding: 'utf8' })
  return {
    relative: contract.relative,
    status: typeof result.status === 'number' ? result.status : -1,
    output: String(result.stdout || '') + String(result.stderr || ''),
  }
})

const combinedOutput = runs.map((r) => '# ' + r.relative + '\n' + r.output).join('\n')
const exitCode = runs.reduce((worst, r) => (r.status !== 0 ? r.status : worst), 0)
const failureLines = runs
  .map((r) => /^# fail (\d+)\s*$/m.exec(r.output))
  .filter(Boolean)
  .map((m) => Number(m[1]))
const failed = failureLines.length > 0 ? failureLines.reduce((a, b) => a + b, 0) : exitCode === 0 ? 0 : 1

for (const run of runs) {
  console.log((run.status === 0 ? '  ok    ' : '  FAIL  ') + run.relative + '  (exit ' + run.status + ')')
}
if (exitCode !== 0) {
  fatal(
    'the contract did not pass (exit ' + exitCode + '). Nothing was signed: a signature over a unit ' +
      'whose own contract rejects it would launder a failure into an operator statement.'
  )
}

// ---------------------------------------------------------------------------
// Build, sign, verify, attach
// ---------------------------------------------------------------------------

const plan = buildAttestationPlan({
  // Required, and its absence is not a benign default: without it buildAttestationPlan returns
  // `{ action: 'none' }` and there is no payload to sign at all.
  privateKeyPath: PRIVATE_KEY_PATH,
  privateKeyReadable: true,
  runId: 'run-' + Date.now(),
  baseCommit,
  modelIdentifier,
  status: 'SUCCESS',
  contracts: contracts.map((c) => ({ path: c.relative, sha256: hashBuffer(fs.readFileSync(c.absolute)) })),
  artifacts: artifacts.map((a) => ({ path: a.relative, sha256: hashBuffer(fs.readFileSync(a.absolute)) })),
  verification: {
    command,
    executed: true,
    exitCode,
    // The REDACTED output, by the module's own convention. This is what `stdoutHash` digests -- a
    // placeholder string here would make the digest evidence of nothing.
    output: combinedOutput,
    // A NUMBER. `passed` is derived as `failed === 0`, so a boolean `false` would record a passing
    // unit as failed, because `false === 0` is false.
    failed,
  },
})

if (plan.action !== 'sign') {
  fatal('buildAttestationPlan refused to sign: ' + plan.reason)
}

const envelope = signManifest(plan.payload, privateKeyPem, derivedPublicKey)
if (!verifyEnvelope(envelope)) {
  fatal('the envelope did not verify against its own public key, so nothing was attached')
}

// The repository's own command builder, executed WITHOUT a shell. It validates the notes ref and the
// object name, and it hands the body as an argument rather than through a temp file or a shell string.
const notesCommand = buildNotesCommand({ commit: baseCommit, notesRef: NOTES_REF, body: canonicalizeJson(envelope) })
if (!notesCommand.ok) fatal('refused to build the notes command: ' + notesCommand.reason)

if (dryRun) {
  console.log('ATTEST DRY RUN  nothing was attached to ' + NOTES_REF)
} else {
  try {
    execFileSync('git', notesCommand.args, { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (err) {
    const detail = String((err && err.stderr) || (err && err.message) || err).trim().split('\n')[0]
    fatal('could not attach the note: ' + detail)
  }
}

console.log('')
console.log('specVersion        : ' + plan.payload.specVersion)
console.log('baseCommit         : ' + plan.payload.baseCommit)
console.log('modelIdentifier    : ' + plan.payload.modelIdentifier)
console.log('artifacts          : ' + plan.payload.artifacts.map((a) => a.path).join(', '))
console.log('recorded contracts : ' + plan.payload.contracts.map((c) => c.path).join(', '))
console.log('contractHash       : ' + plan.payload.contractHash)
console.log('verification       : exit ' + exitCode + ', failed ' + failed + ', passed ' + plan.payload.verification.passed)
console.log('self-consistent    : ' + (hashBuffer(canonicalizeJson(plan.payload.contracts)) === plan.payload.contractHash))
console.log('')
console.log(
  dryRun
    ? 'ATTEST PASS (dry run)  payload built and signed; nothing was attached'
    : 'ATTEST PASS  note signed and attached to ' + baseCommit
)
