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
 * Frame format: DSH writes a concatenation of independent Zstandard frames -- one for the header,
 * one per append batch -- each with the content-checksum flag set (frame-header descriptor 0x04).
 * `zlib.zstdDecompressSync` decodes only the FIRST frame, so every frame is walked by its magic
 * offset here. Node's own `zstdCompressSync` writes checksum-less frames (descriptor 0x20); a log
 * carrying those is not the byte stream this host produces.
 *
 * Usage:
 *   node run-3-session-gate.cjs <session.v3.jsonl.zstd> [--expect cloud|local]
 *
 *   --expect cloud   arm A: this session must have dispatched NO request to the local provider
 *   --expect local    arm B after a pin: at least one local request, none carrying reasoningEffort
 *   (omitted)        report only; the trailing-turn assertion still decides the exit code
 *
 * Exit codes: 0 = the recorded facts match the expectation, 1 = they do not, 2 = the file could not
 * be read as a session store. Run it as a direct `node <file>`: `node --test` needs to spawn a child
 * process, which the workspace sandbox refuses with `spawn EPERM`.
 */
'use strict';

const fs = require('node:fs');
const zlib = require('node:zlib');

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const LOCAL_PROVIDER = 'lm-studio';
const UNSUPPORTED = 'UNSUPPORTED_REASONING_EFFORT';

/** Decode every frame in the store, in order. */
function decodeAllFrames(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] &&
        buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) starts.push(i);
  }
  if (starts.length === 0) throw new Error('no zstandard frames found');
  if (starts[0] !== 0) throw new Error('first frame does not start at offset 0');
  const parts = [];
  for (let k = 0; k < starts.length; k++) {
    const from = starts[k];
    const to = k + 1 < starts.length ? starts[k + 1] : buf.length;
    parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)));
  }
  return { text: Buffer.concat(parts).toString('utf8'), frames: starts.length };
}

function main() {
  const argv = process.argv.slice(2);
  const file = argv.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('usage: node run-3-session-gate.cjs <session.v3.jsonl.zstd> [--expect cloud|local]');
    process.exitCode = 2;
    return;
  }
  const expectIndex = argv.indexOf('--expect');
  const expect = expectIndex >= 0 ? argv[expectIndex + 1] : undefined;
  if (expect !== undefined && expect !== 'cloud' && expect !== 'local') {
    console.error('--expect takes cloud or local');
    process.exitCode = 2;
    return;
  }

  const { text, frames } = decodeAllFrames(fs.readFileSync(file));
  const rows = text.split('\n').filter(Boolean)
    .map((line) => { try { return JSON.parse(line); } catch { return null; } })
    .filter(Boolean);

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
  if (expect === 'local') {
    if (localRequests.length === 0) {
      problems.push('--expect local but no request dispatched to ' + LOCAL_PROVIDER);
    }
    if (localWithEffort.length > 0) {
      problems.push(localWithEffort.length + ' pinned request(s) still carry reasoningEffort: fcb9340 is not loaded');
    }
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
  console.error('GATE: cannot read this store: ' + err.message);
  process.exitCode = 2;
}
