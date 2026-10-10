// Oracle for the Run 3 session gate (`experiments/egress-benchmark/run-3-session-gate.cjs`).
//
// The gate is what certifies an arm's measurement from session-scoped evidence, so a silent
// regression in it fails open: a contaminated arm would be reported as clean, or a crashed run
// certified as complete. Every verdict it can reach is pinned here, and each fixture is a
// synthesised multi-frame store written to a temp directory -- no live `~/.dsh` store is read or
// touched, which is also why these tests are safe to run under the oracle isolation preload.
//
// Why the corruption cases matter, measured 2026-10-10 against checksummed frames of the kind this
// host writes (descriptor 0x04, content checksum set, no content-size field):
//
//   truncate the last frame by 8 bytes    -> zstdDecompressSync returns 0 bytes, no error
//   truncate a frame at a record boundary -> the frame is simply absent, no error
//   flip one payload byte                 -> throws ZSTD_error_checksum_wrong
//
// So a torn store decodes quietly, and before this oracle existed the gate accepted one: the
// trailing `turn/end` it found was merely an earlier completed turn. R1 (a frame that decodes to
// zero bytes) and R2 (decoded text must end at a record boundary) close that. R3 (every line must
// parse) closes the same hole from the other side, since the decoder used to drop unparseable lines
// silently.
//
// What is deliberately NOT asserted as a failure: a truncation that removes whole frames leaves a
// valid shorter log, indistinguishable from a session that simply ended earlier. That case is pinned
// as the documented limit it is (test 7), not papered over.
process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const PLUGIN = path.resolve(__dirname, '..', '..');
const REPO = path.resolve(PLUGIN, '..');
const GATE = path.join(REPO, 'experiments', 'egress-benchmark', 'run-3-session-gate.cjs');

/** Frames carrying a content checksum, like the host's (descriptor 0x24 vs the host's 0x04). */
const CHECKSUMMED = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };

const SESSION_ID = 'session-fixture-0000-0000-000000000000';

const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'), CHECKSUMMED);
const line = (record) => frame(JSON.stringify(record) + '\n');

const head = () => ({
  type: 'session', version: 3, id: SESSION_ID, createdAt: 1,
  cwd: 'C:\\fixture', isSeeded: false, delegationDepth: 0,
});
const request = (provider, model, reasoningEffort) => ({
  type: 'request/header', seq: 1, time: 1,
  data: { header: { config: { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}), maxTokens: 1000 } } },
});
const completed = (turn) => ({ type: 'turn/end', seq: turn, time: turn, data: { turn, reason: { kind: 'completed' } } });
const effortFailure = (turn) => ({
  type: 'turn/end', seq: turn, time: turn,
  data: {
    turn,
    reason: {
      kind: 'error',
      error: {
        message: 'provider "lm-studio" model "qwen/qwen3.8-27b" does not support reasoning effort "high"',
        code: 'UNSUPPORTED_REASONING_EFFORT',
      },
    },
  },
});

/** Write a synthesised store and return its path; caller cleans the directory up. */
function store(records, mutate) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gate-oracle-'));
  const file = path.join(dir, 'session.v3.jsonl.zstd');
  let buf = Buffer.concat(records.map(line));
  if (mutate) buf = mutate(buf);
  fs.writeFileSync(file, buf);
  return { dir, file };
}

