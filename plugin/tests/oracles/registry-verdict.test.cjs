// Contract oracle: a delegation's VERDICT reaches the file records that delegation produced.
//
// The registry answers "which files did the worker write, and what is in them (sha256)"; the ledger
// answers "did the unit pass". Both are written by the same call, and until now nothing joined them: a
// per-file hash could not be connected to a per-unit verdict, so "is this file settled?" -- the question
// that decides whether reading it back is noise or legitimate review -- had no answer at all.
//
// Four properties:
//   1. A passing unit stamps UNIT_PASSED/true onto the records for the files it wrote.
//   2. A failing unit stamps UNIT_FAILED/false, so the file is not treated as settled.
//   3. An unverified unit stamps UNIT_UNVERIFIED/false: not a pass, and deliberately not a failure.
//   4. The verdict survives a save/load round trip, and an unrecognised verdict is refused rather than
//      trusted. A field that is written and then dropped on load is a silent absence, which is how this
//      class of defect presents, so the round trip is asserted and not assumed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// An explicit data directory, so nothing here touches the operator's real registry.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verdict-data-'));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = DATA_DIR;

const PLUGIN = path.resolve(__dirname, '..', '..');
const DIST = PLUGIN + '/dist/index.js';
const CONTRACTS = PLUGIN + '/dist/contracts.js';
const REGISTRY = path.join(DATA_DIR, 'delegated-registry.json');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-verdict-'));
const emitted = (name) =>
  '```ts file="' + name + '"\nexport const made = 1\nexport const also = 2\n```\n';

function write(dir, name, body) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const ALLOW = { mode: 'allow', allowlist: [], allowInProcessFallback: false, timeoutMs: 30000 };

/** A runner that prints one TAP failure, so the unit fails verification. */
const FAILING = [
  "console.log('not ok 1 - the unit broke');",
  "console.log('  ---');",
  "console.log('  code: ERR_ASSERTION');",
  "console.log('  error: expected 1 to equal 2');",
  "console.log('  ...');",
].join('\n');

async function runAgainstWorker(content, params) {
  const { delegateWorker } = require(DIST);
  const server = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content } }],
          usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    return await delegateWorker(
      { ...params, endpoint: 'http://127.0.0.1:' + port + '/v1', timeoutMs: 15000 },
      new (require(DIST).SavingsTracker)(DATA_DIR)
    );
  } finally {
    server.close();
  }
}

/** The registry record for one written file, as it was persisted to disk. */
function registryRecord(filename) {
  const text = fs.readFileSync(REGISTRY, 'utf8');
  const found = (JSON.parse(text).records || []).find((r) => String(r.path).endsWith(filename));
  assert.ok(found, 'the registry must carry a record for ' + filename + ': ' + text.slice(0, 400));
  return found;
}

test('a passing unit stamps its verdict onto the records it wrote', async () => {
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted('passed.ts'), {
    taskName: 'verdict-pass',
    instruction: 'Write passed.ts.',
    targetFiles: ['passed.ts'],
    workspaceDir: dir,
    runVerification: 'node -e "process.exit(0)"',
    verificationPolicy: ALLOW,
  });
  assert.equal(verdict.success, true, 'the unit passed');

  const record = registryRecord('passed.ts');
  assert.equal(record.outcome, 'UNIT_PASSED', 'the verdict must reach the file record');
  assert.equal(record.succeeded, true, 'and so must its success flag');
  assert.ok(Number(record.verdictAt) > 0, 'stamped with when the verdict was reached');
});

test('a failing unit stamps UNIT_FAILED, so the file is not read back as settled', async () => {
  const dir = tmp();
  write(dir, 'fail.js', FAILING);
  const verdict = await runAgainstWorker(emitted('broken.ts'), {
    taskName: 'verdict-fail',
    instruction: 'Write broken.ts.',
    targetFiles: ['broken.ts'],
    workspaceDir: dir,
    runVerification: 'node fail.js',
    redactVerification: true,
    verificationPolicy: ALLOW,
  });
  assert.equal(verdict.success, false, 'the unit failed');

  const record = registryRecord('broken.ts');
  assert.equal(record.outcome, 'UNIT_FAILED', 'a failed unit leaves an unsettled file');
  assert.equal(record.succeeded, false, 'and the record says so');
});

