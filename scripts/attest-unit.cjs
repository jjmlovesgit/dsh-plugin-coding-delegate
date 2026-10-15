#!/usr/bin/env node
/**
 * Sign and attach a delegation attestation for one unit, under attestation spec 1.1, or stage one for
 * review under spec 1.2 through the two-phase `--prepare` / `--approve` flow.
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
 *   node scripts/attest-unit.cjs --prepare <artifact> <contract> [options]
 *   node scripts/attest-unit.cjs --approve <artifact> --reviewer-identity "<name>" [--dry-run]
 *
 *   --model <id>        model identifier to record       (default: qwen/qwen3.8-27b)
 *   --commit <sha>      commit to anchor the note to     (default: HEAD)
 *   --artifact <path>   record an additional artifact    (repeatable)
 *   --contract <path>   add an additional contract       (repeatable; all are digested together)
 *   --allow-dirty       sign even when an artifact or contract differs from the anchored commit
 *   --dry-run           run the whole flow, print the payload summary, attach NOTHING
 *   --prepare           spec 1.2 phase one: run everything, record the worker receipt, attach NOTHING
 *   --approve           spec 1.2 phase two: seal the staged draft with a reviewer signature and attach
 *   --reviewer-identity <name>   the human principal approving, for --approve only (mandatory there)
 *
 * WHY 1.2 IS TWO PHASES RATHER THAN ONE MORE FLAG. A dual attestation asserts that two independent
 * principals signed. If one process could produce both signatures in one invocation, the second signature
 * would be a property of the SCRIPT and not of a second human: the reviewer block would be filled in
 * automatically, and the record would claim a review that no person performed. Splitting the flow puts a
 * process boundary between the two signatures, and the operator-review boundary is then a real one --
 * `--prepare` cannot attach, and `--approve` cannot re-run the unit it is approving.
 *
 * WHAT `--approve` RE-CHECKS, AND WHY IT IS NOT PARANOIA. The draft sits on disk between the two phases,
 * which is a window in which the artifact, the contract or the anchored commit can change. An approval
 * that sealed the draft without re-reading the anchored tree would attest to a run that is no longer
 * reproducible from the commit the note names -- the exact failure `git cat-file`-backed checking exists
 * to catch, reintroduced through a temporary file. So `--approve` re-resolves every recorded digest
 * against `payload.baseCommit` and refuses when any of them has moved.
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

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { performance } = require('node:perf_hooks')
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
const REVIEWER_KEY_PATH = path.join(os.homedir(), '.dsh', 'keys', 'delegation-reviewer.pem')
const REPO_REVIEWER_PUBLIC_KEY_PATH = path.join(REPO_ROOT, 'keys', 'delegation-reviewer.pub')

/**
 * The staged draft lives OUTSIDE the working tree, under `.git`, for two reasons: it is never part of a
 * commit (so it cannot be mistaken for a reviewed input), and `git status` cannot report it as untracked
 * noise that a later hygiene check would have to learn to ignore.
 */
const PENDING_PATH = path.join(REPO_ROOT, '.git', 'dsh-attestation-pending.json')
const PENDING_SCHEMA = 'dsh-attestation-pending/1'

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
let mode = 'attach'
let reviewerIdentity = null

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
  else if (token === '--prepare') {
    if (mode === 'approve') fatal('--prepare and --approve are mutually exclusive')
    mode = 'prepare'
  } else if (token === '--approve') {
    if (mode === 'prepare') fatal('--prepare and --approve are mutually exclusive')
    mode = 'approve'
  } else if (token === '--reviewer-identity') reviewerIdentity = value()
  else if (token.startsWith('--')) fatal('unknown option ' + token)
  else positionals.push(token)
}

