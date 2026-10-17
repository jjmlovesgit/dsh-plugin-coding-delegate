#!/usr/bin/env node
/**
 * End-to-end audit of the delegation ledger at refs/notes/delegations.
 *
 * WHAT IT CHECKS, AND WHY EACH ONE IS SEPARATE.
 *
 *   1. SIGNATURE, AGAINST A PINNED KEY. `verifyEnvelope` verifies a payload against the public key
 *      EMBEDDED IN THE ENVELOPE, which proves integrity and nothing about who signed: an attacker who
 *      replaces the payload can replace the key beside it, and the envelope still verifies. Pinning the
 *      operator's key is what turns self-signed tamper-evidence into operator attribution. It is the
 *      difference between "these bytes are internally consistent" and "these bytes came from this
 *      operator". The comparison is on LF-normalised PEMs, because a CRLF checkout of the committed pin
 *      would otherwise reject every record in the ledger while claiming the keys disagree.
 *
 *   2. THE NOTE IS ATTACHED TO THE COMMIT IT NAMES. `git notes` lets a note hang off ANY commit, so a
 *      sound envelope can be moved to a target whose tree it never saw. Checks 3 and 4 would both pass
 *      while the record pointed at the wrong unit, so the attachment itself has to be compared to
 *      `payload.baseCommit`. This is the only check that reads where the note LIVES rather than what it
 *      SAYS.
 *
 *   3. baseCommit IS AN ANCESTOR OF main. A record anchored to a commit that is not in the branch
 *      attests a tree nobody can check out.
 *
 *   4. ARTIFACTS MATCH THE ANCHORED TREE. The paths ARE recorded in the envelope, so this is a complete
 *      check -- but the comparison is against `git cat-file` at baseCommit, not the working tree. A
 *      working-tree comparison asks "does the file on this disk look like the note says", which a
 *      forged artifact passes as long as nobody has checked out the anchor. Asking the commit itself is
 *      the question that matters, and it also makes the check independent of what is checked out.
 *
 *   5. SPEC CONFORMANCE AT THE ANCHOR POINT. A note anchored at or after the commit that introduced
 *      1.1 must be self-describing. The test is ancestry, not an allowlist: a 1.0 payload before that
 *      commit is history, and after it is a regression.
 *
 *   6. contractHash -- self-described from 1.1, by convention before it, and deliberately allowed to
 *      come back UNVERIFIABLE.
 *
 *   7. EVERY RECORDED CONTRACT IS COVERED BY THE DISCRIMINATION GATE. Check 6 proves the contract is the
 *      one the anchor held; it cannot say whether that contract can FAIL a wrong implementation, and a
 *      contract that cannot makes a passing verification mean only that a file ran. Coverage is having a
 *      counterpart under tests/contracts with a negative fixture beside it, which is what
 *      scripts/check-contract-fixtures.cjs establishes. Measured: tests/currency.contract.cjs was the one
 *      contract in the repository outside that directory, recorded in a published note, and covered by
 *      nothing -- and the record could not tell, because an envelope carries a contract hash, not a
 *      fixture verdict.
 *
 *   8. SPEC 1.2 CARRIES TWO INDEPENDENT SIGNATURES. A payload that claims 1.2 must show a worker receipt
 *      and a reviewer approval, signed with different keys over different byte ranges, each naming the
 *      fingerprint that verifies it. Without that, the claim of a second principal is unbacked -- which
 *      is the whole difference between dual attestation and one signer writing twice.
 *
 *   9. THE RECORDED WORKER MODEL IS THE AUTHORIZED LOCAL ONE. Every other check asks whether the record
 *      is true about the commit; this one asks whether the thing that produced the commit was the
 *      sandboxed local worker the containment claim depends on. `modelIdentifier` is a string the signer
 *      writes, so a ledger that accepts any string cannot show that source never left the machine.
 *
 * WHY CHECK 6 IS NOT A FAILURE WHEN IT CANNOT RUN. For 1.1 notes the envelope records the contract SET,
 * so the digest is recomputed from what the note itself carries, against the anchored tree. For 1.0
 * notes it records only `contractHash`, a blind commitment over an array it does not carry, so it can be
 * recomputed only if the contract set is known from outside: by convention, one contract at
 * `tests/contracts/<artifact-base>.contract.cjs`. Failing the ledger for a schema omission would bury
 * real tampering behind an input set nobody can reconstruct. So a divergence on a RECONSTRUCTED set is a
 * failure, and an unreconstructable set is reported as UNVERIFIABLE and left visible in the summary.
 *
 * WHAT THIS CANNOT DO, stated because a green audit invites over-reading. It proves the notes PRESENT
 * are sound. It cannot prove none were REMOVED: `git notes` writes a ref any writer can rewrite, and
 * the module that stores them says so in its own header. Detecting the removal of a SINGLE record needs
 * a WORM sink or a transparency log, not a git ref. Removing ALL of them is now caught, by the
 * empty-ledger rule below -- that is the one deletion an attacker gets for free otherwise.
 *
 * AN EMPTY LEDGER FAILS CLOSED. This audit used to warn and exit 0 when the notes ref had no entries,
 * reasoning that "no notes yet" is a legitimate state. It is -- and it is also exactly what an attacker
 * produces by deleting the ref, so the check passed in the one case it existed to catch. A gate that
 * reports success once its evidence is deleted is not a gate. `--allow-empty` is the explicit opt-out,
 * and it exists only for the window before the first delegation is signed.
 *
 * THE PINNED KEY IS ITSELF FINGERPRINTED. Resolving the key from the repository is what makes this
 * runnable in CI without a secret, but it also puts the file that defines trust inside the tree being
 * verified: a writer could replace the key and then author notes that satisfy it. A digest constant
 * raises that attack from a one-file substitution to an edit that appears in a reviewed diff AS a change
 * to the trust root. IT DOES NOT CREATE AN OUT-OF-BAND ROOT OF TRUST -- a writer who can edit this file
 * can edit the constant too -- so the honest summary is that this makes re-pinning VISIBLE, not
 * impossible. An actual root of trust has to come from outside the repository, which this cannot supply
 * for itself.
 *
 * KEY ROTATION. A changed key fails every run until the constant is updated deliberately. To rotate:
 * publish the new public key, read the new value from --print-key-fingerprint, change
 * TRUSTED_OPERATOR_PUBKEY_SHA256 in the SAME commit that changes the key, and sign a note for that
 * commit so the rotation is itself an attested record. Do not update the constant to silence a failure
 * whose cause has not been established -- that is how a re-pin gets laundered as maintenance.
 *
 * Usage: node scripts/verify-delegation-ledger.cjs [--allow-empty] [--print-key-fingerprint]
 *
 *   --allow-empty             exit 0 on a ledger with no notes; initialization ceremonies only
 *   --print-key-fingerprint   print the resolved key's fingerprints and exit 0, checking no records
 *
 * Exit 0 when every note passes its critical checks, 1 otherwise, 2 on a usage error.
 */