test('an unverified unit stamps UNIT_UNVERIFIED, which is neither a pass nor a failure', async () => {
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted('maybe.ts'), {
    taskName: 'verdict-unverified',
    instruction: 'Write maybe.ts.',
    targetFiles: ['maybe.ts'],
    workspaceDir: dir,
  });
  assert.equal(verdict.status, 'UNVERIFIED', 'no verification was requested');

  const record = registryRecord('maybe.ts');
  assert.equal(record.outcome, 'UNIT_UNVERIFIED', 'unverified is its own verdict');
  assert.equal(record.succeeded, false, 'and never a success');
});

test('a verification that was never APPROVED stamps UNIT_UNVERIFIED, not UNIT_FAILED', async () => {
  // Found by running the delegation experiment, not by reasoning about it.
  //
  // A command was supplied, so `unverified` is false and the gate is what stopped it. The status was
  // already right -- VERIFICATION_NOT_APPROVED, because nothing ran -- but the OUTCOME collapsed it to
  // UNIT_FAILED, and `UNIT_FAILED` is what the read guard turns into "the unit that wrote it failed
  // verification". That message was untrue: the unit's tests were never executed, so nothing was
  // disproven. Two different facts -- "it ran and failed" and "it never ran" -- were sharing one label,
  // and the label asserted the first.
  //
  // The default policy is `mode: 'ask'` with no approver, which is exactly the operator case of a
  // refusal, so this needs no special setup: it is what an unapproved delegation actually does.
  const dir = tmp();
  const verdict = await runAgainstWorker(emitted('unapproved.ts'), {
    taskName: 'verdict-not-approved',
    instruction: 'Write unapproved.ts.',
    targetFiles: ['unapproved.ts'],
    workspaceDir: dir,
    runVerification: 'node checks.js',
  });

  assert.equal(verdict.status, 'VERIFICATION_NOT_APPROVED', 'nothing ran, so the outcome is unknown');
  assert.match(String(verdict.verificationSkipped), /approval was not granted/, 'and it says why');

  const record = registryRecord('unapproved.ts');
  assert.equal(
    record.outcome,
    'UNIT_UNVERIFIED',
    'a unit whose check never ran is unverified -- it must not be recorded as having failed'
  );
  assert.equal(record.succeeded, false, 'and it is still not a success');
});

test('the verdict survives a save/load round trip, and an unknown one is refused', () => {
  const { parseDelegatedRegistry } = require(CONTRACTS);
  const parsed = parseDelegatedRegistry(
    JSON.stringify({
      version: 1,
      records: [
        {
          path: 'C:/ws/a.ts',
          sha256: 'aa',
          at: 5,
          mode: 'created',
          outcome: 'UNIT_PASSED',
          succeeded: true,
          verdictAt: 9,
        },
        { path: 'C:/ws/b.ts', sha256: 'bb', at: 6, mode: 'created', outcome: 'NOT_A_VERDICT', succeeded: true },
        { path: 'C:/ws/c.ts', sha256: 'cc', at: 7, mode: 'created' },
      ],
    })
  );

  assert.equal(parsed.length, 3, 'every record still loads');
  assert.equal(parsed[0].outcome, 'UNIT_PASSED', 'a known verdict round-trips');
  assert.equal(parsed[0].succeeded, true, 'and so does its flag');
  assert.equal(parsed[0].verdictAt, 9, 'and when it was reached');
  assert.equal(parsed[1].outcome, undefined, 'an unrecognised verdict is dropped rather than trusted');
  assert.equal(parsed[1].succeeded, undefined, 'and it must not smuggle a success flag past that refusal');
  assert.equal(parsed[2].outcome, undefined, 'a record written before this field existed still loads');
  assert.equal(parsed[2].sha256, 'cc', 'and keeps everything it did carry');
});

test('a fresh delegation for the same file does not inherit the old verdict', () => {
  // A regression guard rather than a red-to-green test: the verdict covers the CONTENT that was verified,
  // so once the file is rewritten the old verdict describes bytes that no longer exist. Newest-wins per
  // path is what makes that fall out, and this pins it.
  const { mergeDelegatedRecords } = require(CONTRACTS);
  const stamped = {
    path: 'C:/ws/d.ts',
    sha256: 'dd',
    at: 100,
    mode: 'created',
    outcome: 'UNIT_PASSED',
    succeeded: true,
    verdictAt: 150,
  };
  const rewritten = { path: 'C:/ws/d.ts', sha256: 'ee', at: 200, mode: 'created' };

  const merged = mergeDelegatedRecords([stamped], [rewritten]);
  assert.equal(merged.length, 1, 'one record per file, however it is spelled');
  assert.equal(merged[0].sha256, 'ee', 'the newer write wins');
  assert.equal(
    merged[0].outcome,
    undefined,
    'and the verdict does not survive it, because the content it covered is gone'
  );
});
