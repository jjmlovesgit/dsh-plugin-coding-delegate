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

const REPO_ROOT = path.resolve(__dirname, '..')
const NOTES_REF = 'refs/notes/delegations'
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

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

/**
 * Canonicalise a PEM before it is compared or consumed: CRLF and lone CR become LF, then trim.
 *
 * WHY THIS IS NOT COSMETIC. The crypto layer ALREADY tolerates CRLF -- measured on this checkout,
 * `verifyEnvelope`, `publicKeyFromPrivate` and `crypto.sign` all accept a CRLF PEM and behave
 * identically to LF -- so the only thing CRLF breaks is STRING EQUALITY, which is exactly how the pin is
 * enforced. A CRLF checkout of `keys/delegation-operator.pub` (any machine with core.autocrlf=true, and
 * this repository carries no .gitattributes to prevent it) therefore made this audit refuse to run at
 * all, with a message asserting that two copies of ONE key "disagree" and that one of them is stale.
 * A false rejection whose text accuses the operator of pinning the wrong key is worse than a crash: it
 * is a lie told by the security path, and its remedy points at the wrong thing.
 *
 * `\r\n?` rather than `\r\n` so a lone CR -- an old-Mac or hand-edited file -- is normalised too.
 */
const cleanKey = (keyStr) => String(keyStr).replace(/\r\n?/g, '\n').trim()

/**
 * SHA-256 of the operator public key, over the LF-normalised, trimmed PEM text.
 *
 * THIS CONSTANT IS THE TRUST ROOT OF THE WHOLE AUDIT, and it is deliberately a constant rather than a
 * value read from the tree it is checking. Resolving the key from the repository is what lets CI
 * attribute records without holding a secret; the cost is that the file defining trust lives inside the
 * verified tree. Pinning the digest means substituting the key is no longer sufficient on its own --
 * the substitution must also be visible as an edit to this line.
 *
 * WHAT IT DOES NOT BUY: a writer who can change this file can change the constant, so this is not an
 * out-of-band root of trust. It converts a silent re-pin into a reviewable diff. That is a real gain and
 * a partial one, and calling it anything more would be the kind of overclaim this repository exists to
 * catch. Recomputed with --print-key-fingerprint; `keyFingerprint` below is the ONLY definition of it.
 */
const TRUSTED_OPERATOR_PUBKEY_SHA256 = 'afea373a3cef0db436ec594c653dca371dd292dba6cc096a77b9b9aacbdaddd3'

/** The pinned fingerprint's one definition: sha256 over the LF-normalised, trimmed PEM text. */
function keyFingerprint(pem) {
  return crypto.createHash('sha256').update(cleanKey(pem), 'utf8').digest('hex')
}

/**
 * Fingerprint of the KEY ITSELF as SPKI DER, independent of PEM formatting.
 *
 * Not pinned, and not compared -- it exists so a mismatch can be DIAGNOSED. "Same key, the file was
 * re-wrapped at 76 columns" and "a different key entirely" call for different responses, and a bare
 * digest comparison cannot tell them apart.
 */
function spkiFingerprint(pem) {
  try {
    const der = crypto.createPublicKey(cleanKey(pem)).export({ type: 'spki', format: 'der' })
    return crypto.createHash('sha256').update(der).digest('hex')
  } catch (err) {
    return 'unreadable (' + (err && err.message ? err.message : err) + ')'
  }
}

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
console.log('AUDIT PASSED: every note is attributed to the pinned operator key, attached to the commit it names, and its artifacts and contracts match that commit\'s tree.')
console.log('NOTE: this proves the records present are sound. It cannot detect a record that was deleted.')
process.exit(0)
