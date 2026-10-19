#!/usr/bin/env node
/**
 * Exhaustive attestation coverage for the Tier 1 tree (ADR §6, POL §7).
 *
 * WHAT THIS CLOSES, AND WHY THE EXISTING AUDIT COULD NOT. `verify-delegation-ledger.cjs` answers
 * "is every note I can see sound?". It cannot answer "is every primitive attested?", because a note
 * that was never written looks exactly like a primitive that never needed one -- its own output says
 * so: "this proves the records present are sound. It cannot detect a record that was deleted." So a
 * commit made with `--no-verify`, or on a clone without `core.hooksPath`, would land an unattested
 * `tools/*.ts` and CI would go green. This gate walks HEAD instead of walking the ledger.
 *
 * COVERAGE IS CONTENT-ADDRESSED, NOT COMMIT-IDENTIFIED. The invariant is "some note records this
 * path with this SHA-256", not "the last commit that touched this file carries a note". The second
 * formulation breaks on any later commit that touches the file (a formatting pass, a merge) and
 * silently accepts a note attached to a commit whose tree has since moved. Digest equality is true
 * exactly when the bytes an operator reviewed are the bytes that are there now, and it survives
 * rebase, squash and amend.
 *
 * THE BASELINE IS A RATCHET, AND IT IS KEYED BY DIGEST RATHER THAN BY PATH. Introducing this gate on
 * 2026-10-18 found seven primitives whose bytes had drifted after sealing -- `9595ccf` appended a
 * missing newline to seven files, one byte each, which is enough to invalidate a content digest. They
 * are grandfathered so the gate can be adopted without a red build, but a grandfathered entry names
 * an EXACT digest: any subsequent edit changes the digest, stops matching, and must be attested. The
 * file only shrinks, and `--write-baseline` exists to record the initial state once, deliberately.
 *
 * SIGNATURE CHECKING IS DELEGATED, DELIBERATELY. `verifyEnvelope` from the shipped plugin verifies
 * each covering note's Ed25519 signature against the key the envelope carries, which rejects a
 * tampered payload. Trust in that key is pinned by `verify-delegation-ledger.cjs`, which the gate
 * runs immediately before this one; re-implementing the pin here would be a second opinion about the
 * trust root, and two opinions is how they drift apart.
 *
 * Usage: node scripts/verify-tree-attestations.cjs [--write-baseline]
 * Exit 0 when every Tier 1 primitive at HEAD is covered or grandfathered, 1 otherwise.
 */
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { loadPolicyConfig } = require('./policy-config.cjs')
const { verifyEnvelope } = require('../plugin/dist/crypto-attestation.js')

const REPO_ROOT = path.resolve(__dirname, '..')
const BASELINE_PATH = path.join(__dirname, 'attestation-baseline.json')
const { config } = loadPolicyConfig(REPO_ROOT)
const TIER1 = new RegExp(config.tiers.corePrimitives.contractGoverned)

/** Run git and return stdout as text, or null when the command failed. */
function gitText(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  return result.error || result.status !== 0 ? null : result.stdout
}

/** Run git and return stdout as raw bytes, for digesting. */
function gitBuffer(args) {
  const result = spawnSync('git', args, { cwd: REPO_ROOT, maxBuffer: 64 * 1024 * 1024 })
  return result.error || result.status !== 0 ? null : result.stdout
}

/** Every contract-governed primitive in HEAD, or null when the tree cannot be read. */
function tier1AtHead() {
  const listing = gitText(['ls-tree', '-r', '--name-only', 'HEAD'])
  if (listing === null) return null
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => TIER1.test(file))
}

/** The SHA-256 of a file's bytes at HEAD -- the digest the attestation records. */
function sha256AtHead(file) {
  const blob = gitBuffer(['cat-file', 'blob', 'HEAD:' + file])
  return blob === null ? null : crypto.createHash('sha256').update(blob).digest('hex')
}