if (mode === 'approve') {
  if (positionals.length !== 1) {
    fatal(
      'usage: node scripts/attest-unit.cjs --approve <artifact> --reviewer-identity "<name>"\n' +
        '--approve takes exactly one positional, the unit whose staged draft is being approved.'
    )
  }
  if (!reviewerIdentity) {
    fatal(
      '--approve requires --reviewer-identity "<name>". A dual attestation records WHO reviewed the ' +
        'unit, and without a principal the reviewer block is a second signature by nobody -- which is ' +
        'the outcome two-phase signing exists to prevent.'
    )
  }
} else {
  if (reviewerIdentity !== null) {
    fatal('--reviewer-identity is only meaningful with --approve; neither --prepare nor the direct path records a reviewer')
  }
  if (positionals.length < 2) {
    fatal('usage: node scripts/attest-unit.cjs <artifact> <contract> [--model <id>] [--commit <sha>] [--artifact <p>] [--contract <p>] [--allow-dirty]')
  }
}

// ---------------------------------------------------------------------------
// Spec 1.2 phase two: approve a staged draft
// ---------------------------------------------------------------------------

/**
 * Sign one canonical payload the way the auditor verifies it.
 *
 * THE CONVENTION IS MIRRORED, NOT REINVENTED. scripts/verify-delegation-ledger.cjs verifies with
 * `crypto.verify(null, Buffer.from(canonicalizeJson(signingPayload), 'utf8'), pem, signature)` -- the
 * canonical BYTES, not a digest of them, because Ed25519 hashes the message internally (RFC 8032) and the
 * existing envelope scheme already signs the payload string. Signing anything else here would produce a
 * record that fails every 1.2 check silently and totally, so this is the exact inverse of the auditor's
 * expression rather than a second opinion about what "signed" means.
 */
function signCanonical(signingPayload, privatePem) {
  return crypto
    .sign(null, Buffer.from(canonicalizeJson(signingPayload), 'utf8'), privatePem)
    .toString('base64')
}

/** The digest of a blob in a commit's tree, or null when that commit does not hold it. */
function blobDigestAt(commit, repoRelativePath) {
  try {
    const buffer = execFileSync('git', ['cat-file', '-p', commit + ':' + repoRelativePath], {
      cwd: REPO_ROOT,
      maxBuffer: 32 * 1024 * 1024,
    })
    return hashBuffer(buffer)
  } catch {
    return null
  }
}

/**
 * The current tip of the delegation ledger, or null when the ref does not exist yet.
 *
 * `null` is a distinct answer from "a commit I could not read", and the callers report it as
 * "(uninitialised)" rather than as an empty string -- an uninitialised ledger and an unreadable one call
 * for different responses, and collapsing them would hide the second behind the first.
 */
function ledgerTip() {
  try {
    return String(git(['rev-parse', '--verify', NOTES_REF])).trim()
  } catch {
    return null
  }
}

/**
 * Approve the draft `--prepare` staged, under attestation spec 1.2.
 *
 * WHY THIS RE-READS THE ANCHORED TREE INSTEAD OF TRUSTING THE DRAFT. The draft is a file on disk, and the
 * window between the two phases is exactly when an artifact, a contract or the anchored commit can move.
 * Sealing it without re-resolving those digests would attest to a run that is no longer reproducible from
 * the commit the note names -- the failure `git cat-file`-backed verification exists to catch,
 * reintroduced through a temporary file. Every recorded digest is therefore re-derived from
 * `payload.baseCommit` before the reviewer signs anything.
 */
