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
exports.DEFAULT_CONTEXT_MAX_BYTES = void 0;
exports.resolveContextFiles = resolveContextFiles;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const emission_1 = require("./emission");
/**
 * Injected context competes with the instruction for the worker's input window, so the budget is a
 * safety bound rather than a caller preference. Over budget refuses; it never truncates quietly,
 * because a worker given half a file answers confidently about a file it only half saw.
 */
exports.DEFAULT_CONTEXT_MAX_BYTES = 32768;
/**
 * Read the files the architect named and render them for the worker's prompt. Containment matches
 * emission exactly: the same resolution, and the same refusal of escapes and absolute paths outside
 * the root, because reading a file in order to transmit it is an egress route and deserves the same
 * scepticism as writing one.
 */
function resolveContextFiles(requests, baseDir, allowedRoots = [], maxBytes = exports.DEFAULT_CONTEXT_MAX_BYTES) {
    const injected = [];
    const errors = [];
    const sections = [];
    let totalBytes = 0;
    for (const request of requests ?? []) {
        const declared = String(request?.path || '').trim();
        if (!declared) {
            errors.push('a contextFiles entry had no path');
            continue;
        }
        const resolvedPath = path.isAbsolute(declared) ? declared : path.resolve(baseDir, declared);
        const containment = (0, emission_1.evaluateEmissionPath)(resolvedPath, baseDir, allowedRoots);
        if (!containment.allowed) {
            errors.push(`context file '${declared}' was refused: ${containment.reason}`);
            continue;
        }
        const declaresRange = request.startLine !== undefined || request.endLine !== undefined;
        if (!declaresRange) {
            try {
                const fileSize = fs.statSync(resolvedPath).size;
                if (fileSize > maxBytes - totalBytes) {
                    errors.push(`context injection would exceed its ${maxBytes}-byte budget (${totalBytes + fileSize} bytes declared). ` +
                        `Narrow the line ranges or declare fewer files.`);
                    continue;
                }
            }
            catch {
                // stat failed; fall through to the read attempt so the existing error path reports it
            }
        }
        let raw;
        try {
            raw = fs.readFileSync(resolvedPath, 'utf8');
        }
        catch (err) {
            errors.push(`context file '${declared}' could not be read: ${err?.message || String(err)}`);
            continue;
        }
        const allLines = raw.split('\n');
        let lineRange = null;
        let body = raw;
        if (request.startLine !== undefined || request.endLine !== undefined) {
            const start = Number(request.startLine ?? 1);
            const end = Number(request.endLine ?? allLines.length);
            if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start) {
                errors.push(`context file '${declared}' had an invalid line range (${request.startLine}-${request.endLine})`);
                continue;
            }
            if (start > allLines.length) {
                errors.push(`context file '${declared}' has ${allLines.length} line(s), so a range starting at ${start} does not exist`);
                continue;
            }
            // An over-long end is clamped rather than refused, and the clamp is reported in the record.
            const clampedEnd = Math.min(end, allLines.length);
            lineRange = { start, end: clampedEnd };
            body = allLines.slice(start - 1, clampedEnd).join('\n');
        }
        const bytes = Buffer.byteLength(body, 'utf8');
        if (totalBytes + bytes > maxBytes) {
            errors.push(`context injection would exceed its ${maxBytes}-byte budget (${totalBytes + bytes} bytes declared). ` +
                `Narrow the line ranges or declare fewer files.`);
            continue;
        }
        totalBytes += bytes;
        const relativeName = path.relative(baseDir, resolvedPath) || declared;
        injected.push({
            path: resolvedPath,
            relativeName,
            lineRange,
            lines: body.split('\n').length,
            bytes,
            sha256: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
        });
        sections.push(`--- ${relativeName}${lineRange ? ` (lines ${lineRange.start}-${lineRange.end})` : ''} ---\n${body}`);
    }
    // Any error refuses the whole injection, and the caller refuses the delegation. A partial view is
    // worse than none: the worker would be asked to edit a file it had only partly been shown.
    if (errors.length > 0)
        return { injected: [], text: '', errors };
    const text = sections.length > 0 ? `Declared Context:\n${sections.join('\n\n')}` : '';
    return { injected, text, errors };
}