/** Every ledger note, parsed. A corrupt note is skipped: the audit is what reports those. */
function readNotes() {
  const listing = gitText(['notes', '--ref', config.ledgerRef, 'list'])
  if (!listing) return []
  const notes = []
  for (const line of listing.split('\n').filter(Boolean)) {
    const commit = line.trim().split(/\s+/)[1]
    const raw = gitText(['notes', '--ref', config.ledgerRef, 'show', commit])
    if (!raw) continue
    try {
      const envelope = JSON.parse(raw)
      notes.push({ commit, envelope, payload: JSON.parse(envelope.payload) })
    } catch {
      /* the audit reports a note it cannot parse; coverage simply does not count it */
    }
  }
  return notes
}

function covers(note, file, sha256) {
  const artifacts = note.payload && note.payload.artifacts
  return Array.isArray(artifacts) && artifacts.some((a) => a && a.path === file && a.sha256 === sha256)
}

function readBaseline() {
  try {
    const parsed = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'))
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

/** Classify one primitive at HEAD. */
function assess(file, notes, baseline) {
  const sha256 = sha256AtHead(file)
  if (!sha256) return { file, sha256: null, state: 'unreadable' }
  const covering = notes.find((note) => covers(note, file, sha256))
  if (covering && verifyEnvelope(covering.envelope)) return { file, sha256, state: 'attested', covering }
  if (covering) return { file, sha256, state: 'bad-signature', covering }
  const known = baseline.some((entry) => entry.path === file && entry.sha256 === sha256)
  return { file, sha256, state: known ? 'grandfathered' : 'missing' }
}

function report(result) {
  if (result.state === 'attested') {
    const reviewer = result.covering.payload.reviewer && result.covering.payload.reviewer.identity
    const provenance = reviewer ? 'reviewed by ' + reviewer : 'spec ' + (result.covering.payload.specVersion || '?') + ', no reviewer block'
    console.log('  ok           ' + result.file + ' <- ' + result.covering.commit.slice(0, 7) + ' (' + provenance + ')')
  } else if (result.state === 'grandfathered') {
    console.log('  grandfathered ' + result.file + ' (digest unchanged since the baseline; any edit must be attested)')
  } else if (result.state === 'bad-signature') {
    console.error('  FAIL         ' + result.file + ': the covering note signature does not verify')
  } else if (result.state === 'unreadable') {
    console.error('  FAIL         ' + result.file + ': cannot read the HEAD blob')
  } else {
    console.error('  MISSING      ' + result.file + ': no note records sha256 ' + String(result.sha256).slice(0, 12) + '...')
  }
}

function writeBaseline(results) {
  const entries = results
    .filter((r) => r.state === 'missing' && r.sha256)
    .map((r) => ({ path: r.file, sha256: r.sha256 }))
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(entries, null, 2) + '\n')
  console.log('\nwrote ' + entries.length + ' grandfathered entr(ies) to ' + path.basename(BASELINE_PATH) + '.')
  console.log('Review and commit it; the list must only shrink.')
}

function main() {
  const files = tier1AtHead()
  if (files === null) {
    console.error('FATAL [GIT_TREE]: cannot read the HEAD tree')
    process.exit(1)
  }
  const notes = readNotes()
  const baseline = readBaseline()
  console.log('=== tree attestation coverage (' + files.length + ' primitive(s) at HEAD, ' + notes.length + ' note(s)) ===')
  const results = files.map((file) => assess(file, notes, baseline))
  results.forEach(report)

  if (process.argv.includes('--write-baseline')) {
    writeBaseline(results)
    process.exit(0)
  }

  const failed = results.filter((r) => r.state === 'missing' || r.state === 'bad-signature' || r.state === 'unreadable')
  if (failed.length > 0) {
    console.error('')
    console.error(
      failed.length + ' Tier 1 primitive(s) are not covered by a signed delegation note. This is the ' +
        'state a --no-verify commit or an unconfigured clone produces.'
    )
    console.error('Produce the unit with: npm run delegate:unit -- --target <path> --contract <path> --mutant <path>')
    process.exit(1)
  }
  console.log('All ' + files.length + ' Tier 1 primitive(s) at HEAD are covered or grandfathered.')
}

main()
