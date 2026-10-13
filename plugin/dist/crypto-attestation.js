"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ATTESTATION_PAYLOAD_TYPE = exports.ATTESTATION_SPEC_VERSION = void 0;
exports.generateWorkerKeyPair = generateWorkerKeyPair;
exports.publicKeyFromPrivate = publicKeyFromPrivate;
exports.signManifest = signManifest;
exports.verifyEnvelope = verifyEnvelope;
exports.hashBuffer = hashBuffer;
exports.normalizePosixPath = normalizePosixPath;
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
/**
 * 1.1 records the contract SET, not only its digest.
 *
 * The 1.0 payload carried `contractHash` alone: a digest over an array of {path, sha256} pairs that the
 * document never contained. That made it a BLIND COMMITMENT, recomputable only by knowing the input
 * from outside, and the ledger audit found a real record it could not reconstruct at all. 1.1 carries
 * the array beside the digest, so a reader recomputes the hash from the document itself and checks
 * every contract against disk without guessing a path convention.
 *
 * Additive, so a 1.0 payload remains valid and self-verifying -- a signature covers its own bytes, and
 * nothing re-signs an old record. Only the readers are version-aware.
 */
exports.ATTESTATION_SPEC_VERSION = '1.1';
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
/**
 * POSIX-normalise a path for digesting.
 *
 * The contract digest must not depend on which platform produced it. `path.relative` and `path.join`
 * yield backslashes on Windows and forward slashes everywhere else, so the SAME contract -- same bytes,
 * same relative location -- digested to two different values, and a verifier could not recompute a note
 * signed on the other platform. Measured in this repository's own ledger: two notes recorded the same
 * relative contract as `tests\contracts\json-canonical-merge.contract.cjs` and
 * `tests/contracts/priority-queue.contract.cjs`, and only one of them recomputed.
 *
 * Applied to artifacts as well, so the signed payload reads the same on any host. Note that this makes
 * the two strings COMPARABLE; it does not make them resolvable. A POSIX-normalised path is a record,
 * not a filesystem path, and nothing should hand it back to `fs`.
 */
