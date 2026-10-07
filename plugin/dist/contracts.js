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
exports.resolveDelegatedRegistryPath = resolveDelegatedRegistryPath;
exports.parseDelegatedRegistry = parseDelegatedRegistry;
exports.mergeDelegatedRecords = mergeDelegatedRecords;
exports.pruneDelegatedRecords = pruneDelegatedRecords;
exports.saveDelegatedRegistry = saveDelegatedRegistry;
exports.loadDelegatedRegistry = loadDelegatedRegistry;
exports.rememberDelegated = rememberDelegated;
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
        records.push({
            path: entryPath,
            sha256: typeof entry.sha256 === 'string' && entry.sha256 ? entry.sha256 : null,
            at: Number.isFinite(Number(entry.at)) ? Number(entry.at) : 0,
            // Records written before this field existed predate the distinction, and the conservative reading
            // of an old record is the one that protects more: treat it as created.
            mode: entry.mode === 'patched' ? 'patched' : 'created',
        });
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
    // Only whole files the worker produced enter the read guard's index. A patched file is one the
    // architect was working on and must keep reading; the record still remembers it either way.
    for (const entry of merged) {
        if (entry.mode === 'created')
            exports.delegatedPaths.add((0, paths_1.canonicalisePath)(entry.path));
    }
    while (exports.delegatedPaths.size > exports.DELEGATED_PATH_LIMIT) {
        const oldest = exports.delegatedPaths.values().next().value;
        if (typeof oldest === 'string')
            exports.delegatedPaths.delete(oldest);
    }
}
