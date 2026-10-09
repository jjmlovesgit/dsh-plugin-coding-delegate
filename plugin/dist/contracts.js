"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.DELEGATED_PATH_LIMIT = exports.delegatedPaths = void 0;
exports.sha256File = sha256File;
exports.resolveContractFiles = resolveContractFiles;
exports.contractFileHashes = contractFileHashes;
exports.contractViolations = contractViolations;
exports.lookupDelegatedRecord = lookupDelegatedRecord;
exports.resolveDelegatedRegistryPath = resolveDelegatedRegistryPath;
exports.parseDelegatedRegistry = parseDelegatedRegistry;
exports.mergeDelegatedRecords = mergeDelegatedRecords;
exports.pruneDelegatedRecords = pruneDelegatedRecords;
exports.saveDelegatedRegistry = saveDelegatedRegistry;
exports.loadDelegatedRegistry = loadDelegatedRegistry;
exports.rememberDelegated = rememberDelegated;
exports.recordDelegatedOutcome = recordDelegatedOutcome;
exports.recordOperatorAttestation = recordOperatorAttestation;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const logging_1 = require("./logging");
const paths_1 = require("./paths");
/**
 * sha256 of a file, or null when it cannot be read. Callers treat null as a failure rather than as
 * absence: a contract file that vanished is a violation, not an empty string.
 */
function sha256File(filePath) {
    try {
        return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    }
    catch (err) {
        return null;
    }
}
/**
 * Resolve the architect's declared contract paths against the workspace. Names only: the architect
 * never supplies contents, and the resolved list is what the worker is forbidden to write.
 */
function resolveContractFiles(files, baseDir) {
    const resolved = [];
    for (const file of files ?? []) {
        const name = String(file || '').trim();
        if (!name)
            continue;
        const full = path.isAbsolute(name) ? name : path.resolve(baseDir, name);
        if (!resolved.some((seen) => (0, paths_1.canonicalisePath)(seen) === (0, paths_1.canonicalisePath)(full))) {
            resolved.push(full);
        }
    }
    return resolved;
}
/** Keyed by canonical path so two spellings of one file cannot pass as two files. */
function contractFileHashes(paths) {
    const hashes = {};
    for (const p of paths)
        hashes[(0, paths_1.canonicalisePath)(p)] = sha256File(p);
    return hashes;
}
/**
 * Anything that changed a declared file during a unit invalidates the verdict, whatever the tests
 * then reported. A missing declaration is reported too, because failing closed is the only safe
 * reading of "the architect declared a contract file that is not there".
 */
function contractViolations(before, after) {
    const violations = [];
    for (const [key, beforeHash] of Object.entries(before)) {
        const afterHash = Object.prototype.hasOwnProperty.call(after, key) ? after[key] : null;
        if (beforeHash === null) {
            violations.push("'" + key + "' was declared as a contract file but does not exist");
        }
        else if (afterHash === null) {
            violations.push("'" + key + "' was deleted while the unit ran");
        }
        else if (afterHash !== beforeHash) {
            violations.push("'" + key + "' was modified while the unit ran");
        }
    }
    return violations;
}
/**
 * The read guard's memory of what a delegated worker wrote, and its bound.
 *
 * It is exported because the guard and the plugin's startup both add to it: a module that owns the
 * registry cannot own the set as well without an accessor for each caller, and the set is the
 * registry's state, not the guard's.
 */
exports.delegatedPaths = new Set();
exports.DELEGATED_PATH_LIMIT = 500;
/**
 * The same files as `delegatedPaths`, carrying the record so the read guard can ask what happened to a
 * file rather than only whether it was delegated at all. `indexDelegated` is its only writer: two indexes
 * updated in two places drift, and a drifted index here reads as "no verdict", which is the permissive
 * answer to the question this index exists to answer.
 *
 * It arms itself on first use because the startup loop that fills `delegatedPaths` lives in `index.ts`,
 * which is too large for the worker to rewrite -- so there is no place there to arm a second index, and a
 * lazily armed one is the difference between correct and silently empty.
 */