/** Run the gate and capture its exit code with all of its output. */
function gate(args, env) {
  try {
    const stdout = execFileSync(process.execPath, [GATE, ...args], {
      encoding: 'utf8',
      env: { ...process.env, ...(env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, out: stdout };
  } catch (err) {
    return { code: err.status, out: String(err.stdout || '') + String(err.stderr || '') };
  }
}

function withStore(t, records, mutate) {
  const made = store(records, mutate);
  t.after(() => fs.rmSync(made.dir, { recursive: true, force: true }));
  return made.file;
}

const CLEAN_ARM_A = [
  head(),
  request('deepseek-official', 'deepseek-chat'),
  completed(1),
  request('deepseek-official', 'deepseek-flash'),
  completed(2),
];

test('a clean cloud baseline certifies as arm A', (t) => {
  const file = withStore(t, CLEAN_ARM_A);
  const { code, out } = gate([file, '--arm', 'A']);
  assert.equal(code, 0, 'a cloud-only session must certify: ' + out);
  assert.match(out, /requests to lm-studio\s+: 0/);
  assert.match(out, /GATE: ok \(expected cloud\)/);
});

test('a session that dispatched locally is rejected as a contaminated arm A', (t) => {
  // The pin's post-fcb9340 signature: it reaches dispatch, so it writes a header.
  const file = withStore(t, [
    head(),
    request('deepseek-official', 'deepseek-chat'),
    completed(1),
    request('lm-studio', 'qwen/qwen3.8-27b', 'high'),
    completed(2),
  ]);
  const { code, out } = gate([file, '--arm', 'A']);
  assert.equal(code, 1, 'a silent local drop must fail the arm A gate: ' + out);
  assert.match(out, /CONTAMINATED by a DLP pin/);
});

test('the pre-fcb9340 failure is reported as the pin, not as a clean session', (t) => {
  // Before fcb9340 a pinned request was refused before dispatch, so it wrote NO header: the only
  // session-scoped trace is the error turn. This is the shape that must never read as "clean".
  const file = withStore(t, [head(), request('deepseek-official', 'deepseek-chat'), effortFailure(1)]);
  const { code, out } = gate([file, '--arm', 'B']);
  assert.equal(code, 1, 'the error turn must fail the gate: ' + out);
  assert.match(out, /UNSUPPORTED_REASONING_EFFORT : 1/);
  assert.match(out, /GATE: 1 turn\(s\) ended UNSUPPORTED_REASONING_EFFORT/);
  assert.match(out, /requests to lm-studio\s+: 0/, 'and it must show that no header was written');
});

test('a post-fcb9340 pin certifies as arm B: local dispatch, effort dropped, turn completed', (t) => {
  const file = withStore(t, [
    head(),
    request('deepseek-official', 'deepseek-chat'),
    completed(1),
    request('lm-studio', 'qwen/qwen3.8-27b'), // no reasoningEffort: the fix's signature
    completed(2),
  ]);
  const { code, out } = gate([file, '--arm', 'B']);
  assert.equal(code, 0, 'the fixed pin must certify: ' + out);
  assert.match(out, /requests to lm-studio\s+: 1/);
  assert.match(out, /still carrying reasoningEffort : 0/);
  assert.match(out, /GATE: ok \(expected local\)/);
});

test('a pinned request still carrying the effort is reported as fcb9340 not loaded', (t) => {
  const file = withStore(t, [
    head(),
    request('deepseek-official', 'deepseek-chat'),
    completed(1),
    request('lm-studio', 'qwen/qwen3.8-27b', 'high'),
    completed(2),
  ]);
  const { code, out } = gate([file, '--arm', 'B']);
  assert.equal(code, 1, 'an awol fix must not certify: ' + out);
  assert.match(out, /fcb9340 is not loaded/);
  assert.match(out, /still carrying reasoningEffort : 1/);
});

test('arm B with no local dispatch at all reports the missing evidence', (t) => {
  const file = withStore(t, CLEAN_ARM_A);
  const { code, out } = gate([file, '--arm', 'B']);
  assert.equal(code, 1, 'arm B cannot be certified without session-scoped pin evidence: ' + out);
  assert.match(out, /no request dispatched to lm-studio/);
});

test('a torn final frame is refused rather than decoded to a prefix', (t) => {
  // Measured: this truncation decodes to 0 bytes with no error, so without R1 the gate would find
  // an earlier completed turn and report success on a crashed run.
  const file = withStore(t, CLEAN_ARM_A, (buf) => buf.subarray(0, buf.length - 8));
  const { code, out } = gate([file, '--arm', 'A']);
  assert.equal(code, 2, 'a torn store must not be certified: ' + out);
  assert.match(out, /cannot certify this store/);
  assert.match(out, /torn|zero bytes|checksum|not JSON/);
});

test('a payload bit flip is refused by the frame checksum', (t) => {
  const file = withStore(t, CLEAN_ARM_A, (buf) => {
    const copy = Buffer.from(buf);
    copy[copy.length - 20] ^= 0xff;
    return copy;
  });
  const { code, out } = gate([file, '--arm', 'A']);
  assert.equal(code, 2, 'a corrupted frame must not be certified: ' + out);
  assert.match(out, /cannot certify this store/);
});

test('a decoded line that is not JSON is refused rather than skipped', (t) => {
  // R3. The decoder used to drop unparseable lines, so a store could be certified on a subset of its
  // own records.
  const file = withStore(t, [head(), request('deepseek-official', 'deepseek-chat'), completed(1)],
    (buf) => Buffer.concat([buf, frame('{"type":"turn/end","seq":9}\nTHIS IS NOT JSON\n')]));
  const { code, out } = gate([file, '--arm', 'A']);
  assert.equal(code, 2, 'unjparseable content must not be certified: ' + out);
  assert.match(out, /not JSON/);
});

test('a truncation that removes whole frames is a valid shorter log, and is not detected', (t) => {
  // Documented limit, pinned rather than papered over: a frame header declares its decompressed
  // size, not its compressed length, and the magic walk cannot know that bytes are missing. The
  // gate's guarantee covers a TORN frame (test 7), which is the crash pattern, not a missing one.
  const whole = store(CLEAN_ARM_A);
  const last = zlib.zstdDecompressSync; // keep the reference for clarity of intent below
  assert.equal(typeof last, 'function');
  const buf = fs.readFileSync(whole.file);
  const starts = [];
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) starts.push(i);
  }
  fs.writeFileSync(whole.file, buf.subarray(0, starts[starts.length - 1]));
  t.after(() => fs.rmSync(whole.dir, { recursive: true, force: true }));

  const { code, out } = gate([whole.file, '--arm', 'A']);
  assert.equal(code, 0, 'a valid prefix of a store is not distinguishable from a shorter session: ' + out);
  assert.match(out, /records: 4/, 'and it reports only the records it can actually see');
});

test('--session resolves the store under DSH_HOME', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-gate-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'sessions', '--C-fixture--', SESSION_ID);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.v3.jsonl.zstd'), Buffer.concat(CLEAN_ARM_A.map(line)));

  const { code, out } = gate(['--session', SESSION_ID, '--arm', 'A'], { DSH_HOME: home });
  assert.equal(code, 0, 'the session-scoped invocation must certify the same store: ' + out);
  assert.match(out, new RegExp('session\\s+: ' + SESSION_ID));
});

test('an unknown flag is rejected instead of silently dropping the expectation', (t) => {
  // A typo such as `--Arm A` would otherwise skip the arm assertion and still report a green gate.
  const file = withStore(t, CLEAN_ARM_A);
  const { code, out } = gate([file, '--Arm', 'A']);
  assert.equal(code, 2, 'an unrecognised flag must not be ignored: ' + out);
  assert.match(out, /unknown flag/);
});

test('a store path and --session together are rejected', (t) => {
  const file = withStore(t, CLEAN_ARM_A);
  const { code, out } = gate([file, '--session', SESSION_ID]);
  assert.equal(code, 2, 'ambiguous addressing must be rejected: ' + out);
  assert.match(out, /not both/);
});
