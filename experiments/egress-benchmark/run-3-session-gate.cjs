#!/usr/bin/env node
/**
 * Run 3 gate — the session-scoped observables.
 *
 * Reads one session store and reports the three things a DLP pin changes, from the
 * session's own record rather than from a shared log:
 *
 *   1. the dispatched route per request  (`request/header` → data.header.config.provider/model)
 *   2. how every turn ended              (`turn/end`      → data.reason)
 *   3. the saved selection               (`model/selection`)
 *
 * WHY THIS EXISTS RATHER THAN A LOG COUNT
 * ---------------------------------------
 * `router-debug.log` records a pin as `=== HOOK_EXIT: DLP_PINNED_LOCAL (agent/request) ===`, but
 * that block carries `role`, `roleReason`, `provider`, `model`, `uncappedContextWindow` and
 * `toolsCount` -- no session id. A window count therefore proves *a* pin happened, not whose. The
 * session store is the only session-scoped evidence, and `request/header` names the provider and
 * model the plugin actually dispatched.
 *
 * WHY THE HTTP STATUS CHECK IT REPLACES WAS VOID
 * ----------------------------------------------
 * A pinned request carrying an unsupported effort is refused by the host *before any network I/O*,
 * so no HTTP status is ever produced: a run with the bug fully present reports zero 400s. The
 * failure is a session-level code. Measured 2026-10-10 in session-f0387683: five consecutive
 * `turn/end` records with `data.reason.error.code === 'UNSUPPORTED_REASONING_EFFORT'`, the last of
 * them tripped by a one-character prompt, because the DLP corpus accumulates what a session has
 * said and stays sticky for its lifetime (`plugin/src/index.ts`, the corpus comment block).
 *
 * A REFUSED REQUEST WRITES NO HEADER
 * ----------------------------------
 * Measured on that same store: 5 `UNSUPPORTED_REASONING_EFFORT` turns against 0 `lm-studio`
 * `request/header` records. A refused request never reaches dispatch, so it logs no header. The
 * header is therefore **positive-only** evidence: its presence proves a dispatch, its absence
 * proves nothing. Zero local headers must never be read as "no pin occurred" on a build without
 * `fcb9340` (the commit that drops the effort at the pin), where the pin's only session-scoped trace
 * is the error turn.
 *
 * STRICTNESS: WHY A TORN STORE IS REFUSED RATHER THAN DECODED
 * ----------------------------------------------------------
 * `zlib.zstdDecompressSync` does not throw on a torn final frame. Measured 2026-10-10 against
 * checksummed frames of the kind this host writes (frame-header descriptor 0x04, content checksum
 * set, no content-size field):
 *
 *   truncate the last frame by 8 bytes   -> decodes to 0 bytes, no error
 *   truncate a frame at a record boundary-> frame simply absent, no error
 *   flip one payload byte                -> throws ZSTD_error_checksum_wrong
 *
 * A decoder that returns a prefix without complaint would let a crashed run be certified, which is
 * the one failure a measurement gate must not make. Three rules therefore guard the decode:
 *
 *   R1  every frame must decode to at least one byte (a valid frame always carries a record);
 *   R2  the decoded text must end with a newline (records are newline-terminated, so a torn
 *       mid-record tail is visible);
 *   R3  every decoded line must parse as JSON -- an unparseable line is refused rather than skipped.
 *
 * Residual limit, stated rather than implied: bytes appended after a *complete* final frame are not
 * detectable here. The magic walk extends the last frame's byte range to EOF and Zstandard ignores
 * trailing bytes, and a frame header declares its decompressed size, not its compressed length. That
 * case is a torn tail, which R1-R3 catch; it is not the crash pattern this gate exists for.
 *
 * Frame format: DSH writes a concatenation of independent Zstandard frames -- one for the header,
 * one per append batch -- each with the content-checksum flag set (descriptor 0x04).
 * `zstdDecompressSync` decodes only one frame at a time, so every frame is walked by its magic
 * offset here. Node's own `zstdCompressSync` writes descriptor 0x20 by default (single-segment, no
 * checksum); pass `ZSTD_c_checksumFlag: 1` to write frames that carry a checksum like the host's.
 *
 * Usage:
 *   node run-3-session-gate.cjs <session.v3.jsonl.zstd> [--expect cloud|local]
 *   node run-3-session-gate.cjs --session <session-id>  [--arm A|B]
 *
 *   --session <id>   resolve the store under $DSH_HOME/sessions/<project>/<id>/ instead of a path
 *   --arm A          alias for --expect cloud: this session must have dispatched nothing locally
 *   --arm B          alias for --expect local: at least one local request, none carrying the effort
 *   --expect cloud   arm A semantics
 *   --expect local   arm B semantics
 *   (omitted)        report only; the trailing-turn assertion still decides the exit code
 *
 * Exit codes: 0 = the recorded facts match the expectation, 1 = they do not, 2 = the store could not
 * be read or certified. Run it as a direct `node <file>`: `node --test` needs to spawn a child
 * process, which the workspace sandbox refuses with `spawn EPERM`.
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const LOCAL_PROVIDER = 'lm-studio';
const UNSUPPORTED = 'UNSUPPORTED_REASONING_EFFORT';

/** Frame start offsets, in order. */
function frameStarts(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] &&
        buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) starts.push(i);
  }
  return starts;
}