const delegatedRecordIndex = new Map();
let indexArmed = false;
/**
 * Refresh both indexes from a set of records. Only whole files the worker produced enter the read guard's
 * index -- a patched file is one the architect was already working on and must keep reading -- while the
 * registry itself remembers either kind.
 */
function indexDelegated(records) {
    indexArmed = true;
    for (const entry of records) {
        if (entry.mode !== 'created')
            continue;
        const key = (0, paths_1.canonicalisePath)(entry.path);
        exports.delegatedPaths.add(key);
        delegatedRecordIndex.set(key, entry);
    }
    while (exports.delegatedPaths.size > exports.DELEGATED_PATH_LIMIT) {
        const oldest = exports.delegatedPaths.values().next().value;
        if (typeof oldest !== 'string')
            break;
        exports.delegatedPaths.delete(oldest);
        delegatedRecordIndex.delete(oldest);
    }
}
/**
 * The record for a delegated file, by canonical path. `undefined` means no verdict covers it, and the
 * guard has to read that as unsettled rather than as a pass.
 */
function lookupDelegatedRecord(canonicalPath) {
    if (!indexArmed)
        indexDelegated(loadDelegatedRegistry());
    return delegatedRecordIndex.get(canonicalPath);
}
const DELEGATED_OUTCOMES = new Set([
    'UNIT_PASSED',
    'UNIT_FAILED',
    'UNIT_UNVERIFIED',
    'UNIT_FLAKY',
    'OPERATOR_ATTESTED',
]);
function resolveDelegatedRegistryPath() {
    return path.join((0, logging_1.resolveDataDir)(), 'delegated-registry.json');
}
/**
 * Parse a registry file. Anything unreadable, malformed, or entry-shaped-but-wrong yields no records
 * rather than an exception: a corrupt registry must never be able to stop the plugin loading.
 */
function parseDelegatedRegistry(text) {
    if (typeof text !== 'string' || !text.trim())
        return [];
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        return [];
    }
    const raw = parsed && Array.isArray(parsed.records) ? parsed.records : [];
    const records = [];
    for (const entry of raw) {
        if (!entry || typeof entry !== 'object')
            continue;
        const entryPath = String(entry.path ?? '').trim();
        if (!entryPath)
            continue;
        const record = {
            path: entryPath,
            sha256: typeof entry.sha256 === 'string' && entry.sha256 ? entry.sha256 : null,
            at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
            // Records written before this field existed predate the distinction, and the conservative reading
            // of an old record is the one that protects more: treat it as created.
            mode: entry.mode === 'patched' ? 'patched' : 'created',
        };
        // An unrecognised verdict is dropped rather than carried: the absence of the field means "no verdict",
        // and a value this code cannot read must never be able to relax a guard by passing for a success.
        if (DELEGATED_OUTCOMES.has(String(entry.outcome))) {
            record.outcome = entry.outcome;
            record.succeeded = entry.succeeded === true;
            if (Number.isFinite(Number(entry.verdictAt)))
                record.verdictAt = Number(entry.verdictAt);
        }
        // The attestation survives the round trip, because an attestation without its operator and evidence is
        // not an audit record -- and this parser is where a field can be silently dropped, which is how a
        // written verdict becomes an absence. Both fields are required for it to be carried: a record claiming
        // OPERATOR_ATTESTED with nobody named is exactly the unattributable stamp this verdict exists to avoid.
        const attestation = entry.attestation;
        if (attestation && typeof attestation === 'object') {
            const operator = String(attestation.operator ?? '').trim();
            const evidence = String(attestation.evidence ?? '').trim();
            if (operator && evidence) {
                record.attestation = {
                    operator,
                    evidence,
                    at: Number.isFinite(Number(attestation.at)) ? Number(attestation.at) : 0,
                };
            }
            else {
                // An unattributable attestation is not carried, and the verdict goes with it: keeping the verdict
                // while dropping the attribution would leave a record that reads as human-verified with nobody
                // accountable for it.
                delete record.outcome;
                delete record.succeeded;
            }
        }
        records.push(record);
    }
    return records;
}
/**
 * Newest wins per path, and the oldest fall off the end once the limit is reached. The hash is not
 * used to relax anything — a delegated file stays protected however it later changes — it makes the
 * record answerable, and gives the prune below something to reason about.
 */
