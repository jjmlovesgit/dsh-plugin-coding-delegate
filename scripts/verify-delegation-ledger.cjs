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
 *      operator".
 *
 *   2. baseCommit IS AN ANCESTOR OF main. A record anchored to a commit that is not in the branch
 *      attests a tree nobody can check out.
 *
 *   3. ARTIFACTS MATCH DISK. The paths ARE recorded in the envelope, so this is a complete check.
 *
 *   4. contractHash BY CONVENTION -- and this one is deliberately allowed to come back UNVERIFIABLE.
 *
 * WHY CHECK 4 IS NOT A FAILURE WHEN IT CANNOT RUN. The envelope records `contractHash`, a digest over
 * an array of `{path, sha256}` pairs, and it does NOT record the array. So the digest is a blind
 * commitment: it can be recomputed only if the contract set is known from outside. For recent notes
 * that works by convention -- one contract at `tests/contracts/<artifact-base>.contract.cjs` -- and for
 * the legacy note on de64c778 it does not, because that unit's contract lives at
 * `tests/currency.contract.cjs` and the array fed to the signer is not recoverable. Failing the ledger
 * for a schema omission would bury real tampering behind an input set nobody can reconstruct. So a
 * divergence on a RECONSTRUCTED set is a failure, and an unreconstructable set is reported as
 * UNVERIFIABLE and left visible in the summary.
 *
 * WHAT THIS CANNOT DO, stated because a green audit invites over-reading. It proves the notes PRESENT
 * are sound. It cannot prove none were REMOVED: `git notes` writes a ref any writer can rewrite, and
 * the module that stores them says so in its own header. Detecting a deletion needs a WORM sink or a
 * transparency log, not a git ref.
 *
 * Usage: node scripts/verify-delegation-ledger.cjs
 * Exit 0 when every note passes its critical checks, 1 otherwise.
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

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex')

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

  if (fs.existsSync(REPO_PINNED_KEY_PATH)) {
    sources.push({
      label: 'keys/delegation-operator.pub',
      pem: fs.readFileSync(REPO_PINNED_KEY_PATH, 'utf8').trim(),
    })
  }
  if (fs.existsSync(PUBLIC_KEY_PATH)) {
    sources.push({
      label: '~/.dsh/keys/delegation_ed25519.pub',
      pem: fs.readFileSync(PUBLIC_KEY_PATH, 'utf8').trim(),
    })
  }
  if (fs.existsSync(PRIVATE_KEY_PATH)) {
    sources.push({
      label: '~/.dsh/keys/delegation_ed25519.pem (derived)',
      pem: String(publicKeyFromPrivate(fs.readFileSync(PRIVATE_KEY_PATH, 'utf8'))).trim(),
    })
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

  const agreement = sources.length > 1 ? ' (agrees with ' + sources.slice(1).map((s) => s.label).join(', ') + ')' : ''
  console.log('pinned key: ' + primary.label + agreement + '\n')
  return primary.pem
}

function git(args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' })
}

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
  console.warn(
    'WARN  ' + NOTES_REF + ' carries no notes. That is a legitimate state before the first ' +
      'delegation, and this audit cannot distinguish it from every record having been deleted.'
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
  const embeddedKey = String(envelope.publicKeyPem || '').trim()
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

  // ---- 2. baseCommit is an ancestor of main -------------------------------
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

  // ---- 3. artifacts match disk -------------------------------------------
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : []
  let artifactsOk = artifacts.length > 0
  if (artifacts.length === 0) {
    fail('the envelope names no artifacts, so there is nothing to check on disk')
  }
  for (const artifact of artifacts) {
    const onDisk = path.resolve(REPO_ROOT, artifact.path)
    if (!fs.existsSync(onDisk)) {
      fail('artifact missing on disk: ' + artifact.path)
      artifactsOk = false
      continue
    }
    const actual = hashBuffer(fs.readFileSync(onDisk))
    if (actual !== artifact.sha256) {
      fail('artifact sha256 mismatch on ' + artifact.path + ': disk=' + actual + ' note=' + artifact.sha256)
      artifactsOk = false
    }
    if (artifact.path.includes('\\')) {
      console.warn('  warn  artifact path is recorded with backslashes (' + artifact.path + '); it predates POSIX normalisation')
    }
  }
  if (artifactsOk) console.log('  ok    ' + artifacts.length + ' artifact(s) match on-disk bytes')

  // ---- 4. contractHash: self-described from 1.1, by convention for 1.0 ----------
  let contractResult = 'UNVERIFIABLE'
  const cmp = (a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)

  if (Array.isArray(payload.contracts)) {
    // SELF-DESCRIBING. The document carries the set its digest was taken over, so every contract is
    // checked against disk and the digest is reproduced from the document itself -- no convention, no
    // guessing, and a multi-contract unit is covered as well as a single-contract one.
    const recorded = payload.contracts.map((c) => ({ path: String(c.path), sha256: c.sha256 }))
    const sortedSame = JSON.stringify(recorded) === JSON.stringify([...recorded].sort(cmp))
    let allOnDisk = true

    if (recorded.length === 0) {
      fail('the payload carries an empty contracts array, so contractHash commits to nothing')
      allOnDisk = false
    }
    for (const contract of recorded) {
      if (contract.path.includes('\\')) {
        console.warn('  warn  recorded contract path is not POSIX: ' + contract.path)
      }
      const onDisk = path.resolve(REPO_ROOT, contract.path)
      if (!fs.existsSync(onDisk)) {
        fail('recorded contract missing on disk: ' + contract.path)
        allOnDisk = false
        continue
      }
      const actual = hashBuffer(fs.readFileSync(onDisk))
      if (actual !== contract.sha256) {
        fail(
          'recorded contract sha256 mismatch on ' + contract.path + ': disk=' + actual + ' note=' +
            contract.sha256
        )
        allOnDisk = false
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
    } else if (allOnDisk && sortedSame) {
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
      const candidateAbs = path.join(REPO_ROOT, candidateRel)
      if (!fs.existsSync(candidateAbs)) {
        console.log('  --    contractHash not recomputed: ' + candidateRel + ' does not exist')
      } else {
        // Sorted the way buildAttestationPlan sorted it, so the reconstruction is the signer's own.
        const contracts = [
          { path: normalizePosixPath(candidateRel), sha256: hashBuffer(fs.readFileSync(candidateAbs)) },
        ].sort(cmp)
        const recomputed = hashBuffer(canonicalizeJson(contracts))
        if (recomputed === payload.contractHash) {
          contractResult = 'VERIFIED'
          console.log('  ok    contractHash recomputed by convention against ' + candidateRel)
        } else {
          contractResult = 'DIVERGED'
          fail(
            'contractHash divergence on ' + candidateRel + ': recomputed=' + recomputed + ' note=' +
              payload.contractHash + '. The contract that judged this unit is not the one on disk.'
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
console.log('AUDIT PASSED: every note is attributed to the pinned operator key, anchored to main, and its artifacts match disk.')
console.log('NOTE: this proves the records present are sound. It cannot detect a record that was deleted.')
process.exit(0)