function normalizePosixPath(p) {
    return p.replace(/\\/g, '/');
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
    // THE ANCHOR HAS TO BE THE COMMIT THE WORK WAS WRITTEN AGAINST, and nothing else in this function can
    // tell whether it is. `baseCommit` is READ from git, so it is always a real commit and always an
    // ancestor of main -- the ledger audit's checks all pass on it -- which is exactly why a `baseCommit`
    // read at the wrong MOMENT is invisible downstream. It was read after the unit's verification and the
    // project's coherence check had both run, so a command that commits, checks out or stashes moved the
    // anchor underneath the record and the resulting envelope named a commit the unit's files were never
    // written against. Recorded here as a refusal for the same reason the gates below refuse: a record that
    // is precisely wrong is worse than no record, because it verifies.
    if (input.headObserved && input.headObserved.before !== input.headObserved.after) {
        const show = (commit) => (commit ? commit.slice(0, 8) : '(unreadable)');
        return {
            action: 'withheld',
            reason: 'HEAD_DRIFT_DETECTED: the workspace moved from ' +
                show(input.headObserved.before) +
                ' to ' +
                show(input.headObserved.after) +
                ' while this unit was being verified, so the anchor is no longer the commit the work was ' +
                'written against. A verification command that commits, checks out or stashes does this. Nothing ' +
                'was signed; re-run the unit without a command that moves HEAD.',
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
    // THE THREE GATES BELOW ARE ONE FINDING, and `executed` above was never the question they ask.
    // Measured: a delegation whose write was REFUSED still produced a signed envelope reading
    // `"artifacts":[],"verification":{"exitCode":0,"passed":true}`, because the verification command ran
    // against the tree a previous run had already committed and exited 0 over nothing. Every field in it
    // was true and the record was worthless, and nothing downstream could tell it from a verified change.
    // What was missing was not "did a process run" but "did this unit succeed, and did it produce
    // anything" -- so those are asked explicitly, and each one refuses rather than qualifying.
    if (input.status !== 'SUCCESS') {
        return {
            action: 'withheld',
            reason: 'the unit did not succeed (status ' +
                input.status +
                '), so an envelope would attest work that did not land. Nothing was signed.',
        };
    }
    if (input.artifacts.length === 0) {
        return {
            action: 'withheld',
            reason: 'the unit wrote no artifacts, so a record would attest a passing verification over nothing, ' +
                'and a green envelope with an empty artifact list cannot be told from a verified change. ' +
                'Nothing was signed.',
        };
    }
    // AN UNHASHABLE ARTIFACT IS NOT A QUALIFIED ARTIFACT. This gate used to be absent, and the payload
    // below wrote an empty string for a digest it could not read, on the reasoning that the record must
    // still name the file the unit wrote. Naming it is right; naming it with a digest that cannot be
    // checked is not a record of anything -- the ledger audit recomputes each artifact hash from the
    // anchored tree, and a missing digest can never match one. The envelope verified, carried an artifact
    // list, and was permanently unverifiable: the one shape of bad record that is indistinguishable from a
    // good one at every checkpoint except the last.
    const unhashable = input.artifacts.find((artifact) => !artifact.sha256 || !String(artifact.sha256).trim());
    if (unhashable) {
        return {
            action: 'withheld',
            reason: 'the artifact digest is unavailable for ' +
                normalizePosixPath(unhashable.path) +
                ', so nobody reading the record could check it: the audit recomputes each artifact hash from the ' +
                'anchored tree, and a missing digest can never match. A signed envelope that cannot be verified ' +
                'is worse than an absent one, because it looks like evidence. Nothing was signed.',
        };
    }
    // `verification.passed` is deliberately NOT a third gate. `resolveDelegateStatus` returns SUCCESS
    // only when the unit's own result held, and that requires `failed === 0`, so a passing verification
    // is already implied by the status above -- the condition would be a second name for the same fact.
    // It is also not what closes the measured defect: the record that shipped read `passed: true`, so the
    // vacuous green came from signing over an EMPTY ARTIFACT LIST, not from signing a failure. Gating on
    // it too would leave the payload's `passed` field unable to ever be false and its failure-path tests
    // unreachable, in exchange for no protection the two gates above do not already give.
    // Sorted here rather than by the caller: the digest must not depend on the order a caller happened
    // to build the list in, and that is a property worth holding inside the pure function.
    //
    // The comparison is by UTF-16 code unit and NOT `localeCompare`. Collation is locale- and ICU-
    // dependent -- it orders case and punctuation differently under different locales -- so a
    // locale-aware sort would reintroduce exactly the platform dependence that normalising separators
    // removes. Measured: the two agree on `["a-b", "a/b"]` but disagree on case, with code-unit ordering
    // `[B, a-b, a/b, b]` against `localeCompare`'s `[a-b, a/b, b, B]`.
    const contracts = input.contracts
        .map((c) => ({ path: normalizePosixPath(c.path), sha256: c.sha256 }))
        .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    return {
        action: 'sign',
        payload: {
            specVersion: exports.ATTESTATION_SPEC_VERSION,
            runId: input.runId,
            contractHash: hashBuffer((0, canonical_json_1.canonicalizeJson)(contracts)),
            // The array the digest was taken over, so the commitment is no longer blind. `contracts` is the
            // already-normalised, already-sorted value that was hashed on the line above; recording a
            // separately-built copy would let a reader recompute a different value from the same document.
            contracts,
            baseCommit: input.baseCommit,
            modelIdentifier: input.modelIdentifier,
            // Normalised, and deliberately NOT sorted. Emission order is a property of the run rather than of
            // the platform, so reordering here would rewrite every payload for no portability gain. Contracts
            // are sorted because their order is an accident of how the caller assembled the list; an artifact
            // list is the order the unit actually wrote its files.
            artifacts: input.artifacts.map((artifact) => ({
                path: normalizePosixPath(artifact.path),
                // NON-NULL BY THE GATE ABOVE, asserted rather than defaulted. This read `artifact.sha256 ?? ''`,
                // and that fallback is the whole of the defect the gate exists to close: it produced a
                // structurally valid envelope whose artifact hash could never match anything, because the audit
                // recomputes the digest from the anchored tree. The assertion is deliberate -- if the gate is ever
                // removed, this should fail to compile rather than quietly resume writing empty digests.
                sha256: artifact.sha256,
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