function mergeDelegatedRecords(existing, incoming, limit = exports.DELEGATED_PATH_LIMIT) {
    // Dedup on the canonical form, so two spellings of one file cannot become two records, while the
    // record itself keeps the path as it was written.
    const byPath = new Map();
    for (const entry of [...(existing ?? []), ...(incoming ?? [])]) {
        if (!entry || !entry.path)
            continue;
        const key = (0, paths_1.canonicalisePath)(entry.path);
        const prior = byPath.get(key);
        if (!prior || entry.at >= prior.at)
            byPath.set(key, entry);
    }
    return [...byPath.values()].sort((a, b) => b.at - a.at).slice(0, Math.max(1, limit));
}
/** A path whose file is gone protects nothing, so it is dropped. */
function pruneDelegatedRecords(records, exists = (p) => fs.existsSync(p)) {
    return (records ?? []).filter((r) => r && r.path && exists(r.path));
}
/** Best effort by design: failing to persist must not fail a delegation that was already paid for. */
function saveDelegatedRegistry(records) {
    const target = resolveDelegatedRegistryPath();
    try {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const temp = target + '.tmp';
        fs.writeFileSync(temp, JSON.stringify({ version: 1, records }, null, 2), 'utf8');
        fs.renameSync(temp, target);
        return true;
    }
    catch (err) {
        console.warn('[LOCAL_GUARD] could not persist the delegated registry:', err?.message || err);
        return false;
    }
}
/** Load, validate and prune. Called at startup so a restart does not forget what was delegated. */
function loadDelegatedRegistry() {
    let text = '';
    try {
        text = fs.readFileSync(resolveDelegatedRegistryPath(), 'utf8');
    }
    catch (err) {
        return [];
    }
    return pruneDelegatedRecords(parseDelegatedRegistry(text));
}
function rememberDelegated(paths, mode = 'created') {
    const added = [];
    for (const p of paths) {
        if (typeof p !== 'string' || !p)
            continue;
        // The record keeps the path as it was written, so it stays an honest answer to "where did this
        // go?". Canonicalisation resolves symlinks — `os.tmpdir()` on Windows is a junction — so it
        // belongs in the index and the comparisons, not in the record.
        const resolved = path.resolve(p);
        added.push({ path: resolved, sha256: sha256File(resolved), at: Date.now(), mode });
    }
    if (added.length === 0)
        return;
    const merged = mergeDelegatedRecords(loadDelegatedRegistry(), added);
    saveDelegatedRegistry(merged);
    indexDelegated(merged);
}
/**
 * Stamp a unit's verdict onto the registry records for the files that unit wrote.
 *
 * A delegation writes the registry before its verification has run, so the record it creates cannot
 * carry the verdict. This is the second half of that write, and the only thing that joins a per-file
 * sha256 to a per-unit verdict -- without it "is this file settled?" has no answer, and the read guard
 * has to ask about every delegated file for ever.
 *
 * Best effort, for the same reason the first half is: failing to persist must not fail a delegation that
 * was already paid for, and an absent stamp reads as "no verdict", which is the conservative answer
 * rather than a permissive one. Returns how many records were stamped, so a caller can tell a no-op
 * from a write.
 */
