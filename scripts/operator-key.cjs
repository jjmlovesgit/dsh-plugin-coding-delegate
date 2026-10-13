'use strict'
/**
 * The operator trust root, defined exactly once.
 *
 * WHY THIS IS A MODULE AND NOT A CONSTANT IN EACH SCRIPT. The ledger audit and the signer must agree on
 * which key is the operator's, and the only way they cannot drift is to have one definition. Two copies
 * of a 64-character digest is the failure this repository has already paid for twice -- a policy rule
 * counted differently in two READMEs, and a contract check implemented inline in CI as well as in a
 * script. The rot is silent in both directions here: a signer holding a stale digest refuses good keys,
 * and a signer holding a digest the auditor does not recognise produces records the audit REJECTS at
 * check time, after the work is done and the note is on the ref.
 *
 * WHAT THE PIN BUYS AND WHAT IT DOES NOT. Resolving the operator key from the repository is what makes
 * the audit runnable in CI without a secret; the cost is that the file defining trust lives inside the
 * verified tree, so a writer could replace the key and then author notes that satisfy it. The digest
 * raises that from a one-file substitution to an edit that appears in a reviewed diff AS a change to the
 * trust root. It does NOT create an out-of-band root of trust: whoever can edit this file can edit the
 * constant. An actual root of trust has to come from outside the repository, which nothing in here can
 * supply for itself.
 *
 * KEY ROTATION. A changed key fails every run, in the signer and in the auditor, until the constant is
 * updated deliberately. To rotate: publish the new public key, read the new value from
 * `node scripts/verify-delegation-ledger.cjs --print-key-fingerprint`, change
 * TRUSTED_OPERATOR_PUBKEY_SHA256 in the SAME commit that changes the key, and sign a note for that
 * commit so the rotation is itself an attested record. Do not update the constant to silence a failure
 * whose cause has not been established.
 */
const crypto = require('node:crypto')

/**
 * SHA-256 of the operator public key, over the LF-normalised, trimmed PEM text.
 *
 * Over the PEM TEXT rather than the DER, so it can be reproduced from the file git stores. The
 * consequence to know about: reformatting the PEM without changing the key changes this digest, so the
 * committed formatting is part of what is pinned. `spkiFingerprint` exists to tell those two cases apart
 * when a mismatch is reported.
 */
const TRUSTED_OPERATOR_PUBKEY_SHA256 = 'afea373a3cef0db436ec594c653dca371dd292dba6cc096a77b9b9aacbdaddd3'

/**
 * Canonicalise a PEM before it is compared or consumed: CRLF and lone CR become LF, then trim.
 *
 * THE CRYPTO LAYER ALREADY TOLERATES CRLF -- measured: `verifyEnvelope`, `publicKeyFromPrivate` and
 * `crypto.sign` all accept a CRLF PEM and behave identically to LF -- so the only thing CRLF breaks is
 * STRING EQUALITY, which is exactly how the pin is enforced. Without this, a CRLF checkout of the pin
 * made the audit refuse to run while asserting that two copies of ONE key "disagree" and that one was
 * stale. `\r\n?` rather than `\r\n` so a lone CR is normalised too.
 */
const cleanKey = (keyStr) => String(keyStr).replace(/\r\n?/g, '\n').trim()

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

module.exports = {
  TRUSTED_OPERATOR_PUBKEY_SHA256,
  cleanKey,
  keyFingerprint,
  spkiFingerprint,
}
