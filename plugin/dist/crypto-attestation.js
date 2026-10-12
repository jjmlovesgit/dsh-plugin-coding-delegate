"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ATTESTATION_PAYLOAD_TYPE = exports.ATTESTATION_SPEC_VERSION = void 0;
exports.generateWorkerKeyPair = generateWorkerKeyPair;
exports.publicKeyFromPrivate = publicKeyFromPrivate;
exports.signManifest = signManifest;
exports.verifyEnvelope = verifyEnvelope;
exports.hashBuffer = hashBuffer;
exports.buildAttestationPlan = buildAttestationPlan;
const node_crypto_1 = require("node:crypto");
const canonical_json_1 = require("./canonical-json");
/**
 * Ed25519 signatures over a canonicalized delegation record.
 *
 * WHAT A SIGNATURE ESTABLISHES HERE, AND WHAT IT DOES NOT -- read this before quoting it as
 * non-repudiation. A signature binds a payload to a KEY. It says nothing about who holds that key
 * unless the key is held somewhere this process cannot reach, and as shipped `generateKeyPairSync`
 * produces both halves inside the host. So a signature proves the host signed, and a "worker"
 * signature proves the host signed on the worker's behalf: the local model never holds a key and
 * has no way to demonstrate one. That is a real upgrade over `OPERATOR_ATTESTED`, which is a
 * self-reported string with no key at all, but it is key-attributed TAMPER-EVIDENCE rather than
 * third-party non-repudiation. The README states the same limit where it describes the verdict, and
 * this module must not be quoted against it. Closing the gap needs the private key to live under the
 * operator's sole control -- a hardware token or an OS keystore they unlock -- not a file this
 * process can read.
 *
 * WHY THE MEDIA TYPE IS NOT in-toto. in-toto defines a Statement structure (`_type`, `subject`,
 * `predicateType`, `predicate`) and its media type is how a consumer decides to parse for it.
 * Labelling this payload `application/vnd.in-toto+json` would send a consumer looking for fields
 * that are not there. A vendor media type says what the document actually is.
 */
exports.ATTESTATION_SPEC_VERSION = '1.0';
/**
 * A vendor media type, deliberately: see the note above. It names the shape, so a consumer that
 * dispatches on it reads `payload` as canonical JSON and `signature` as base64 Ed25519.
 */
exports.ATTESTATION_PAYLOAD_TYPE = 'application/vnd.dsh-delegation-attestation+json';
/**
 * Generate an Ed25519 key pair in SPKI/PKCS#8 PEM.
 *
 * The private key comes back as a plaintext string because that is what `crypto.sign` accepts; where
 * it is written is the caller's problem, and it is the whole of this scheme's security. See the
 * module note: a key this process can read is a key this process can sign with.
 */
function generateWorkerKeyPair() {
    const { publicKey, privateKey } = (0, node_crypto_1.generateKeyPairSync)('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKeyPem: String(publicKey), privateKeyPem: String(privateKey) };
}
/**
 * Derive the SPKI public key from a PKCS#8 private key.
 *
 * This exists so an operator provisions ONE secret rather than a matched pair. Two files that must
 * agree is a configuration that can be wrong silently: sign with one, publish the other, and every
 * verification fails for a reason indistinguishable from tampering.
 */
function publicKeyFromPrivate(privateKeyPem) {
    return String((0, node_crypto_1.createPublicKey)(privateKeyPem).export({ type: 'spki', format: 'pem' }));
}
/**
 * Canonicalize the payload and sign it.
 *
 * `algorithm` is null because Ed25519 does not take a digest parameter -- it hashes internally, and
 * passing a digest name is an error rather than an optimization.
 */
function signManifest(payload, privateKeyPem, publicKeyPem) {
    const canonical = (0, canonical_json_1.canonicalizeJson)(payload);
    const signature = (0, node_crypto_1.sign)(null, Buffer.from(canonical, 'utf8'), privateKeyPem);
    return {
        payload: canonical,
        payloadType: exports.ATTESTATION_PAYLOAD_TYPE,
        signature: signature.toString('base64'),
        publicKeyPem,
    };
}
/**
 * Verify an envelope over the exact bytes of its own `payload`.
 *
 * WHAT THIS DOES NOT CHECK, stated because a caller will assume it does: the payload is verified as
 * bytes, so this proves the bytes were signed by the holder of `publicKeyPem` and that nothing in
 * them changed. It does NOT establish that `publicKeyPem` is the key it claims to be, that the
 * payload describes work anyone actually did, or that the commit and hashes inside it are true. A
 * signature is evidence of integrity, never of honesty.
 *
 * Returns false rather than throwing on a malformed key or a truncated signature: the contract is
 * boolean, and a verifier that raised where its callers expect a value would be a trap.
 */
function verifyEnvelope(envelope) {
    try {
        return (0, node_crypto_1.verify)(null, Buffer.from(envelope.payload, 'utf8'), envelope.publicKeyPem, Buffer.from(envelope.signature, 'base64'));
    }
    catch {
        return false;
    }
}
/** sha256, lowercase hex. The digest form the registry already uses for file content. */
function hashBuffer(buffer) {
    return (0, node_crypto_1.createHash)('sha256').update(buffer).digest('hex');
}
function buildAttestationPlan(input) {
    if (!input.privateKeyPath)
        return { action: 'none' };
    if (!input.privateKeyReadable) {
        return {
            action: 'withheld',
            reason: 'the attestation private key at ' +
                input.privateKeyPath +
                ' could not be read, so nothing was signed.',
        };
    }
    if (!input.baseCommit || !input.baseCommit.trim()) {
        return {
            action: 'withheld',
            reason: 'the workspace is not on a readable git commit, so the record would have no tree to ' +
                'anchor to. Nothing was signed.',
        };
    }
    if (!input.verification.executed) {
        return {
            action: 'withheld',
            reason: 'no verification process ran for this unit, so there is no checked contract to attest to. ' +
                'A record of an unchecked delegation is a claim about nothing. Nothing was signed.',
        };
    }
    // Sorted here rather than by the caller: the digest must not depend on the order a caller happened
    // to build the list in, and that is a property worth holding inside the pure function.
    const contracts = [...input.contracts].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    return {
        action: 'sign',
        payload: {
            specVersion: '1.0',
            runId: input.runId,
            contractHash: hashBuffer((0, canonical_json_1.canonicalizeJson)(contracts)),
            baseCommit: input.baseCommit,
            modelIdentifier: input.modelIdentifier,
            artifacts: input.artifacts.map((artifact) => ({
                path: artifact.path,
                // An unreadable artifact becomes an empty string rather than being dropped: the record must
                // still name the file the unit wrote, even when its bytes could not be hashed.
                sha256: artifact.sha256 ?? '',
            })),
            verification: {
                command: input.verification.command,
                // `-1` means "no status was observed", and it is carried rather than coerced. Defaulting it
                // to 0 would record a clean exit no process returned.
                exitCode: input.verification.exitCode ?? -1,
                stdoutHash: hashBuffer(input.verification.output),
                passed: input.verification.failed === 0,
            },
        },
    };
}