function recordDelegatedOutcome(paths, outcome, succeeded, at = Date.now()) {
    if (!Array.isArray(paths) || paths.length === 0)
        return 0;
    if (!DELEGATED_OUTCOMES.has(String(outcome)))
        return 0;
    // Canonical on both sides. The registry holds absolute paths, so unlike the read guard -- which has to
    // infer a workspace before a relative target means anything -- there is no base here to get wrong.
    const wanted = new Set();
    for (const p of paths) {
        if (typeof p === 'string' && p)
            wanted.add((0, paths_1.canonicalisePath)(p));
    }
    if (wanted.size === 0)
        return 0;
    const records = loadDelegatedRegistry();
    let stamped = 0;
    for (const record of records) {
        if (!wanted.has((0, paths_1.canonicalisePath)(record.path)))
            continue;
        record.outcome = outcome;
        record.succeeded = succeeded === true;
        record.verdictAt = at;
        stamped += 1;
    }
    if (stamped > 0) {
        saveDelegatedRegistry(records);
        // The index still holds these records as they were before the stamp, so it has to be refreshed or the
        // guard would keep reading "no verdict" for a file whose verdict has just been recorded.
        indexDelegated(records);
    }
    return stamped;
}
/**
 * Record that a HUMAN verified a file, with the evidence they gave.
 *
 * WHY THIS IS NOT `recordDelegatedOutcome`. That function stamps records that already exist, because a
 * verdict is always the second half of a delegation that wrote the file first. A hand-edited module has no
 * such record -- `guard.ts` in this repository is 786 lines of hand-written change with no delegation
 * behind it -- so an attestation has to CREATE a record rather than stamp one.
 *
 * It creates it with `mode: 'created'`, which is the honest description: the architect has never been
 * shown this content by a worker, and the read guard should treat reading it back the way it treats any
 * other file the context did not write. Claiming `patched` would assert a history that did not happen.
 *
 * The hash is read from disk HERE, not supplied by the caller, so an attestation always describes the
 * bytes that were present when it was made. A caller-supplied hash would let an attestation be recorded
 * for content that was never on disk, which is the one thing this verdict must not allow.
 *
 * Returns the record it wrote, or null when the file could not be read -- never a bare count, because the
 * caller needs the hash to show the operator what they just attested.
 */
function recordOperatorAttestation(path, operator, evidence, at = Date.now()) {
    const target = typeof path === 'string' ? path.trim() : '';
    const who = typeof operator === 'string' ? operator.trim() : '';
    const why = typeof evidence === 'string' ? evidence.trim() : '';
    // Attribution and evidence are both required. An attestation with neither is not a weaker attestation,
    // it is an anonymous stamp, and the registry is better off without one.
    if (!target || !who || !why)
        return null;
    const hash = sha256File(target);
    if (!hash)
        return null;
    const canonical = (0, paths_1.canonicalisePath)(target);
    const records = loadDelegatedRegistry();
    const existing = records.find((record) => (0, paths_1.canonicalisePath)(record.path) === canonical);
    const record = existing ?? { path: canonical, sha256: hash, at, mode: 'created' };
    record.sha256 = hash;
    record.outcome = 'OPERATOR_ATTESTED';
    // Deliberately NOT `succeeded: true`. Success is a claim that a contract was met, and no contract ran
    // here. A consumer that wants to promote an attested file must check the verdict, not a boolean whose
    // meaning would otherwise quietly widen to include "a human looked at it".
    record.succeeded = false;
    record.verdictAt = at;
    record.attestation = { operator: who, evidence: why, at };
    if (!existing)
        records.push(record);
    // A persist that did not happen must not be reported as one. `saveDelegatedRegistry` returns a boolean
    // rather than throwing so its other callers can decide, and the first version of this function ignored
    // that return -- so the very first attestation attempt printed a hash and an operator while the registry
    // was untouched, the write having failed with EPERM inside the persist path. That is the defect this
    // repository has now caught repeatedly: a green result over an operation that did not occur.
    //
    // Throwing is the right response here and not for `recordDelegatedOutcome`, because the two callers face
    // opposite risks. A delegation that fails to record a verdict leaves the file UNSETTLED, which is the
    // fail-closed direction -- an absent verdict reads as "nothing is proven". An attestation that fails to
    // record leaves the operator believing a human-verified claim is on file when nothing is, and the whole
    // point of the verdict is that somebody can be named for it.
    if (!saveDelegatedRegistry(records)) {
        throw new Error('Could not persist the operator attestation for ' +
            canonical +
            '. The registry at ' +
            resolveDelegatedRegistryPath() +
            ' was not written, so nothing was attested.');
    }
    indexDelegated(records);
    return record;
}