'use strict'

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFileSync } = require('node:child_process')

const {
  verifyEnvelope,
  hashBuffer,
  normalizePosixPath,
  publicKeyFromPrivate,
} = require('../plugin/dist/crypto-attestation.js')
const { canonicalizeJson } = require('../plugin/dist/canonical-json.js')
// The trust root and its normalisation live in ONE module, shared with the signer, so the two cannot
// disagree about which key is the operator's. See scripts/operator-key.cjs for what the pin does and
// does not buy, and for the rotation ceremony.
const {
  TRUSTED_OPERATOR_PUBKEY_SHA256,
  cleanKey,
  keyFingerprint,
  spkiFingerprint,
} = require('./operator-key.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const NOTES_REF = 'refs/notes/delegations'
const REPO_REVIEWER_KEY_PATH = path.join(REPO_ROOT, 'keys', 'delegation-reviewer.pub')
const AUDIT_NOTICE = '[AUDIT_NOTICE: in-repo reviewer key used; out-of-band pin recommended for CI]'
const KEYS_DIR = path.join(os.homedir(), '.dsh', 'keys')
const PRIVATE_KEY_PATH = path.join(KEYS_DIR, 'delegation_ed25519.pem')
const PUBLIC_KEY_PATH = path.join(KEYS_DIR, 'delegation_ed25519.pub')
const REPO_PINNED_KEY_PATH = path.join(REPO_ROOT, 'keys', 'delegation-operator.pub')

/**
 * The commit that introduced attestation spec 1.1, where the payload began recording the contract set.
 *
 * A note anchored at or after this commit must be self-describing. The test is ANCESTRY, not an
 * allowlist of SHAs: a 1.0 payload anchored BEFORE this commit is history that cannot be re-signed
 * without rewriting a published record, and a 1.0 payload anchored after it means a signer that should
 * not still be in use produced it.
 *
 * The full object name, not an abbreviation: an abbreviated name is unambiguous only until the object
 * database grows another object sharing the prefix, and this constant must not rot into ambiguity.
 */
const SPEC_1_1_CUTOFF = 'c5bcc5a61b018468dd8cb16a3aed9c53c1c73232'

/**
 * The one worker model this ledger accepts.
 *
 * EVERY OTHER CHECK ASKS WHETHER THE RECORD IS TRUE ABOUT THE COMMIT; this asks whether the run that
 * produced the commit was the local worker the containment claim rests on. The payload cannot answer
 * that for itself: `modelIdentifier` is a string the signer writes, so a worker repointed at a cloud
 * model -- or a caller passing `--model` by hand -- records that name and every other check still
 * passes. The audit printed the model in its summary and never compared it, which reads as a check to
 * anyone scanning the output and is not one.
 *
 * EQUALITY, NOT A SET, AND THE SAME TRADE AS THE KEY PIN. A set invites the question of who decides
 * membership; one constant makes a model change a single line in a reviewed diff. That is the whole
 * value, and it is a real limit: this cannot establish that a model is local. It can only establish that
 * the record names the model the operator authorized for this ledger. Moving the worker to another local
 * checkpoint therefore means changing this constant in the SAME commit that changes PROFILES.WORKER --
 * the intended friction, and the reason it is not a fallback chain.
 *
 * APPLIED TO EVERY NOTE, with no cut-off. Every record in this ledger names the same checkpoint, so there
 * is no legacy class to grandfather, and a cut-off would let the first record naming a cloud model in.
 */
const AUTHORIZED_WORKER_MODEL = 'qwen/qwen3.8-27b'

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

// `cleanKey`, `TRUSTED_OPERATOR_PUBKEY_SHA256`, `keyFingerprint` and `spkiFingerprint` are imported from
// ./operator-key.cjs above, together with the reasoning behind each. They were defined here first; they
// moved so the signer can enforce the same pin without a second copy of the digest to keep in step.

/**
 * Resolve the operator's public key to pin against, from every source that is present.
 *
 * THE REPO PIN IS WHAT MAKES THIS RUNNABLE IN CI. A GitHub runner has no ~/.dsh, so a resolver that
 * reads only the operator's key directory fails the audit step on EVERY run -- a permanently red check
 * that says nothing about the ledger, which is worse than no check because it trains people to ignore
 * it. The public key is public: committing it lets CI attribute records without holding a secret, and
 * turns the pin into a reviewable file rather than a machine-local fact.
 *
 * Every source present must AGREE, and a disagreement is fatal rather than resolved by precedence. A
 * stale copy of the key fails silently in the worst direction -- pinning the wrong key makes real
 * records look forged, and makes a forged record look real.
 */
function resolvePinnedKey() {
  const sources = []

  // NORMALISED AT THE READ, once, so every downstream comparison and every verifyEnvelope call sees the
  // same canonical bytes regardless of how git checked the file out. `hadCr` is kept so the normalisation
  // is reported rather than silent: a cross-environment difference worth hiding is not worth hiding.
  const addSource = (label, raw) => {
    sources.push({ label, pem: cleanKey(raw), hadCr: /\r/.test(String(raw)) })
  }

  if (fs.existsSync(REPO_PINNED_KEY_PATH)) {
    addSource('keys/delegation-operator.pub', fs.readFileSync(REPO_PINNED_KEY_PATH, 'utf8'))
  }
  if (fs.existsSync(PUBLIC_KEY_PATH)) {
    addSource('~/.dsh/keys/delegation_ed25519.pub', fs.readFileSync(PUBLIC_KEY_PATH, 'utf8'))
  }
  if (fs.existsSync(PRIVATE_KEY_PATH)) {
    addSource(
      '~/.dsh/keys/delegation_ed25519.pem (derived)',
      publicKeyFromPrivate(fs.readFileSync(PRIVATE_KEY_PATH, 'utf8'))
    )
  }

  for (const source of sources) {
    if (source.hadCr) {
      console.warn('  warn  ' + source.label + ' contained CR line endings; normalised to LF before comparison')
    }
  }

  if (sources.length === 0) {
    console.error(
      'FATAL  no operator public key found. Expected keys/delegation-operator.pub in the repository, ' +
        'or ~/.dsh/keys/delegation_ed25519.pem / .pub locally. Without a pinned key this audit could ' +
        'only check that each envelope agrees with itself, which is not attribution.'
    )
    process.exit(1)
  }

  const primary = sources[0]
  for (const other of sources.slice(1)) {
    if (other.pem !== primary.pem) {
      console.error(
        'FATAL  pinned public keys disagree: ' + primary.label + ' and ' + other.label + '. One is ' +
          'stale, and pinning either would attribute records to the wrong key.'
      )
      process.exit(1)
    }
  }

  // A QUERY, NOT A CHECK: prints what the sources actually hold and exits before any record is read, so
  // an operator can obtain the value for a rotation without having to first make the audit pass.
  if (printFingerprintOnly) {
    for (const source of sources) {
      const fingerprint = keyFingerprint(source.pem)
      console.log('  ' + source.label)
      console.log(
        '    pem  sha256 : ' + fingerprint +
          (fingerprint === TRUSTED_OPERATOR_PUBKEY_SHA256 ? '  (matches the constant)' : '  (DIFFERS from the constant)')
      )
      console.log('    spki sha256 : ' + spkiFingerprint(source.pem))
    }
    // Printed in the exact form the constant needs, so a rotation is a paste rather than a transcription.
    console.log('\nTRUSTED_OPERATOR_PUBKEY_SHA256 = \'' + keyFingerprint(primary.pem) + '\'')
    process.exit(0)
  }

  // CHECKED BEFORE ANY RECORD IS READ. Verifying notes against a key that this audit was not written to
  // trust would produce confident verdicts about the wrong operator, which is the failure mode the whole
  // pinned-key design exists to prevent.
  for (const source of sources) {
    const fingerprint = keyFingerprint(source.pem)
    if (fingerprint === TRUSTED_OPERATOR_PUBKEY_SHA256) continue
    console.error(
      'FATAL  the operator key does not match the pinned fingerprint.\n' +
        '       source             : ' + source.label + '\n' +
        '       pinned fingerprint : ' + TRUSTED_OPERATOR_PUBKEY_SHA256 + '\n' +
        '       actual fingerprint : ' + fingerprint + '\n' +
        '       spki sha256        : ' + spkiFingerprint(source.pem) + '\n' +
        '       This audit will not judge a ledger against a key it was not written to trust. If the two\n' +
        '       fingerprints differ ONLY because the PEM was reformatted, restore the committed formatting.\n' +
        '       If this is a deliberate rotation, change TRUSTED_OPERATOR_PUBKEY_SHA256 in the same commit\n' +
        '       that changes the key and sign a note for that commit, so the rotation is itself attested.\n' +
        '       --print-key-fingerprint prints the value to use. Do not edit the constant merely to make\n' +
        '       this message go away.'
    )
    process.exit(1)
  }

  const agreement = sources.length > 1 ? ' (agrees with ' + sources.slice(1).map((s) => s.label).join(', ') + ')' : ''
  console.log(
    'pinned key: ' + primary.label + agreement + ' · fingerprint ' +
      TRUSTED_OPERATOR_PUBKEY_SHA256.slice(0, 8) + ' verified\n'
  )
  return primary.pem
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
}

/**
 * Digest of a blob as it exists in a commit's tree, or null when that path is not in it.
 *
 * BYTES, not text. `git()` decodes as utf8, which is lossless for the ref names and path lists it is
 * used for and silently corrupts anything binary. An artifact is arbitrary bytes, so this reads a raw
 * Buffer and digests exactly what git stored.
 */
function blobHashAt(commit, repoRelativePath) {
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

const KNOWN_FLAGS = ['--allow-empty', '--print-key-fingerprint']
const argv = process.argv.slice(2)
const unknownArgs = argv.filter((arg) => !KNOWN_FLAGS.includes(arg))
if (unknownArgs.length > 0) {
  console.error('usage: node scripts/verify-delegation-ledger.cjs [--allow-empty] [--print-key-fingerprint]')
  console.error('unrecognised argument(s): ' + unknownArgs.join(', '))
  process.exit(2)
}
// Explicit, never inferred: a missing ledger and an unattested project look identical on disk, so the
// decision to accept one cannot be made silently by whoever deletes the ref first.
const allowEmpty = argv.includes('--allow-empty')
const printFingerprintOnly = argv.includes('--print-key-fingerprint')

const pinnedPublicKeyPem = resolvePinnedKey()

/**
 * The contract names the discrimination gate actually covers: a contract at `tests/contracts/<name>.contract.cjs`
 * that has a negative fixture beside it in `tests/contracts/fixtures/`.
 *
 * WHY THE AUDIT ASKS ABOUT COVERAGE AT ALL. Check 6 proves the recorded contract is the one the anchored
 * tree held. It says nothing about whether that contract can FAIL a wrong implementation, and a contract
 * that cannot makes `"passed": true` mean "this file ran". `scripts/check-contract-fixtures.cjs` is what
 * establishes the stronger property, and it discovers contracts by scanning one directory -- so a contract
 * outside it is verified by nothing. Measured: `tests/currency.contract.cjs` was the only contract in the
 * repository outside `tests/contracts`, recorded in a published note, and never run against a fixture.
 * The record could not tell, because an envelope carries a contract hash and not a fixture verdict.
 *
 * Returns null when the directories are absent, which the caller treats as fatal rather than as "nothing
 * to check": an audit that passes because it cannot see the fixtures is the fail-open this repository
 * keeps having to close.
 */
function coveredContractBasenames() {
  const contractsDir = path.join(REPO_ROOT, 'tests', 'contracts')
  const fixturesDir = path.join(contractsDir, 'fixtures')
  if (!fs.existsSync(contractsDir) || !fs.existsSync(fixturesDir)) return null
  const fixtures = new Set(
    fs.readdirSync(fixturesDir).map((f) => f.replace(/\.negative\.(ts|cjs)$/, ''))
  )
  const covered = new Set()
  for (const file of fs.readdirSync(contractsDir)) {
    if (!file.endsWith('.contract.cjs')) continue
    const base = file.replace(/\.contract\.cjs$/, '')
    if (fixtures.has(base)) covered.add(base)
  }
  return covered
}

const coveredContracts = coveredContractBasenames()
if (coveredContracts === null) {
  console.error(
    'FATAL  tests/contracts or tests/contracts/fixtures is missing, so no recorded contract can be shown ' +
      'to be covered by the discrimination gate. Everything this audit says about a contract would be a ' +
      'statement about a file that ran, not about a property that holds. Refusing to report on the ledger.'
  )
  process.exit(1)
}
if (coveredContracts.size === 0) {
  console.error(
    'FATAL  no contract under tests/contracts has a negative fixture, so the discrimination gate covers ' +
      'nothing. Either the gate would fail closed on its own, or its discovery has been broken.'
  )
  process.exit(1)
}

/**
 * Resolve the reviewer trust root for a 1.2 note, with the out-of-band pin authoritative.
 *
 * PRECEDENCE IS THE POINT. A key pinned only by a file in the repository being verified is exposed to
 * whoever can commit to that repository: they can substitute the key and the records that satisfy it in
 * one diff. The whole value of a second signature is that a committer cannot produce it, so the trust
 * root comes from outside the tree whenever one is offered:
 *
 *   DSH_REVIEWER_PUBKEY       a PEM, or a path to one -- the key itself, supplied out of band
 *   DSH_REVIEWER_FINGERPRINT  the fingerprint to require; the key may still come from the repository,
 *                             because the DECISION to trust it did not
 *
 * With neither set, keys/delegation-reviewer.pub is accepted for local bootstrapping and the run says so
 * in its own output. With neither and no repository key this returns an error and the note fails closed:
 * a 1.2 claim that cannot be checked must not be accepted on the weaker 1.1 rules instead.
 */
function resolveReviewerKey() {
  const envPubkey = String(process.env.DSH_REVIEWER_PUBKEY || '').trim()
  const envFingerprint = String(process.env.DSH_REVIEWER_FINGERPRINT || '').trim()

  let pem = null
  let source = null
  if (envPubkey) {
    if (envPubkey.includes('-----BEGIN')) {
      pem = envPubkey
      source = 'DSH_REVIEWER_PUBKEY (inline PEM)'
    } else {
      try {
        pem = fs.readFileSync(envPubkey, 'utf8')
        source = 'DSH_REVIEWER_PUBKEY (' + envPubkey + ')'
      } catch {
        return { error: 'DSH_REVIEWER_PUBKEY names a file that could not be read: ' + envPubkey }
      }
    }
  } else if (fs.existsSync(REPO_REVIEWER_KEY_PATH)) {
    pem = fs.readFileSync(REPO_REVIEWER_KEY_PATH, 'utf8')
    source = 'keys/delegation-reviewer.pub (in-repo fallback)'
  }

  if (!pem) {
    return {
      error:
        'no reviewer trust root: set DSH_REVIEWER_PUBKEY or DSH_REVIEWER_FINGERPRINT, or provide ' +
        'keys/delegation-reviewer.pub for local use. A 1.2 note cannot be verified without one, and it ' +
        'is not accepted on the 1.1 rules instead.',
    }
  }

  const fingerprint = keyFingerprint(pem)
  if (envFingerprint && fingerprint !== envFingerprint) {
    return {
      error:
        'the resolved reviewer key does not match DSH_REVIEWER_FINGERPRINT: resolved=' + fingerprint +
        ' required=' + envFingerprint + '. The key in use is not the one pinned out of band.',
    }
  }
  if (!envPubkey && !envFingerprint) console.warn('  ' + AUDIT_NOTICE)
  return { pem, fingerprint, source, outOfBand: Boolean(envPubkey || envFingerprint) }
}

/**
 * Verify one Ed25519 signature over the canonical bytes of its signing payload.
 *
 * THE CANONICAL BYTES ARE SIGNED DIRECTLY, not a digest of them, which is a deliberate departure from the
 * plan's `SHA-256(canonicalizeJson(...))` formulation. Ed25519 hashes the message internally (RFC 8032),
 * so an extra SHA-256 buys nothing, and the existing envelope scheme (`signManifest` / `verifyEnvelope`)
 * signs the payload string rather than a digest of it. One signing convention, so the signer written next
 * and this auditor cannot disagree about what was signed -- which would be a silent, total failure of
 * every 1.2 check.
 */
function verifyCanonicalSignature(signingPayload, signatureBase64, publicKeyPem) {
  let canonical
  try {
    canonical = canonicalizeJson(signingPayload)
  } catch (err) {
    return {
      ok: false,
      reason: 'signing payload is not canonicalisable: ' + (err && err.message ? err.message : err),
    }
  }
  let signature
  try {
    signature = Buffer.from(String(signatureBase64 || ''), 'base64')
  } catch {
    return { ok: false, reason: 'signature is not valid base64' }
  }
  if (signature.length === 0) return { ok: false, reason: 'signature is empty' }
  try {
    const valid = crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKeyPem, signature)
    return valid ? { ok: true } : { ok: false, reason: 'signature does not verify' }
  } catch (err) {
    return {
      ok: false,
      reason: 'the key could not be used to verify: ' + (err && err.message ? err.message : err),
    }
  }
}

let listing = ''
try {
  listing = String(git(['notes', '--ref=' + NOTES_REF, 'list'])).trim()
} catch (err) {
  console.error('FATAL  could not read ' + NOTES_REF + ': ' + (err && err.message ? err.message : err))
  process.exit(1)
}

const entries = listing
  .split('\n')
  .map((line) => line.trim())
  .filter(Boolean)
  .map((line) => {
    const [noteBlob, commitSha] = line.split(/\s+/)
    return { noteBlob, commitSha }
  })

if (entries.length === 0) {
  // THE ONE DELETION AN ATTACKER WOULD OTHERWISE GET FOR FREE. An empty ref is indistinguishable from a
  // deleted ref, so passing here means the gate can be switched off by removing its evidence.
  if (!allowEmpty) {
    console.error(
      'FATAL  ' + NOTES_REF + ' carries no notes, and an empty ledger is indistinguishable from a\n' +
        '       deleted one. Failing closed: a gate that reports success once its evidence is removed is\n' +
        '       not a gate. If this repository genuinely has no delegations yet, pass --allow-empty\n' +
        '       explicitly -- and note that doing so in CI would disable this check for everyone.'
    )
    process.exit(1)
  }
  console.warn(
    'WARN  ' + NOTES_REF + ' carries no notes; --allow-empty was passed, so this is treated as a\n' +
      '      pre-first-delegation state. This run proves nothing about any record.'
  )
  process.exit(0)
}

console.log('=== DELEGATION LEDGER AUDIT (' + entries.length + ' notes) ===\n')

let critical = 0
const summary = []

for (const { noteBlob, commitSha } of entries) {
  const short = commitSha.slice(0, 8)
  console.log('Commit ' + short + '  (note blob ' + noteBlob.slice(0, 8) + ')')

  const fail = (message) => {
    critical += 1
    console.error('  FAIL  ' + message)
  }

  let envelope
  let payload
  try {
    let raw = String(git(['notes', '--ref=' + NOTES_REF, 'show', commitSha]))
    if (raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1)
    envelope = JSON.parse(raw.trim())
    payload = JSON.parse(envelope.payload)
  } catch (err) {
    fail('unreadable or malformed envelope: ' + (err && err.message ? err.message : err))
    summary.push({ commit: short, result: 'MALFORMED' })
    console.log('')
    continue
  }

  // ---- 1. signature against the PINNED key --------------------------------
  // The embedded key is normalised too: an envelope signed on a CRLF machine can carry a CRLF PEM, and
  // comparing raw bytes there would report a sound record as unattributed.
  const embeddedKey = cleanKey(envelope.publicKeyPem || '')
  const keyMatchesPinned = embeddedKey === pinnedPublicKeyPem
  const signatureValid = verifyEnvelope(Object.assign({}, envelope, { publicKeyPem: pinnedPublicKeyPem }))

  if (keyMatchesPinned && signatureValid) {
    console.log('  ok    Ed25519 signature valid against the pinned operator key')
  } else {
    fail(
      'signature check failed (key matches pinned: ' + keyMatchesPinned + ', signature valid under ' +
        'pinned key: ' + signatureValid + '). An envelope that verifies only against its own embedded ' +
        'key is internally consistent and unattributed.'
    )
  }

  // ---- 2. the note is attached to the commit it claims ---------------------
  //
  // ANCESTRY ALONE DOES NOT TIE A RECORD TO ITS ANCHOR. A note can sit on any commit while its payload
  // names a different one, and every later check still passes: the named commit is a real ancestor, the
  // artifacts exist in that tree, the digest reproduces. Measured: a note attached to 0286c6b while
  // claiming baseCommit 82c23c3 passed the entire audit before this check existed, which makes the
  // anchor a comment rather than a binding.
  if (String(payload.baseCommit) !== commitSha) {
    fail(
      'attachment mismatch: the note is attached to ' + short + ' but its payload claims baseCommit ' +
        String(payload.baseCommit).slice(0, 8) + '. A record that names one commit and lives on another ' +
        'can be moved between anchors without touching a byte of it.'
    )
  } else {
    console.log('  ok    attached to the commit its payload names (' + short + ')')
  }

  // ---- 3. baseCommit is an ancestor of main -------------------------------
  let ancestryOk = false
  try {
    git(['merge-base', '--is-ancestor', payload.baseCommit, 'main'])
    ancestryOk = true
  } catch {
    ancestryOk = false
  }
  if (ancestryOk) {
    console.log('  ok    baseCommit ' + String(payload.baseCommit).slice(0, 8) + ' is an ancestor of main')
  } else {
    fail('baseCommit ' + payload.baseCommit + ' is not an ancestor of main; the record anchors to a tree nobody can check out')
  }

  // ---- 4. artifacts match the ANCHORED TREE -------------------------------
  //
  // FROM THE COMMIT, NOT FROM DISK. The record attests what was committed at baseCommit; the working
  // tree is a later and unrelated fact. Reading disk meant a note could name an artifact that commit
  // never contained and still report "match on-disk bytes" -- measured by anchoring a note to 82c23c3
  // for tools/lru-cache.ts, which that commit does not hold. Reading the tree is also what makes this
  // time-travelling: it says what the anchor contained, whatever happened to the file afterwards.
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : []
  let artifactsOk = artifacts.length > 0
  if (artifacts.length === 0) {
    fail('the envelope names no artifacts, so there is nothing to check')
  }
  for (const artifact of artifacts) {
    const inTree = blobHashAt(payload.baseCommit, artifact.path)
    if (inTree === null) {
      fail(
        'artifact is not in the anchored tree ' + String(payload.baseCommit).slice(0, 8) + ': ' +
          artifact.path
      )
      artifactsOk = false
      continue
    }
    if (inTree !== artifact.sha256) {
      fail(
        'artifact sha256 does not match the blob in ' + String(payload.baseCommit).slice(0, 8) + ' for ' +
          artifact.path + ': tree=' + inTree + ' note=' + artifact.sha256
      )
      artifactsOk = false
    }
    if (artifact.path.includes('\\')) {
      console.warn('  warn  artifact path is recorded with backslashes (' + artifact.path + '); it predates POSIX normalisation')
    }
  }
  if (artifactsOk) console.log('  ok    ' + artifacts.length + ' artifact(s) match the anchored tree')

  // ---- 5. spec conformance at the anchor point ----------------------------
  //
  // NOT REDUNDANT WITH CHECK 6. A 1.0 payload that HAPPENS to follow the tools/<name> convention audits
  // as VERIFIED and nothing flags it -- but it is still a blind commitment, and it becomes UNVERIFIABLE
  // the moment the contract set leaves the convention or grows past one file. Without this rule, only
  // the notes that already fail the convention are visible; a hand-rolled or stale signer could keep
  // producing convention-dependent records indefinitely and every one of them would look clean.
  let postCutoff = false
  try {
    // argv, not a shell: `baseCommit` comes out of the note payload, and interpolating note content
    // into a command line is how a record gets to choose what the auditor executes.
    git(['merge-base', '--is-ancestor', SPEC_1_1_CUTOFF, payload.baseCommit])
    postCutoff = true
  } catch {
    postCutoff = false
  }

  const hasContractSet = Array.isArray(payload.contracts)

  if (postCutoff && !hasContractSet) {
    fail(
      'spec regression: anchored after the 1.1 cutoff (' + SPEC_1_1_CUTOFF.slice(0, 8) + ') but the ' +
        'payload records specVersion ' + payload.specVersion + ' with no contracts array. A record ' +
        'signed from here on must be self-describing: a digest whose input set is never recorded can ' +
        'only be recomputed by guessing a path convention.'
    )
  } else if (!postCutoff && !hasContractSet) {
    console.log(
      '  --    legacy 1.0 payload, anchored before the 1.1 cutoff; grandfathered and resolved below'
    )
  }

  // ---- 6. contractHash: self-described from 1.1, by convention for 1.0 ----------
  let contractResult = 'UNVERIFIABLE'
  const cmp = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

  if (Array.isArray(payload.contracts)) {
    // SELF-DESCRIBING. The document carries the set its digest was taken over, so every contract is
    // checked against disk and the digest is reproduced from the document itself -- no convention, no
    // guessing, and a multi-contract unit is covered as well as a single-contract one.
    const recorded = payload.contracts.map((c) => ({ path: String(c.path), sha256: c.sha256 }))
    const sortedSame = JSON.stringify(recorded) === JSON.stringify([...recorded].sort(cmp))
    let allInTree = true

    if (recorded.length === 0) {
      fail('the payload carries an empty contracts array, so contractHash commits to nothing')
      allInTree = false
    }
    for (const contract of recorded) {
      if (contract.path.includes('\\')) {
        console.warn('  warn  recorded contract path is not POSIX: ' + contract.path)
      }
      // From the anchored tree, for the same reason check 4 is: the record is about what that commit
      // held, and a contract edited afterwards is a later and unrelated fact.
      const inTree = blobHashAt(payload.baseCommit, contract.path)
      if (inTree === null) {
        fail(
          'recorded contract is not in the anchored tree ' + String(payload.baseCommit).slice(0, 8) +
            ': ' + contract.path
        )
        allInTree = false
        continue
      }
      if (inTree !== contract.sha256) {
        fail(
          'recorded contract sha256 does not match the blob in ' + String(payload.baseCommit).slice(0, 8) +
            ' for ' + contract.path + ': tree=' + inTree + ' note=' + contract.sha256
        )
        allInTree = false
      }
    }

    // Hashed EXACTLY as recorded. This is the reader's reproduction of the commitment, so normalising
    // or re-sorting here would mask a signer that recorded something other than what it hashed.
    const recomputed = hashBuffer(canonicalizeJson(recorded))
    if (recomputed !== payload.contractHash) {
      contractResult = 'DIVERGED'
      fail(
        'contractHash does not match the digest of the RECORDED contract set: recomputed=' + recomputed +
          ' note=' + payload.contractHash
      )
    } else if (allInTree && sortedSame) {
      contractResult = 'SELF-DESCRIBED'
      console.log(
        '  ok    contractHash reproduced from the ' + recorded.length + ' contract(s) recorded in the payload'
      )
    }
  } else if (payload.specVersion === '1.0') {
    // LEGACY. A 1.0 payload records the digest and never the set, so it is reproduced by convention or
    // not at all -- and NOT reproduced is UNVERIFIABLE rather than failed. Failing the ledger for a
    // schema omission would bury real tampering behind an input set nobody can recover.
    const firstArtifact = artifacts.length > 0 ? String(artifacts[0].path) : ''
    const baseName = normalizePosixPath(firstArtifact).replace(/^tools\//, '').replace(/\.(ts|js|mjs|mts)$/, '')
    const conventional = baseName.length > 0 && !baseName.includes('/')

    if (!conventional) {
      console.log(
        '  --    contractHash not recomputed: the artifact is outside the tools/<name> convention, so ' +
          'the contract set cannot be reconstructed from the envelope'
      )
    } else {
      const candidateRel = 'tests/contracts/' + baseName + '.contract.cjs'
      const candidateSha = blobHashAt(payload.baseCommit, candidateRel)
      if (candidateSha === null) {
        console.log('  --    contractHash not recomputed: ' + candidateRel + ' is not in the anchored tree')
      } else {
        // Sorted the way buildAttestationPlan sorted it, so the reconstruction is the signer's own.
        const contracts = [{ path: normalizePosixPath(candidateRel), sha256: candidateSha }].sort(cmp)
        const recomputed = hashBuffer(canonicalizeJson(contracts))
        if (recomputed === payload.contractHash) {
          contractResult = 'VERIFIED'
          console.log('  ok    contractHash recomputed by convention against ' + candidateRel)
        } else {
          contractResult = 'DIVERGED'
          fail(
            'contractHash divergence on ' + candidateRel + ': recomputed=' + recomputed + ' note=' +
              payload.contractHash + '. The contract that judged this unit is not the one its anchor held.'
          )
        }
      }
    }
  } else {
    console.log(
      '  --    contractHash not recomputed: specVersion ' + payload.specVersion + ' carries no contracts array'
    )
  }

  // ---- 7. every recorded contract is covered by the discrimination gate ------
  //
  // APPLIED ONLY TO RECORDED CONTRACTS. A 1.0 payload carries no set, so there is nothing here to check:
  // its digest is reconstructed from `tests/contracts/<name>.contract.cjs`, a path that is inside the
  // gate's directory by construction, and the gate itself fails closed when such a contract has no
  // fixture. A 1.1 payload names its contracts, and one of them can name anywhere in the repository --
  // which is how the uncovered contract got recorded in the first place.
  if (Array.isArray(payload.contracts)) {
    let coverageOk = true
    for (const contract of payload.contracts) {
      const base = normalizePosixPath(String(contract.path))
        .split('/')
        .pop()
        .replace(/\.contract\.cjs$/, '')
      if (!coveredContracts.has(base)) {
        coverageOk = false
        fail(
          'contract ' + contract.path + ' is not covered by the discrimination gate: no ' +
            'tests/contracts/' + base + '.contract.cjs with a negative fixture beside it. Check 6 proved ' +
            'this is the contract the anchor held; nothing has shown it can fail a wrong implementation, ' +
            'so the verification it judged is only known to have run.'
        )
      }
    }
    if (coverageOk) {
      console.log(
        '  ok    ' + payload.contracts.length + ' recorded contract(s) covered by the discrimination gate'
      )
    }
  }

  // ---- 8. spec 1.2: dual attestation, against a trust root that need not be in this tree -----
  //
  // TRIGGERED BY THE DECLARED VERSION, not by an ancestry cutoff. A cutoff exists for 1.0 because 1.0
  // notes were legitimate before 1.1 and must stay grandfathered by ancestry; there is no legacy 1.2. A
  // payload that claims 1.2 and cannot show an independent reviewer signature is a lie about its own
  // format, so it is refused on sight rather than checked on the weaker rules. The 1.0 and 1.1 branches
  // above are untouched, and the seven notes recorded before 1.2 existed verify exactly as they did.
  if (payload.specVersion === '1.2') {
    const workerBlock = payload.worker
    const reviewerBlock = payload.reviewer
    if (!workerBlock || typeof workerBlock !== 'object' || !reviewerBlock || typeof reviewerBlock !== 'object') {
      fail(
        'a 1.2 payload must carry both a worker and a reviewer block, and this one is missing at least ' +
          'one of them, so it claims a dual attestation it cannot show'
      )
    } else {
      const workerFingerprint = String(workerBlock.keyFingerprint || '')
      const reviewerFingerprint = String(reviewerBlock.keyFingerprint || '')
      const pinnedFingerprint = TRUSTED_OPERATOR_PUBKEY_SHA256.slice(0, 8)

      // The independence check is what makes a second signature mean anything: a reviewer holding the
      // worker's key is not a second principal, it is the same one signing twice.
      if (workerFingerprint && reviewerFingerprint && workerFingerprint === reviewerFingerprint) {
        fail(
          'self-approval refused: the worker and reviewer key fingerprints are identical (' +
            workerFingerprint + '), so this review is the worker approving its own output'
        )
      } else if (workerFingerprint !== pinnedFingerprint) {
        fail(
          'the worker block names key fingerprint ' + (workerFingerprint || '(none)') +
            ', but the pinned operator key is ' + pinnedFingerprint
        )
      }

      const reviewer = resolveReviewerKey()
      if (reviewer.error) {
        fail('reviewer trust root unresolved: ' + reviewer.error)
      } else {
        // THE RECORD MUST NAME THE KEY THAT VERIFIES IT. Without this check a payload could name any
        // fingerprint it liked -- a third key's, or none at all -- and still be verified under the
        // resolved trust root, so the identity a reader sees and the key that actually verified would be
        // free to differ. That is the gap a freshly generated third key would otherwise slip through,
        // and it was found by writing probe 3 rather than by reading this code.
        const resolvedPrefix = reviewer.fingerprint.slice(0, 8)
        if (!reviewerFingerprint) {
          fail(
            'the reviewer block names no key fingerprint, so its signature cannot be attributed to a key ' +
              'and the record cannot be checked against an authorized reviewer'
          )
        } else if (reviewerFingerprint !== resolvedPrefix) {
          fail(
            'the reviewer block names key fingerprint ' + reviewerFingerprint + ' but the resolved trust ' +
              'root is ' + resolvedPrefix + ', so the record does not name the key that would verify it'
          )
        }

        console.log('  ok    reviewer key resolved from ' + reviewer.source)
        if (!reviewer.outOfBand) {
          console.log('  --    the reviewer trust decision came from this repository, so it is reviewable rather than independent')
        } else {
          console.log('  ok    reviewer trust root supplied out of band (' + reviewer.fingerprint.slice(0, 8) + ')')
        }

        // THE TWO ENVELOPES ARE INDEPENDENT, NOT CIRCULAR. The worker signs the record WITHOUT the
        // reviewer block, so its signature survives the reviewer signing afterwards; the reviewer signs
        // everything except its own signature, which binds it to the worker's receipt rather than to some
        // later form of it. Each signature is excluded from its own payload -- that is what stops the
        // second signature invalidating the first.
        const workerPayload = Object.assign({}, payload)
        delete workerPayload.reviewer
        const workerInner = Object.assign({}, payload.worker)
        delete workerInner.signature
        workerPayload.worker = workerInner
        const workerCheck = verifyCanonicalSignature(workerPayload, payload.worker.signature, pinnedPublicKeyPem)
        if (workerCheck.ok) {
          console.log('  ok    worker signature valid over the canonical record, reviewer block excluded')
        } else {
          fail('worker signature invalid: ' + workerCheck.reason)
        }

        const reviewerPayload = Object.assign({}, payload)
        const reviewerInner = Object.assign({}, payload.reviewer)
        delete reviewerInner.signature
        reviewerPayload.reviewer = reviewerInner
        const reviewerCheck = verifyCanonicalSignature(reviewerPayload, payload.reviewer.signature, reviewer.pem)
        if (reviewerCheck.ok) {
          console.log('  ok    reviewer signature valid over the canonical record under the resolved key')
        } else {
          fail('reviewer signature invalid: ' + reviewerCheck.reason)
        }

        // ORDERING IS REPORTED, NOT TRUSTED. Both timestamps are asserted by the side that signed them,
        // so this catches a record that is internally inconsistent, not a dishonest clock. Stated here
        // because a reader could otherwise take the comparison for a security property.
        const workerAt = Number(workerBlock.timestamp)
        const reviewerAt = Number(reviewerBlock.timestamp)
        if (Number.isFinite(workerAt) && Number.isFinite(reviewerAt) && reviewerAt < workerAt) {
          fail(
            'the reviewer timestamp ' + reviewerAt + ' precedes the worker timestamp ' + workerAt +
              ', so the record claims review before the run it reviews'
          )
        }
      }
    }
  }

  // ---- 9. the recorded worker model is the authorized local one -----------------
  //
  // EVERY OTHER CHECK IS ABOUT THE COMMIT; this one is about the run that made it. See
  // AUTHORIZED_WORKER_MODEL for why the comparison is equality rather than a set, and for what it cannot
  // prove. A missing value fails closed: an empty `modelIdentifier` is not a model, and treating it as
  // "unspecified, therefore permitted" is how a field that nobody fills in stops being a control.
  const recordedModel = typeof payload.modelIdentifier === 'string' ? payload.modelIdentifier.trim() : ''
  if (!recordedModel) {
    fail(
      'the payload records no modelIdentifier, so nothing shows which model produced these artifacts and ' +
        'the local-worker boundary cannot be checked against an authorized model'
    )
  } else if (recordedModel !== AUTHORIZED_WORKER_MODEL) {
    fail(
      'the payload records modelIdentifier ' + recordedModel + ', but this ledger authorizes ' +
        AUTHORIZED_WORKER_MODEL + ' as its local worker. A record naming any other model records a run ' +
        'this containment claim does not cover, whatever the artifacts say.'
    )
  } else {
    console.log('  ok    worker model is the authorized local one (' + recordedModel + ')')
  }

  summary.push({
    commit: short,
    model: payload.modelIdentifier,
    result: critical === 0 ? 'PASS' : 'see failures',
    contract: contractResult,
  })
  console.log('')
}

console.log('=== SUMMARY ===')
for (const row of summary) {
  console.log(
    '  ' + row.commit.padEnd(10) + ' contract=' + String(row.contract || '-').padEnd(11) + ' ' + (row.model || '')
  )
}
console.log('')

if (critical > 0) {
  console.error('AUDIT FAILED: ' + critical + ' critical check(s) failed.')
  process.exit(1)
}
console.log('AUDIT PASSED: every note is attributed to the pinned operator key, attached to the commit it names, its artifacts and contracts match that commit\'s tree, every recorded contract is covered by the discrimination gate, and every record names the authorized local worker model.')
console.log('NOTE: this proves the records present are sound. It cannot detect a record that was deleted.')
process.exit(0)