function runApproveFlow() {
  const target = resolveInside(positionals[0], 'target')

  if (!fs.existsSync(PENDING_PATH)) {
    fatal(
      'no staged draft at ' + PENDING_PATH + '. Run --prepare first: --approve seals what a separate ' +
        '--prepare run produced, and there is nothing here to seal.'
    )
  }

  let pending
  try {
    pending = JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8'))
  } catch (err) {
    fatal('the staged draft is not valid JSON: ' + ((err && err.message) || err))
  }

  if (pending.schema !== PENDING_SCHEMA) {
    fatal('the staged draft declares schema ' + JSON.stringify(pending.schema) + ', not ' + PENDING_SCHEMA)
  }
  if (pending.target !== target.relative) {
    fatal(
      'the staged draft is for ' + pending.target + ', not ' + target.relative + '. Approving a different ' +
        'unit than the one prepared would attach this review to work nobody inspected.'
    )
  }

  const payload = pending.payload
  if (!payload || typeof payload !== 'object') fatal('the staged draft carries no payload')
  if (payload.specVersion !== '1.2') {
    fatal('the staged draft declares specVersion ' + JSON.stringify(payload.specVersion) + ', not "1.2"')
  }
  if (!payload.worker || typeof payload.worker !== 'object') {
    fatal('the staged draft carries no worker block, so there is no run to review')
  }
  if (payload.reviewer !== undefined) {
    fatal('the staged draft already carries a reviewer block, so it was not produced by --prepare')
  }

  // `privateKeyPem`, `derivedPublicKey` and `signingFingerprint` come from the module-scope operator-key
  // check, which runs BEFORE this flow is invoked precisely so that --approve cannot seal a record with a
  // key the committed pin does not attribute. Re-deriving them here would be a second implementation of
  // the trust decision, which is the drift this repository removes wherever it finds it.
  const workerFingerprint = signingFingerprint.slice(0, 8)

  // THE WORKER RECEIPT IS RE-VERIFIED BEFORE IT IS REVIEWED. A reviewer who signs a draft whose own
  // receipt does not verify has attested to nothing. The signed payload is reconstructed to the shape it
  // had at --prepare time -- minus the reviewer block, minus the signature itself -- which is the same
  // shape the audit rebuilds, so agreement here means agreement there.
  const workerSigningPayload = Object.assign({}, payload)
  const workerInner = Object.assign({}, payload.worker)
  delete workerInner.signature
  workerSigningPayload.worker = workerInner
  let workerValid = false
  try {
    workerValid = crypto.verify(
      null,
      Buffer.from(canonicalizeJson(workerSigningPayload), 'utf8'),
      derivedPublicKey,
      Buffer.from(String(payload.worker.signature || ''), 'base64')
    )
  } catch {
    workerValid = false
  }
  if (!workerValid) {
    fatal(
      'the staged worker receipt does not verify against the pinned operator key, so this draft has been ' +
        'altered since --prepare and must not be approved.'
    )
  }

  // The reviewer key, cross-checked against the committed reviewer pin for the same reason the operator
  // key is checked against its own: --approve is the last point before an unattributable record lands.
  if (!fs.existsSync(REVIEWER_KEY_PATH)) fatal('no reviewer key at ' + REVIEWER_KEY_PATH)
  const reviewerKeyPem = cleanKey(fs.readFileSync(REVIEWER_KEY_PATH, 'utf8'))
  const reviewerPublicKey = cleanKey(publicKeyFromPrivate(reviewerKeyPem))
  const reviewerFingerprint = keyFingerprint(reviewerPublicKey)

  if (fs.existsSync(REPO_REVIEWER_PUBLIC_KEY_PATH)) {
    const repoReviewer = cleanKey(fs.readFileSync(REPO_REVIEWER_PUBLIC_KEY_PATH, 'utf8'))
    if (repoReviewer !== reviewerPublicKey) {
      fatal(
        'the reviewer key does not correspond to keys/delegation-reviewer.pub. The audit resolves the ' +
          'reviewer trust root from that file when nothing is supplied out of band, so a signature made ' +
          'with this key would be rejected against the key the repository publishes.'
      )
    }
  } else {
    console.warn('  warn  keys/delegation-reviewer.pub is absent, so the reviewer key is not cross-checked against a published pin')
  }

  const reviewerPrefix = reviewerFingerprint.slice(0, 8)

  // THE INDEPENDENCE CHECK AT THE SIGNER BOUNDARY. The audit refuses a payload whose two blocks name one
  // key; refusing here as well means that failure arrives before the note exists, rather than as a finding
  // against a record that is already on the ref.
  if (reviewerPrefix === workerFingerprint) {
    fatal(
      'self-approval refused: the reviewer key is the operator key (' + workerFingerprint + '), so this ' +
        'would be the worker approving its own output rather than a second principal signing it.'
    )
  }

  const recorded = [
    ...(Array.isArray(payload.artifacts) ? payload.artifacts : []),
    ...(Array.isArray(payload.contracts) ? payload.contracts : []),
  ]
  if (recorded.length === 0) fatal('the staged draft records no artifacts and no contracts')
  const moved = []
  for (const file of recorded) {
    const digest = blobDigestAt(payload.baseCommit, String(file.path))
    if (digest === null) {
      moved.push(String(file.path) + ' (not in ' + String(payload.baseCommit).slice(0, 8) + ')')
    } else if (digest !== file.sha256) {
      moved.push(String(file.path) + ' (tree=' + digest + ' draft=' + file.sha256 + ')')
    }
  }
  if (moved.length > 0) {
    fatal(
      'the anchored commit no longer holds what this draft recorded, so approving it would attest to a ' +
        'run that cannot be reproduced from ' + String(payload.baseCommit).slice(0, 8) + ':\n  - ' +
        moved.join('\n  - ') + '\nRe-run --prepare against the current inputs.'
    )
  }

  // ---- the reviewer block, then the seal ----
  const approvedPayload = JSON.parse(JSON.stringify(payload))
  approvedPayload.reviewer = {
    identity: reviewerIdentity,
    keyFingerprint: reviewerPrefix,
    timestamp: Date.now(),
  }
  approvedPayload.reviewer.signature = signCanonical(approvedPayload, reviewerKeyPem)

  const envelope = signManifest(approvedPayload, privateKeyPem, derivedPublicKey)
  if (!verifyEnvelope(envelope)) {
    fatal('the sealed envelope did not verify against its own public key, so nothing was attached')
  }

  const body = canonicalizeJson(envelope)
  const notesCommand = buildNotesCommand({ commit: payload.baseCommit, notesRef: NOTES_REF, body })
  if (!notesCommand.ok) fatal('refused to build the notes command: ' + notesCommand.reason)

  if (dryRun) {
    console.log('ATTEST DRY RUN  the draft was sealed but nothing was attached to ' + NOTES_REF)
  } else {
    const tipBefore = ledgerTip()
    try {
      execFileSync('git', notesCommand.args, { cwd: REPO_ROOT, stdio: ['ignore', 'ignore', 'pipe'] })
    } catch (err) {
      const detail = String((err && err.stderr) || (err && err.message) || err).trim().split('\n')[0]
      fatal('could not attach the note: ' + detail)
    }

    // READ BACK WHAT LANDED. `git notes add` exiting 0 says a note was written, not that it is the note we
    // signed. Both sides are trimmed because git terminates a note message with a newline, which is the
    // same normalisation the red-team harness uses when it reads a note back.
    let attached = null
    try {
      attached = execFileSync('git', ['notes', '--ref=' + NOTES_REF, 'show', payload.baseCommit], {
        cwd: REPO_ROOT,
        maxBuffer: 32 * 1024 * 1024,
      })
    } catch {
      attached = null
    }
    if (attached === null || String(attached).trim() !== body.trim()) {
      fatal(
        'the note now attached to ' + String(payload.baseCommit).slice(0, 8) + ' is not the record that ' +
          'was signed, so it has NOT been approved as reviewed. The draft was left in place: investigate ' +
          'before re-running. Ledger tip before this attempt: ' +
          (tipBefore === null ? '(uninitialised)' : tipBefore)
      )
    }

    // ONLY NOW, with the record attached and read back. Unlinking earlier would destroy the only copy of
    // an approval that did not land, and leaving it on failure is what keeps the failure recoverable.
    fs.unlinkSync(PENDING_PATH)
    console.log('  ok    note attached to ' + String(payload.baseCommit).slice(0, 8) + ' and read back byte-identical')
    console.log('  ok    staged draft removed')
  }

  console.log('')
  console.log('specVersion        : ' + approvedPayload.specVersion)
  console.log('baseCommit         : ' + approvedPayload.baseCommit)
  console.log('artifacts          : ' + approvedPayload.artifacts.map((a) => a.path).join(', '))
  console.log('recorded contracts : ' + approvedPayload.contracts.map((c) => c.path).join(', '))
  console.log('worker receipt     : key ' + workerFingerprint)
  console.log('reviewer           : ' + reviewerIdentity + ' (key ' + reviewerPrefix + ')')
  console.log('')
  console.log(
    dryRun
      ? 'APPROVE PASS (dry run)  dual attestation built and sealed; nothing was attached'
      : 'APPROVE PASS  dual attestation sealed by ' + reviewerIdentity + ' and attached'
  )
}

