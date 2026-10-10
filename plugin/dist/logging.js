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
exports.resolveDataDir = resolveDataDir;
exports.redactTracePayload = redactTracePayload;
exports.trace = trace;
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
/**
 * All plugin state (debug log, savings ledger) lives under one derived directory.
 * It must never be a hard-coded absolute path: the previous build wrote its log
 * into the plugin author's own project directory on every machine, which was
 * correct on exactly one of them.
 * Precedence: explicit env override, then DSH_HOME, then ~/.dsh.
 */
function resolveDataDir() {
    const explicit = process.env.DSH_LOCAL_ROUTER_DATA_DIR;
    if (explicit && explicit.trim())
        return explicit.trim();
    const dshHome = process.env.DSH_HOME;
    if (dshHome && dshHome.trim())
        return path.join(dshHome.trim(), 'local-router');
    return path.join(os.homedir(), '.dsh', 'local-router');
}
const LOG_FILE = path.join(resolveDataDir(), 'router-debug.log');
/**
 * Remove prompt text from a trace payload before it is written to disk.
 *
 * A debug log outlives the session, and call sites pass a prompt slice into it. No prompt content may
 * be persisted, so the value is replaced with its length rather than scanned for secrets: pattern
 * detection has false negatives, and a replacement is a guarantee where a pattern is a probability.
 * Every other field is preserved, because redaction that succeeds by writing nothing removes the
 * diagnostic value the log exists for.
 *
 * Pure and exported so it is testable directly. The caller's object is not mutated.
 */
function redactTracePayload(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data))
        return data;
    const copy = { ...data };
    if (typeof copy.prompt === 'string') {
        copy.prompt = 'prompt suppressed (' + copy.prompt.length + ' chars)';
    }
    return copy;
}
function trace(event, data) {
    const timestamp = new Date().toISOString();
    const payload = redactTracePayload(data);
    const entry = '\n[' + timestamp + '] === ' + event + ' ===\n' +
        (typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)) +
        '\n';
    try {
        fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
        fs.appendFileSync(LOG_FILE, entry, 'utf8');
    }
    catch (err) { }
}