/** Decode every frame in the store under rules R1-R3, or throw. */
function decodeAllFrames(buf) {
  const starts = frameStarts(buf);
  if (starts.length === 0) throw new Error('no zstandard frames found');
  if (starts[0] !== 0) throw new Error('first frame does not start at offset 0');
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
    // Throws on a checksum or structural failure inside a complete frame.
    const decoded = zlib.zstdDecompressSync(buf.subarray(from, to));
    // R1: a valid frame carries at least one record; a torn frame decodes to nothing.
    if (decoded.length === 0) {
      throw new Error('frame ' + k + ' (offset ' + from + ') decoded to zero bytes: the store is torn');
    }
    parts.push(decoded);
  }
  const text = Buffer.concat(parts).toString('utf8');
  // R2: DSH writes newline-terminated JSONL, so a torn mid-record tail shows up here.
  if (!text.endsWith('\n')) throw new Error('decoded text does not end at a record boundary: the store is torn');
  return { text, frames: starts.length };
}

/** Resolve a session id to its store path under the DSH home. */
function resolveSession(id) {
  const home = process.env.DSH_HOME && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : path.join(os.homedir(), '.dsh');
  const root = path.join(home, 'sessions');
  const hits = [];
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue;
    const store = path.join(root, project.name, id, 'session.v3.jsonl.zstd');
    if (fs.existsSync(store)) hits.push(store);
  }
  if (hits.length === 0) throw new Error('no store found for session ' + id + ' under ' + root);
  if (hits.length > 1) throw new Error('session ' + id + ' resolves to ' + hits.length + ' stores');
  return hits[0];
}