// Empty in approve mode: an approval re-checks the unit it staged rather than naming it again, so there
// are no positional paths to resolve and no contract to run a second time.
const artifactArgs = mode === 'approve' ? [] : [positionals[0], ...extraArtifacts]
const contractArgs = mode === 'approve' ? [] : [positionals[1], ...extraContracts]

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

if (mode === 'approve') {
  runApproveFlow()
  process.exit(0)
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

/**
 * Snapshotted BEFORE the contract runs, because a contract is executable code.
 *
 * The one thing a contract must not be able to do is move the ledger that is about to record it. Without
 * this, a contract could attach a note of its own mid-run and the signer would then attach a second one,
 * reporting success over a ref it never inspected -- the record would describe a run during which the
 * record was already being written. Measured here rather than assumed, since the signer cannot reason
 * about what arbitrary code did.
 */
const ledgerTipBeforeContract = ledgerTip()
const contractStartedAt = performance.now()
const runs = contracts.map((contract) => {
  const result = spawnSync(process.execPath, [contract.absolute], { cwd: REPO_ROOT, encoding: 'utf8' })
  return {
    relative: contract.relative,
    status: typeof result.status === 'number' ? result.status : -1,
    output: String(result.stdout || '') + String(result.stderr || ''),
  }
})
/**
 * The cost of RUNNING THE CONTRACT -- the delegated unit's verification -- not of the JSON assembly around
 * it. This is the number recorded as `worker.durationMs`, and timing the wrong span would record something
 * that reads like evidence of work performed while measuring nothing of the sort.
 */
const contractDurationMs = Math.round(performance.now() - contractStartedAt)

const ledgerTipAfterContract = ledgerTip()
if (ledgerTipAfterContract !== ledgerTipBeforeContract) {
  fatal(
    'the ledger moved while the contract ran: ' +
      (ledgerTipBeforeContract === null ? '(uninitialised)' : ledgerTipBeforeContract) + ' before, ' +
      (ledgerTipAfterContract === null ? '(uninitialised)' : ledgerTipAfterContract) + ' after. A contract ' +
      'is code, and code that writes to ' + NOTES_REF + ' while being attested is attesting to its own ' +
      'insertion. Nothing was signed.'
  )
}

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

// ---------------------------------------------------------------------------
// Spec 1.2 phase one: stage the draft. Nothing is attached from here.
// ---------------------------------------------------------------------------

if (mode === 'prepare') {
  const targetRelative = artifacts[0].relative

  /**
   * THE SPEC VERSION IS RAISED HERE, NOT IN THE PLUGIN'S CONSTANT, AND THAT IS DELIBERATE.
   *
   * `buildAttestationPlan` emits a 1.1-shaped payload with no worker or reviewer block. Bumping
   * ATTESTATION_SPEC_VERSION before the plan builder knows how to fill those blocks would make every
   * plan-built payload a self-described 1.2 record that fails its own audit -- the audit refuses a 1.2
   * payload that cannot show both blocks. The constant moves when the builder moves, and until then the
   * only producer of a 1.2 record is this flow.
   */
  const draftPayload = JSON.parse(JSON.stringify(plan.payload))
  draftPayload.specVersion = '1.2'
  draftPayload.worker = {
    model: modelIdentifier,
    // The digest of what the contract actually printed, taken here rather than read out of an internal
    // field, so the recorded digest is over bytes this script captured and can name.
    stdoutHash: hashBuffer(Buffer.from(combinedOutput, 'utf8')),
    durationMs: contractDurationMs,
    timestamp: Date.now(),
    // THE AUDIT REQUIRES THE EIGHT-CHARACTER PREFIX, not the full digest. Measurements: check 8 compares
    // this field to `TRUSTED_OPERATOR_PUBKEY_SHA256.slice(0, 8)`, and it also compares the two blocks'
    // fingerprints to each other to detect self-approval -- which only means anything while both fields
    // are the same LENGTH. Recording a full 64-character digest here would fail the record outright, and
    // mixing lengths across the two blocks would silently disarm the independence check.
    keyFingerprint: signingFingerprint.slice(0, 8),
  }

  /**
   * Signed over the record as it stands now: no reviewer block exists yet, and the signature is excluded
   * from its own payload. The audit rebuilds exactly this shape -- payload minus `reviewer`, minus
   * `worker.signature` -- which is what lets the worker receipt survive the reviewer signing afterwards
   * instead of being invalidated by it.
   */
  draftPayload.worker.signature = signCanonical(draftPayload, privateKeyPem)

  // Self-checked against the pinned key BEFORE a human is asked to review it. A draft whose own receipt
  // does not verify is one the reviewer could only reject, and finding that out at approval time wastes
  // the review rather than the signature.
  const receiptShape = JSON.parse(JSON.stringify(draftPayload))
  delete receiptShape.worker.signature
  const receiptValid = crypto.verify(
    null,
    Buffer.from(canonicalizeJson(receiptShape), 'utf8'),
    derivedPublicKey,
    Buffer.from(draftPayload.worker.signature, 'base64')
  )
  if (!receiptValid) {
    fatal('the worker receipt did not verify against its own signature, so no draft was staged')
  }

  /**
   * A STAGED DRAFT IS NEVER SILENTLY OVERWRITTEN. The draft is the only copy of an approval that has not
   * happened yet; clobbering it would discard a human's pending review with no record that it existed.
   */
  if (fs.existsSync(PENDING_PATH)) {
    let existingTarget = '(unreadable)'
    try {
      existingTarget = String(JSON.parse(fs.readFileSync(PENDING_PATH, 'utf8')).target)
    } catch {
      existingTarget = '(unreadable)'
    }
    if (existingTarget !== targetRelative) {
      fatal(
        'a draft for ' + existingTarget + ' is already staged at ' + PENDING_PATH + '. Staging ' +
          targetRelative + ' would overwrite a review that has neither been approved nor discarded. ' +
          'Approve it, or delete the file deliberately, first.'
      )
    }
  }

  if (!dryRun) {
    fs.writeFileSync(
      PENDING_PATH,
      JSON.stringify(
        {
          schema: PENDING_SCHEMA,
          target: targetRelative,
          contracts: contracts.map((c) => c.relative),
          baseCommit,
          preparedAt: Date.now(),
          payload: draftPayload,
        },
        null,
        2
      ) + '\n',
      'utf8'
    )
  }

  console.log('')
  console.log('specVersion        : ' + draftPayload.specVersion)
  console.log('baseCommit         : ' + baseCommit)
  console.log('artifacts          : ' + draftPayload.artifacts.map((a) => a.path).join(', '))
  console.log('recorded contracts : ' + draftPayload.contracts.map((c) => c.path).join(', '))
  console.log('worker receipt     : key ' + draftPayload.worker.keyFingerprint + ', ' + contractDurationMs + 'ms over ' + contracts.length + ' contract(s)')
  console.log('self-consistent    : ' + (hashBuffer(canonicalizeJson(draftPayload.contracts)) === draftPayload.contractHash))
  console.log('')
  console.log(
    dryRun
      ? 'PREPARE PASS (dry run)  draft built and receipt signed; nothing was staged'
      : 'PREPARE PASS  draft staged at .git/dsh-attestation-pending.json, and NOTHING was attached to ' + NOTES_REF
  )
  console.log('Review the unit and the draft, then approve it:')
  console.log('  node scripts/attest-unit.cjs --approve ' + targetRelative + ' --reviewer-identity "<name>"')
  process.exit(0)
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
