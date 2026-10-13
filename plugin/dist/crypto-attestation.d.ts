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
export declare const ATTESTATION_SPEC_VERSION = "1.1";
/**
 * A vendor media type, deliberately: see the note above. It names the shape, so a consumer that
 * dispatches on it reads `payload` as canonical JSON and `signature` as base64 Ed25519.
 */
export declare const ATTESTATION_PAYLOAD_TYPE = "application/vnd.dsh-delegation-attestation+json";
/**
 * The record a delegation signs. Every field is already available at the point a unit resolves, so
 * signing adds no new bookkeeping to the delegation path.
 */
export interface AttestationPayload {
    /** Tied to the constant rather than repeated, so the two cannot drift apart. */
    specVersion: typeof ATTESTATION_SPEC_VERSION;
    runId: string;
    /** sha256 of the contract that judged the unit -- what "verified" is a verdict ABOUT. */
    contractHash: string;
    /**
     * The set that `contractHash` is taken over. Present from 1.1. Absent from a 1.0 payload, where the
     * digest is recomputable only if the reader already knows the input from outside.
     */
    contracts: AttestationContractRef[];
    /** The commit the unit started from, so the record can be replayed against a tree. */
    baseCommit: string;
    modelIdentifier: string;
    artifacts: Array<{
        path: string;
        sha256: string;
    }>;
    verification: {
        command: string;
        exitCode: number;
        stdoutHash: string;
        passed: boolean;
    };
}
/**
 * A signed payload as it travels. `payload` is the CANONICAL serialization, not the original object,
 * and the signature is over the UTF-8 bytes of that string. A verifier therefore checks the carried
 * bytes directly and re-serializes nothing, which is what keeps a signature check clear of
 * canonicalization disagreement. Comparing two records is the operation that needs a canonicalizer;
 * checking one is not.
 */
export interface SignedEnvelope {
    payload: string;
    payloadType: string;
    /** Base64 Ed25519 signature over the UTF-8 bytes of `payload`. */
    signature: string;
    /** SPKI PEM. Carried alongside so a verifier needs no key registry to check one envelope. */
    publicKeyPem: string;
}
export interface WorkerKeyPair {
    publicKeyPem: string;
    privateKeyPem: string;
}
/**
 * Generate an Ed25519 key pair in SPKI/PKCS#8 PEM.
 *
 * The private key comes back as a plaintext string because that is what `crypto.sign` accepts; where
 * it is written is the caller's problem, and it is the whole of this scheme's security. See the
 * module note: a key this process can read is a key this process can sign with.
 */
export declare function generateWorkerKeyPair(): WorkerKeyPair;
/**
 * Derive the SPKI public key from a PKCS#8 private key.
 *
 * This exists so an operator provisions ONE secret rather than a matched pair. Two files that must
 * agree is a configuration that can be wrong silently: sign with one, publish the other, and every
 * verification fails for a reason indistinguishable from tampering.
 */
export declare function publicKeyFromPrivate(privateKeyPem: string): string;
/**
 * Canonicalize the payload and sign it.
 *
 * `algorithm` is null because Ed25519 does not take a digest parameter -- it hashes internally, and
 * passing a digest name is an error rather than an optimization.
 */
export declare function signManifest(payload: AttestationPayload, privateKeyPem: string, publicKeyPem: string): SignedEnvelope;
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
export declare function verifyEnvelope(envelope: SignedEnvelope): boolean;
/** sha256, lowercase hex. The digest form the registry already uses for file content. */
export declare function hashBuffer(buffer: Buffer | string): string;
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
export declare function normalizePosixPath(p: string): string;
/** One file of the contract that judged the unit, relative to the workspace. */
export interface AttestationContractRef {
    path: string;
    sha256: string | null;
}
/** One file the unit wrote. `sha256` is read from disk by the caller, not taken from a record. */
export interface AttestationArtifactRef {
    path: string;
    sha256: string | null;
}
/**
 * Everything the decision depends on, as plain data.
 *
 * Every environment question has already been answered by the caller: the commit was read, the key
 * was read, the verification ran or did not. That is what makes the function below testable without
 * a repository, a key file or a subprocess -- the failures worth testing are otherwise the ones that
 * are hardest to arrange.
 */
export interface AttestationInputs {
    /** The operator's configured key path. Absent means the feature was never opted into. */
    privateKeyPath?: string;
    /** Whether that key was readable. Ignored when `privateKeyPath` is absent. */
    privateKeyReadable: boolean;
    runId: string;
    /** The commit the workspace is on, as READ from git. Null when it could not be read. */
    baseCommit: string | null;
    modelIdentifier: string;
    /**
     * The delegation's own outcome, as `resolveDelegateStatus` resolved it. Required rather than
     * optional, and compared against 'SUCCESS' rather than against a list of known failures: a status
     * this function has never heard of must withhold rather than sign, so the default is closed.
     */
    status: string;
    contracts: AttestationContractRef[];
    artifacts: AttestationArtifactRef[];
    verification: {
        command: string;
        /** Whether a verification process was actually attempted. */
        executed: boolean;
        /** The OBSERVED child status, or null when none was observed. Never defaulted here. */
        exitCode: number | null;
        /** The REDACTED output; the raw log stays local by design. */
        output: string;
        failed: number;
    };
}
/**
 * What to do about signing, decided as a value rather than as control flow.
 *
 * Three states, because "not opted in" and "opted in but could not attest" are different facts and
 * collapsing them would hide a misconfiguration behind a normal-looking silence:
 *
 *   none      the operator never configured a key. Nothing to report; no behaviour change.
 *   withheld  opted in, but a mandatory input did not resolve. Reported as a reason, and NOTHING is
 *             signed. An envelope anchored to a guessed commit would verify perfectly while
 *             attesting to a tree that never existed -- worse than an absent record, because it
 *             looks like a complete one.
 *   sign      every input resolved; here is the payload to sign.
 *
 * The payload is built but not signed here: signing needs the private key, and keeping key material
 * out of the decision is what lets this be tested without one.
 */
export type AttestationPlan = {
    action: 'none';
} | {
    action: 'withheld';
    reason: string;
} | {
    action: 'sign';
    payload: AttestationPayload;
};
export declare function buildAttestationPlan(input: AttestationInputs): AttestationPlan;