function main() {
  const argv = process.argv.slice(2);
  // A flag's value is not a positional. Unknown flags are rejected rather than ignored: a typo such
  // as `--Arm A` would otherwise drop the arm's expectation and still report a green gate.
  const VALUE_FLAGS = new Set(['--session', '--expect', '--arm']);
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (VALUE_FLAGS.has(arg)) { i++; continue; }
    if (arg.startsWith('--')) {
      console.error('unknown flag: ' + arg);
      process.exitCode = 2;
      return;
    }
    positional.push(arg);
  }
  const flagValue = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };

  const expectIndex = argv.indexOf('--expect');
  let expect = expectIndex >= 0 ? argv[expectIndex + 1] : undefined;
  const arm = flagValue('--arm');
  if (arm !== undefined) {
    if (arm !== 'A' && arm !== 'B') {
      console.error('--arm takes A or B');
      process.exitCode = 2;
      return;
    }
    if (expect !== undefined && expect !== (arm === 'A' ? 'cloud' : 'local')) {
      console.error('--arm ' + arm + ' contradicts --expect ' + expect);
      process.exitCode = 2;
      return;
    }
    expect = arm === 'A' ? 'cloud' : 'local';
  }
  if (expect !== undefined && expect !== 'cloud' && expect !== 'local') {
    console.error('--expect takes cloud or local');
    process.exitCode = 2;
    return;
  }

  const sessionId = flagValue('--session');
  if (sessionId !== undefined && positional.length > 0) {
    console.error('pass a store path or --session <id>, not both');
    process.exitCode = 2;
    return;
  }
  if (sessionId === undefined && positional.length === 0) {
    console.error('usage: node run-3-session-gate.cjs <session.v3.jsonl.zstd> [--expect cloud|local]');
    console.error('       node run-3-session-gate.cjs --session <session-id> [--arm A|B]');
    process.exitCode = 2;
    return;
  }

  const file = sessionId !== undefined ? resolveSession(sessionId) : positional[0];
  const { text, frames } = decodeAllFrames(fs.readFileSync(file));
  const rawLines = text.split('\n').filter(Boolean);
  const rows = [];
  for (const line of rawLines) {
    try { rows.push(JSON.parse(line)); }
    catch { throw new Error('decoded line is not JSON: ' + JSON.stringify(line.slice(0, 60))); }
  }

  const header = rows[0];
  const requests = rows.filter((r) => r.type === 'request/header');
  const turns = rows.filter((r) => r.type === 'turn/end');
  const selections = rows.filter((r) => r.type === 'model/selection');
  const trailing = turns[turns.length - 1];

  const routeOf = (r) => r.data?.header?.config ?? {};
  const localRequests = requests.filter((r) => String(routeOf(r).provider || '') === LOCAL_PROVIDER);
  const localWithEffort = localRequests.filter((r) => 'reasoningEffort' in routeOf(r));
  const failed = turns.filter((t) => t.data?.reason?.error?.code === UNSUPPORTED);
  const otherErrors = turns.filter((t) => t.data?.reason?.kind === 'error' &&
    t.data?.reason?.error?.code !== UNSUPPORTED);

  const out = [];
  out.push('session      : ' + String(header?.id ?? '(no header record)'));
  out.push('store        : ' + file);
  out.push('frames       : ' + frames + '   records: ' + rows.length);
  out.push('requests     : ' + requests.length + '   turns: ' + turns.length);
  out.push('');
  out.push('dispatched providers (request/header, in order):');
  const providers = new Map();
  for (const r of requests) {
    const key = String(routeOf(r).provider || '(none)') + ' / ' + String(routeOf(r).model || '(none)');
    providers.set(key, (providers.get(key) ?? 0) + 1);
  }
  if (providers.size === 0) out.push('  (none recorded)');
  for (const [key, count] of providers) out.push('  ' + String(count).padStart(4) + '  ' + key);
  out.push('');
  out.push('DLP pin evidence (session-scoped):');
  out.push('  requests to ' + LOCAL_PROVIDER + '                       : ' + localRequests.length);
  out.push('  ...of those still carrying reasoningEffort : ' + localWithEffort.length +
    (localWithEffort.length ? '   <- pre-fcb9340 signature' : ''));
  out.push('');
  out.push('turn outcomes:');
  out.push('  ' + UNSUPPORTED + ' : ' + failed.length +
    (failed.length ? '   <- the fatal pin, pre-fcb9340' : ''));
  out.push('  other error turns                : ' + otherErrors.length);
  out.push('  trailing turn/end                : turn ' + String(trailing?.data?.turn ?? '?') +
    '  reason=' + JSON.stringify(trailing?.data?.reason ?? null));
  if (selections.length) {
    out.push('');
    out.push('saved selection (last model/selection governs every later request):');
    out.push('  ' + JSON.stringify(selections[selections.length - 1].data));
  }
  console.log(out.join('\n'));

  const problems = [];
  if (!trailing) problems.push('no turn/end record: this store has no completed turn to assert on');
  else if (trailing.data?.reason?.kind !== 'completed') {
    problems.push('trailing turn/end is ' + JSON.stringify(trailing.data?.reason));
  }
  if (failed.length > 0) problems.push(failed.length + ' turn(s) ended ' + UNSUPPORTED);
  if (expect === 'cloud' && localRequests.length > 0) {
    problems.push(localRequests.length + ' request(s) dispatched to ' + LOCAL_PROVIDER +
      ': this arm A session is CONTAMINATED by a DLP pin');
  }
  if (expect === 'local' && localRequests.length === 0) {
    problems.push('--expect local but no request dispatched to ' + LOCAL_PROVIDER +
      ': the pin left no session-scoped evidence (check the log direction before concluding anything)');
  }
  if (expect === 'local' && localWithEffort.length > 0) {
    problems.push(localWithEffort.length + ' pinned request(s) still carry reasoningEffort: fcb9340 is not loaded');
  }

  console.log('');
  if (problems.length === 0) {
    console.log('GATE: ok' + (expect ? ' (expected ' + expect + ')' : ''));
    return;
  }
  for (const p of problems) console.log('GATE: ' + p);
  process.exitCode = 1;
}

try { main(); } catch (err) {
  console.error('GATE: cannot certify this store: ' + err.message);
  process.exitCode = 2;
}
