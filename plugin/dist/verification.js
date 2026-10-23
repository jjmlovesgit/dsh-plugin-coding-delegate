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
exports.DEFAULT_VERIFICATION_POLICY = exports.DEFAULT_VERIFICATION_TIMEOUT_MS = void 0;
exports.redactVerificationOutput = redactVerificationOutput;
exports.describeFailures = describeFailures;
exports.parseTestOutput = parseTestOutput;
exports.resolveVerificationTimeoutMs = resolveVerificationTimeoutMs;
exports.commandProgram = commandProgram;
exports.evaluateVerificationPolicy = evaluateVerificationPolicy;
exports.runSandboxVerification = runSandboxVerification;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const child_process = __importStar(require("child_process"));
const logging_1 = require("./logging");
const index_1 = require("./index");
const sandbox_1 = require("./sandbox");
/**
 * Does this text look like source rather than a label? Assertion messages should be
 * prose; anything code-shaped is dropped rather than forwarded.
 */
function looksLikeCode(text) {
    return (/[{};]/.test(text) ||
        /=>/.test(text) ||
        /\b(?:function|const|let|var|return|import|export|class|def|public|private)\b/.test(text) ||
        /\b(?:expected|actual)\b\s*[:=]/i.test(text));
}
function cleanMessage(raw) {
    const collapsed = String(raw).trim().replace(/^['"]|['"]$/g, '').replace(/\s+/g, ' ');
    if (!collapsed || /^\|-?$/.test(collapsed))
        return undefined;
    if (looksLikeCode(collapsed))
        return undefined;
    return collapsed.length > 160 ? collapsed.slice(0, 157) + '...' : collapsed;
}
/**
 * Bound a retained field and strip anything the secret rules recognise. Entropy is on:
 * these strings are exactly what leaves the machine, so a high-entropy blob in a test
 * name must not ride along merely because it lacks a recognisable keyword.
 */
function sanitizeRetainedField(value, maxLength = 200) {
    if (typeof value !== 'string')
        return undefined;
    const collapsed = value.replace(/\s+/g, ' ').trim();
    if (!collapsed)
        return undefined;
    const scanned = (0, index_1.scanDLP)(collapsed);
    if (scanned.hasSensitiveData)
        return '[redacted: ' + scanned.violations.join(', ') + ']';
    return collapsed.length > maxLength ? collapsed.slice(0, maxLength) + ' [truncated]' : collapsed;
}
/**
 * Reduce raw verification output to a source-free structure.
 *
 * Only named fields are ever copied out of a failure block; every other line inside it
 * (stack frames, expected/actual, diff markers, quoted code) is discarded by omission
 * rather than by pattern-matching each leak shape.
 */
function redactVerificationOutput(raw, workspaceRoot) {
    if (!raw)
        return [];
    const failures = [];
    let current = null;
    const flush = () => {
        if (current && (current.name || current.location || current.code))
            failures.push(current);
        current = null;
    };
    for (const line of raw.split(/\r?\n/)) {
        const t = line.trim();
        if (!t)
            continue;
        const compile = /^(.+?)\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.*)$/.exec(t);
        if (compile) {
            flush();
            failures.push({
                kind: 'compile',
                location: sanitizeLocation(compile[1] + ':' + compile[2] + ':' + compile[3], workspaceRoot),
                code: compile[4],
                message: cleanMessage(compile[5]),
            });
            continue;
        }
        const compile2 = /^error\s+(TS\d+):\s*(.*)$/.exec(t);
        if (compile2) {
            flush();
            failures.push({ kind: 'compile', code: compile2[1], message: cleanMessage(compile2[2]) });
            continue;
        }
        // A passing test ends the block above it. Without this, every line up to the next `not ok` was read as
        // part of the previous failure -- including the `ok` lines of tests named for a timeout, which is how an
        // assertion failure came to be reported as [timeout].
        if (/^ok\s+\d+/i.test(t)) {
            flush();
            continue;
        }
        const notOk = /^not ok\s+(\d+)\s*-\s*(.*)$/i.exec(t);
        if (notOk) {
            flush();
            current = { kind: 'assertion', name: (notOk[1] + '. ' + notOk[2]).replace(/\s+/g, ' ').trim() };
            continue;
        }
        if (current) {
            const loc = /^location:\s*(.+)$/.exec(t);
            if (loc) {
                current.location = sanitizeLocation(loc[1], workspaceRoot);
                continue;
            }
            const code = /^code:\s*(.+)$/.exec(t);
            if (code) {
                const value = code[1].replace(/^['"]|['"]$/g, '').trim();
                current.code = value;
                // A failed expectation is an assertion, and nothing later in the block may relabel it: the word
                // "timeout" appears in this suite's own test names, and a stray mention used to win.
                if (/^ERR_ASSERTION$/i.test(value))
                    current.kind = 'assertion';
                continue;
            }
            const err = /^error:\s*(.*)$/.exec(t);
            if (err) {
                const message = cleanMessage(err[1]);
                if (message)
                    current.message = message;
                continue;
            }
            if (/timeout/i.test(t) && !/^ERR_ASSERTION$/i.test(String(current.code ?? ''))) {
                current.kind = 'timeout';
            }
            // Everything else inside a failure block is deliberately not copied.
            continue;
        }
        if (/AssertionError/.test(t)) {
            const message = cleanMessage(t);
            failures.push({ kind: 'assertion', ...(message ? { message } : {}) });
        }
    }
    flush();
    // Names, locations and codes are test- and model-controlled text and they travel to the
    // cloud. A TAP label can carry a credential as easily as a diff can, so every retained
    // field is put through the same secret rules the DLP gate uses. Counts and structure
    // still travel; only the offending value is replaced by a marker.
    return failures
        .map((failure) => {
        const bounded = { kind: failure.kind };
        const name = sanitizeRetainedField(failure.name);
        const location = sanitizeRetainedField(failure.location);
        const code = sanitizeRetainedField(failure.code, 40);
        const message = sanitizeRetainedField(failure.message, 300);
        if (name)
            bounded.name = name;
        if (location)
            bounded.location = location;
        if (code)
            bounded.code = code;
        if (message)
            bounded.message = message;
        return bounded;
    })
        .filter((failure) => Boolean(failure.name || failure.location || failure.code || failure.message));
}
/**
 * A failure location, named without the host's directory layout.
 *
 * WHY THIS IS A BOUNDARY CONCERN AND NOT COSMETIC. MEASURED by driving this module over a real failing
 * `node:test` run: the runner reports `location: 'C:\\Users\\<name>\\AppData\\Local\\Temp\\...\\x.test.cjs:4:11'`
 * and the redactor forwarded it verbatim, so EVERY failure line carried the drive letter and the account
 * name across to the cloud model. The diagnostic value is the file and the position, not whose machine
 * the run happened on.
 *
 * Inside the workspace the path is kept in full and made relative to it, because that is what a reader
 * acts on. Anything outside it -- a temporary directory, the runner's own frame -- is reduced to its
 * basename for the same reason: the file name is the diagnosis, the directory is the host.
 *
 * TAP doubles backslashes in the paths it reports, so they are collapsed first, and the result is
 * emitted with forward slashes to match how every other path in this repository is displayed.
 */
function sanitizeLocation(rawLocation, workspaceRoot) {
    // MEASURED shapes that reached the model: `location: 'C:\\Users\\<name>\\...\\x.test.cjs:4:11'` from one
    // runner and `location: 'C:/Users/<name>/.../x.test.cjs:4:11'` from another. So the value arrives
    // quoted, and its separators may be either kind -- which is why the quotes come off first and both
    // separators are normalised before anything asks whether the path is absolute. Without the quote strip,
    // `path.isAbsolute` answered false for a drive path and the whole check passed it through.
    const unescaped = String(rawLocation || '')
        .trim()
        .replace(/^['"]|['"]$/g, '')
        .replace(/\\\\/g, '\\')
        .trim();
    if (!unescaped)
        return unescaped;
    const position = /(:\d+(?::\d+)?)$/.exec(unescaped);
    const suffix = position ? position[1] : '';
    const rawPath = suffix ? unescaped.slice(0, unescaped.length - suffix.length) : unescaped;
    const root = workspaceRoot ? path.resolve(String(workspaceRoot)) : '';
    const absolute = path.isAbsolute(rawPath) ? path.resolve(rawPath) : '';
    let shown = rawPath;
    if (absolute && root && (absolute === root || absolute.startsWith(root + path.sep))) {
        shown = path.relative(root, absolute);
    }
    else if (absolute) {
        shown = path.basename(absolute);
    }
    return shown.split(/[\\/]/).join('/') + suffix;
}
/**
 * The raw log, named without the host's home directory or drive.
 *
 * The pointer exists so a reader knows the full text was kept locally rather than sent, and
 * `C:\Users\<name>\.dsh\local-router\last-verification.log` delivers the account name and the directory
 * layout along with that assurance. `local-router/last-verification.log` says the same thing to anyone
 * who has the data directory, which is the only reader the pointer is for.
 */
function rawLogLabel(rawPath) {
    const target = String(rawPath || '');
    return path.basename(path.dirname(target)) + '/' + path.basename(target);
}
/** One line per failure: kind, name, location, code, prose message. Never source. */
function describeFailures(failures) {
    return failures.map((f) => {
        const parts = ['- [' + f.kind + ']'];
        if (f.name)
            parts.push(f.name);
        if (f.location)
            parts.push('@ ' + f.location);
        if (f.code)
            parts.push('(' + f.code + ')');
        if (f.message)
            parts.push(': ' + f.message);
        return parts.join(' ');
    });
}
function parseTestOutput(output, exitCode, options = {}) {
    if (!output) {
        // A silent command is only a success when it also exited cleanly.
        if (exitCode !== undefined && exitCode !== 0) {
            return {
                passed: 0,
                failed: 1,
                output: 'command exited with code ' + exitCode + ' and produced no output',
                errorSummary: 'exit code ' + exitCode,
            };
        }
        return { passed: 0, failed: 0, output: '' };
    }
    let passed = 0;
    let failed = 0;
    const lines = output.split('\n');
    const failureLines = [];
    const hasTap = lines.some((l) => /^ok\s+\d+|^not ok\s+\d+/i.test(l.trim()));
    if (hasTap) {
        for (const line of lines) {
            const trimmed = line.trim();
            if (/^not ok\s+/i.test(trimmed)) {
                failed++;
                failureLines.push(trimmed);
            }
            else if (/^ok\s+/i.test(trimmed)) {
                passed++;
            }
        }
    }
    else {
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed)
                continue;
            if (/✓|✔|PASSED/i.test(trimmed) && !/FAILED|not ok/i.test(trimmed)) {
                passed++;
            }
            else if (/(?:✕|✖|FAILED|AssertionError|Error:)/i.test(trimmed)) {
                failed++;
                failureLines.push(trimmed);
            }
        }
    }
    // The exit code is authoritative. Unrecognized output must NEVER count as a pass:
    // `tsc` reports failures as "error TS1234:", which matches none of the markers
    // above, so the previous fallback turned a broken build into status SUCCESS.
    if (exitCode !== undefined && exitCode !== 0) {
        failed = Math.max(failed, 1);
        if (failureLines.length === 0) {
            failureLines.push(output.slice(0, 300) || 'command exited with code ' + exitCode);
        }
    }
    else if (passed === 0 && failed === 0) {
        if (output.includes('AssertionError') ||
            output.includes('Error:') ||
            output.includes('FAIL') ||
            /\berror\b/i.test(output)) {
            failed = 1;
            failureLines.push(output.slice(0, 300));
        }
        else {
            passed = 1;
        }
    }
    // Raw output is a source-egress channel, so by default only structure is returned.
    // The full text is on disk (rawOutputPath) for the delegated worker to work from.
    const redact = options.redact !== false;
    const failures = redact ? redactVerificationOutput(output, options.workspaceRoot) : [];
    const described = describeFailures(failures);
    const headline = failed + ' failed, ' + passed + ' passed' + (exitCode !== undefined ? ' (exit ' + exitCode + ')' : '');
    const body = redact
        ? [
            headline,
            ...(described.length > 0
                ? described.slice(0, 10)
                : failed > 0
                    ? ['- [unknown] no structured failure could be extracted; see the raw log']
                    : []),
            // Named without the host's layout: the pointer's job is "the full text was kept locally", and an
            // absolute path delivers the account name and the directory structure along with that assurance.
            ...(options.rawOutputPath ? ['raw output: ' + rawLogLabel(options.rawOutputPath)] : []),
        ].join('\n')
        : output.slice(0, 2000);
    const summarySource = redact
        ? described.slice(0, 5).join('; ') || (failed > 0 ? 'unstructured failure; see the raw log' : undefined)
        : failureLines.length > 0
            ? failureLines.slice(0, 5).join('; ')
            : undefined;
    return {
        passed,
        failed,
        output: body.slice(0, 2000),
        ...(summarySource ? { errorSummary: summarySource } : {}),
        ...(redact ? { failures, redacted: true } : { redacted: false }),
        ...(options.rawOutputPath ? { rawOutputPath: options.rawOutputPath } : {}),
    };
}
/**
 * The bound on how long a verification command may run, in milliseconds.
 *
 * 30 s was the value hardcoded inside `runSandboxVerification`, and it is kept as the default so that an
 * operator who configures nothing sees no change. It is exported because it is the answer to "how long
 * do I have?", and previously that answer was only available by reading the source.
 */
exports.DEFAULT_VERIFICATION_TIMEOUT_MS = 30000;
/**
 * Coerce a configured timeout, falling back to the default rather than to *no bound*.
 *
 * The direction matters. "No timeout" on a command that is model-selected and runs with the DSH
 * process's authority is not a permission, it is a hang — so a value that is not a positive finite
 * number is refused and the default applies. A fractional value is floored to a whole millisecond
 * because that is the unit the spawn takes.
 */
function resolveVerificationTimeoutMs(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0)
        return exports.DEFAULT_VERIFICATION_TIMEOUT_MS;
    return Math.floor(n);
}
exports.DEFAULT_VERIFICATION_POLICY = {
    mode: 'ask',
    allowlist: [],
    timeoutMs: exports.DEFAULT_VERIFICATION_TIMEOUT_MS,
};
/** The program a shell command would run, normalised for allowlist comparison. */
function commandProgram(command) {
    const text = String(command || '').trim();
    if (!text)
        return '';
    // A quoted first token may contain spaces ("C:\Program Files\nodejs\node.exe"), so it
    // must be taken whole; splitting on whitespace first would read it as "C:\Program".
    const quoted = /^"([^"]+)"|^'([^']+)'/.exec(text);
    const first = quoted ? quoted[1] ?? quoted[2] ?? '' : text.split(/\s+/)[0] || '';
    const bare = first.replace(/^["']|["']$/g, '');
    return path.basename(bare).toLowerCase().replace(/\.(?:exe|cmd|bat|ps1)$/, '');
}
/**
 * Decide whether a model-supplied verification command may run. Pure, so the policy is
 * testable without a server or an approval seam. `runVerification` is model-selected and
 * executes with the DSH process's full authority, so silence is never consent: anything
 * not explicitly permitted resolves to `ask`, and `ask` with no approver available is a
 * refusal at the call site.
 */
function evaluateVerificationPolicy(command, policy = exports.DEFAULT_VERIFICATION_POLICY) {
    const program = commandProgram(command);
    if (!program) {
        return { kind: 'deny', program, reason: 'the verification command was empty' };
    }
    if (policy.mode === 'deny') {
        return {
            kind: 'deny',
            program,
            reason: "verificationApproval is 'deny', so no verification command is executed",
        };
    }
    const allowlisted = policy.allowlist.some((entry) => commandProgram(String(entry)) === program);
    if (policy.mode === 'allow' || allowlisted) {
        return {
            kind: 'allow',
            program,
            reason: allowlisted
                ? "program '" + program + "' is on verificationAllowlist"
                : "verificationApproval is 'allow'",
        };
    }
    return {
        kind: 'ask',
        program,
        reason: "the verification command '" + command + "' would run with the full authority of the DSH process " +
            'and is not confined to the workspace',
    };
}
/**
 * Run a verification command and capture its output.
 *
 * Output is captured through FILE DESCRIPTORS rather than pipes, deliberately. DSH's confined
 * sandbox modes refuse a piped spawn outright (`spawn EPERM`), which made the ordinary
 * subprocess path unusable in the default configuration and left the in-process fallback as the
 * only path that worked -- the wrong trade in every direction, since that fallback executes
 * model-influenced code inside the server. A descriptor avoids the pipe, so verification runs
 * as an ordinary child process for everyone. The fallback has since been removed outright; see
 * the refusal in `runSandboxVerification`, which is now the only answer to a spawn denial.
 */
function captureCommandOutput(binary, args, workspaceDir, timeoutMs, env) {
    const dir = (0, logging_1.resolveDataDir)();
    const unique = process.pid + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    const outPath = path.join(dir, 'verify-' + unique + '.stdout');
    const errPath = path.join(dir, 'verify-' + unique + '.stderr');
    let outFd;
    let errFd;
    let result = null;
    try {
        fs.mkdirSync(dir, { recursive: true });
        outFd = fs.openSync(outPath, 'w');
        errFd = fs.openSync(errPath, 'w');
        result = child_process.spawnSync(binary, args, {
            // NO SHELL. The binary and its argv are handed to CreateProcessW/execve directly, so cmd.exe
            // cannot expand %VAR%, interpret ^, or chain a second command that the sandbox never sees.
            shell: false,
            cwd: workspaceDir,
            timeout: timeoutMs,
            stdio: ['ignore', outFd, errFd],
            // The sandbox travels through NODE_OPTIONS, and `undefined` keeps the previous behaviour for any
            // caller that has no environment.
            ...(env ? { env } : {}),
        });
    }
    catch (err) {
        result = { error: err, status: null };
    }
    finally {
        for (const fd of [outFd, errFd]) {
            if (typeof fd === 'number') {
                try {
                    fs.closeSync(fd);
                }
                catch {
                    // already closed
                }
            }
        }
    }
    const readFile = (file) => {
        try {
            return fs.readFileSync(file, 'utf8');
        }
        catch {
            return '';
        }
    };
    const output = (readFile(outPath) + '\n' + readFile(errPath)).trim();
    for (const file of [outPath, errPath]) {
        try {
            fs.rmSync(file, { force: true });
        }
        catch {
            // Best effort: a leftover temp file is not worth failing a verification over.
        }
    }
    const spawnError = result?.error ?? null;
    const exitCode = typeof result?.status === 'number' ? result.status : spawnError ? 1 : 0;
    return {
        output: output || (spawnError ? String(spawnError.message || spawnError) : ''),
        exitCode,
        spawnError,
    };
}
function runSandboxVerification(verificationCommand, workspaceDir = process.cwd(), options = {}) {
    if (!verificationCommand || !verificationCommand.trim()) {
        return { passed: 0, failed: 0, output: 'No verification command specified.' };
    }
    const cmd = verificationCommand.trim();
    // Fail closed BEFORE a shim is written or a process spawned. Runner modes cannot be sandboxed (they
    // fork per test file), and a non-node runtime never receives the sandbox at all, so an unsandboxed
    // fallback for either would make every attestation that cites this run misleading. The refusal is
    // classified as "nothing ran" — the VERIFICATION_NOT_APPROVED case in the lattice.
    const validation = (0, sandbox_1.resolveVerificationInvocation)(cmd);
    if (!validation.valid) {
        const refusal = 'not ok 1 - ' + String(validation.reason);
        const parsed = parseTestOutput(refusal, 1, {
            redact: options.redact,
            rawOutputPath: persistRaw(refusal, options.rawLogPath),
            workspaceRoot: workspaceDir,
        });
        return {
            ...parsed,
            // The parsed form is a summary; an operator needs the whole refusal, because the remediation is
            // the only part of it they can act on.
            output: refusal,
            exitCode: 1,
        };
    }
    let output = '';
    let spawnError = null;
    let exitCode = 0;
    const sandbox = (0, sandbox_1.sandboxEnv)(workspaceDir);
    let captured;
    try {
        captured = captureCommandOutput(validation.binary, validation.args, workspaceDir, resolveVerificationTimeoutMs(options.timeoutMs), sandbox.env);
    }
    finally {
        sandbox.cleanup();
    }
    output = captured.output;
    spawnError = captured.spawnError;
    exitCode = captured.exitCode;
    if (spawnError &&
        (spawnError.code === 'EPERM' ||
            String(spawnError).includes('EPERM') ||
            String(spawnError).includes('spawn EPERM'))) {
        // Even a descriptor spawn was refused, so this host blocks verification entirely. The
        // in-process fallback that used to answer this was REMOVED: it resolved a module path out
        // of the model-supplied command and `require()`d it inside the SERVER process, so denying
        // the sandbox was answered by removing the sandbox. A host that cannot spawn now gets a
        // hard refusal, which is the fail-closed direction.
        const refusal = 'not ok 1 - the sandbox refused to spawn the verification command (EPERM), and the ' +
            'in-process fallback was removed because it loaded model-supplied code into the DSH ' +
            'server process. Refusing to report success.\n' + output;
        return {
            ...parseTestOutput(refusal, exitCode, {
                redact: options.redact,
                rawOutputPath: persistRaw(refusal, options.rawLogPath),
                workspaceRoot: workspaceDir,
            }),
            exitCode,
        };
    }
    return {
        ...parseTestOutput(output, exitCode, {
            redact: options.redact,
            rawOutputPath: persistRaw(output, options.rawLogPath),
            workspaceRoot: workspaceDir,
        }),
        exitCode,
    };
}
/**
 * Keep the full verification output on the local machine. The redacted structure is what
 * travels; this is what a worker or an operator reads when they need the real thing.
 */
function persistRaw(output, rawLogPath) {
    if (!rawLogPath)
        return undefined;
    try {
        fs.mkdirSync(path.dirname(rawLogPath), { recursive: true });
        fs.writeFileSync(rawLogPath, output, 'utf8');
        return rawLogPath;
    }
    catch {
        return undefined;
    }
}
