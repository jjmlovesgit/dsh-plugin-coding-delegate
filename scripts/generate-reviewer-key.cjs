#!/usr/bin/env node
/**
 * Provision the reviewer keypair for attestation spec 1.2.
 *
 * Run ONCE, by the operator, on the machine that will sign reviews. It is deliberately not part of
 * `npm run gate` and must never run in CI: it generates a private key, and a private key that a
 * pipeline can generate is a private key a pipeline can leak.
 *
 * WHERE THE FINGERPRINT COMES FROM, and why not from the DER. The plan this implements said "first 8 hex
 * of the SHA-256 of the SPKI DER, matching how delegation-operator.pub derives afea373a". That is not how
 * afea373a was derived: `TRUSTED_OPERATOR_PUBKEY_SHA256` is the digest of the LF-NORMALISED PEM TEXT, and
 * the operator key's SPKI digest is a different value entirely (d8f04ff3... for the same key). Deriving
 * the reviewer's fingerprint the other way would leave the two keys' fingerprints computed by two
 * different rules -- and the auditor compares them for key independence, so the drift would sit directly
 * in a security check. Both fingerprints therefore come from `keyFingerprint` in ./operator-key.cjs,
 * which is the one definition this repository has.
 *
 * The private key is written outside the repository, mode 0600. That mode is a no-op on Windows, where
 * Node cannot set an ACL: on this host the protection is the profile directory's own permissions, and the
 * operator should confirm them rather than assume the flag did something.
 *
 * Usage: node scripts/generate-reviewer-key.cjs [--rotate]
 *   --rotate   overwrite an existing committed public key whose value differs
 */
'use strict'

const crypto = require('node:crypto')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { keyFingerprint, cleanKey, spkiFingerprint } = require('./operator-key.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const KEY_DIR = path.join(os.homedir(), '.dsh', 'keys')
const PRIVATE_KEY_PATH = path.join(KEY_DIR, 'delegation-reviewer.pem')
const REPO_PUBLIC_KEY_PATH = path.join(REPO_ROOT, 'keys', 'delegation-reviewer.pub')
const OPERATOR_PIN_PATH = path.join(REPO_ROOT, 'keys', 'delegation-operator.pub')

const rotate = process.argv.slice(2).includes('--rotate')
const unknown = process.argv.slice(2).filter((a) => a !== '--rotate')
if (unknown.length > 0) {
  console.error('usage: node scripts/generate-reviewer-key.cjs [--rotate]')
  console.error('unrecognised argument(s): ' + unknown.join(', '))
  process.exit(2)
}

fs.mkdirSync(KEY_DIR, { recursive: true, mode: 0o700 })

let privateKeyPem
if (fs.existsSync(PRIVATE_KEY_PATH)) {
  // Never clobber a signing key that already exists: a reviewer signature made with it may already be on
  // a published note, and re-generating would silently orphan that record.
  privateKeyPem = fs.readFileSync(PRIVATE_KEY_PATH, 'utf8')
  console.log('[KEYGEN] using the existing private key at ' + PRIVATE_KEY_PATH)
} else {
  const pair = crypto.generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  privateKeyPem = pair.privateKey
  fs.writeFileSync(PRIVATE_KEY_PATH, pair.privateKey, { encoding: 'utf8', mode: 0o600 })
  console.log('[KEYGEN] wrote private key: ' + PRIVATE_KEY_PATH)
}

// The public key is DERIVED from the private key rather than read back from the repository, so a stale or
// hand-edited committed .pub cannot be mistaken for the key that will actually sign.
const derivedPublicKeyPem = cleanKey(String(crypto.createPublicKey(privateKeyPem).export({ type: 'spki', format: 'pem' })))
const fingerprint = keyFingerprint(derivedPublicKeyPem)

if (fs.existsSync(REPO_PUBLIC_KEY_PATH)) {
  const existing = cleanKey(fs.readFileSync(REPO_PUBLIC_KEY_PATH, 'utf8'))
  if (existing !== derivedPublicKeyPem) {
    if (!rotate) {
      console.error(
        'REFUSING to replace an existing keys/delegation-reviewer.pub whose value differs.\n' +
          '  committed : ' + keyFingerprint(existing) + '\n' +
          '  derived   : ' + fingerprint + '\n' +
          'That is a trust-root change, and it belongs in a reviewed commit rather than in a keygen run.\n' +
          'Re-run with --rotate if the rotation is intended, and record it in the same commit.'
      )
      process.exit(1)
    }
    console.warn('[KEYGEN] ROTATING keys/delegation-reviewer.pub; this changes the trust root and belongs in a reviewed commit')
  }
}
fs.writeFileSync(REPO_PUBLIC_KEY_PATH, derivedPublicKeyPem.endsWith('\n') ? derivedPublicKeyPem : derivedPublicKeyPem + '\n', 'utf8')

// The independence check is the whole point of a second signature, so it is asserted here rather than
// left to the audit to discover: a reviewer key equal to the operator key would sign its own work.
if (fs.existsSync(OPERATOR_PIN_PATH)) {
  const operatorFingerprint = keyFingerprint(fs.readFileSync(OPERATOR_PIN_PATH, 'utf8'))
  if (operatorFingerprint === fingerprint) {
    console.error(
      'REFUSING: the generated reviewer key is the OPERATOR key (' + fingerprint + '), so a review would\n' +
        'approve the worker\'s own output. A reviewer key must be a different principal.'
    )
    process.exit(1)
  }
  console.log('[KEYGEN] independent from the operator key (' + operatorFingerprint + ')')
}

console.log('')
console.log('[KEYGEN] wrote public key : keys/delegation-reviewer.pub')
console.log('[KEYGEN] reviewer fingerprint (PEM sha256, first 8): ' + fingerprint.slice(0, 8))
console.log('[KEYGEN] full fingerprint                          : ' + fingerprint)
console.log('[KEYGEN] spki sha256 (diagnostic, not the pin)    : ' + spkiFingerprint(derivedPublicKeyPem))
console.log('')
console.log('Out-of-band pinning for CI -- preferred, and the only form that makes the reviewer independent:')
console.log('  DSH_REVIEWER_FINGERPRINT=' + fingerprint)
console.log('Without it the audit falls back to keys/delegation-reviewer.pub and says so in its own output.')
