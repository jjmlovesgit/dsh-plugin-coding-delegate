// Contract oracle: a delegation's OUTCOME is persisted, so absorbed churn becomes countable.
//
// The ledger records tokens and a routing reason per delegation, but nothing saying whether the unit
// succeeded. Without that, "how many failed attempts and retries did the architect never have to see"
// -- the noisiest thing this plugin keeps out of the window -- cannot be answered at all.
//
// Two properties are asserted:
//   1. A unit that failed is recorded as a failed attempt. That is what makes retries countable.
//   2. A unit that wrote files records the bytes it produced, which is content the architect never saw.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

// The tracker is given an explicit base directory, so nothing here touches the operator's real ledger.
const LEDGER_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-data-'));
process.env.DSH_LOCAL_ROUTER_DATA_DIR = LEDGER_DIR;

const PLUGIN = path.resolve(__dirname, '..', '..');
const DIST = PLUGIN + '/dist/index.js';
const LEDGER = path.join(LEDGER_DIR, 'savings-ledger.json');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-ledger-'));
const emitted = (name) => '```ts file="' + name + '"\nexport const made = 1\nexport const also = 2\n```\n';

function write(dir, name, body) {
  const file = path.join(dir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return file;
}

const ALLOW = {
  mode: 'allow',
  allowlist: [],
  allowInProcessFallback: false,
  timeoutMs: 30000,
};

/** A runner that prints one TAP failure, so the unit fails verification. */
function failingScript(dir) {
  return write(
    dir,
    'fail.js',
    [
      "console.log('not ok 1 - the unit broke');",
      "console.log('  ---');",
      "console.log('  code: ERR_ASSERTION');",
      "console.log('  error: expected 1 to equal 2');",
      "console.log('  ...');",
    ].join('\n')
  );
}

async function runAgainstWorker(content, params, tracker) {
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
      tracker
    );
  } finally {
    server.close();
  }
}

function readLedger() {
  return JSON.parse(fs.readFileSync(LEDGER, 'utf8'));
}

test('a unit that failed is recorded as a failed attempt, so retries are countable', async () => {
  const { SavingsTracker } = require(DIST);
  const dir = tmp();
  failingScript(dir);
  const tracker = new SavingsTracker(LEDGER_DIR);

  const verdict = await runAgainstWorker(emitted('out.ts'), {
    taskName: 'ledger-fail',
    instruction: 'Change the thing.',
    targetFiles: ['out.ts'],
    workspaceDir: dir,
    runVerification: 'node fail.js',
    redactVerification: true,
    verificationPolicy: ALLOW,
  }, tracker);
  assert.equal(verdict.success, false, 'the unit failed');

  const ledger = readLedger();
  assert.ok(ledger.delegations >= 1, 'the delegation was recorded at all');
  assert.ok(ledger.failedDelegations >= 1, 'and it was recorded as a FAILED attempt');

  const record = ledger.history.find((r) => r.routingReason && r.routingReason.includes('ledger-fail'));
  assert.ok(record, 'the record for this delegation exists');
  assert.equal(record.succeeded, false, 'the record carries the outcome');
  assert.ok(typeof record.outcome === 'string' && record.outcome.length > 0, 'and names it');
});

test('a unit that wrote files records the bytes the architect never saw', async () => {
  const { SavingsTracker } = require(DIST);
  const dir = tmp();
  const tracker = new SavingsTracker(LEDGER_DIR);
  const before = readLedger();
  const bytesBefore = before.bytesKeptOut || 0;

  const verdict = await runAgainstWorker(emitted('kept.ts'), {
    taskName: 'ledger-pass',
    instruction: 'Write kept.ts.',
    targetFiles: ['kept.ts'],
    workspaceDir: dir,
    // A passing verification, because an UNVERIFIED unit is deliberately NOT a success in this plugin:
    // `unitSuccess` excludes it, so only a verified unit can be asserted to have succeeded.
    runVerification: 'node -e "process.exit(0)"',
    verificationPolicy: ALLOW,
  }, tracker);
  assert.equal(verdict.filesWritten.length, 1, 'the file was written');

  const ledger = readLedger();
  assert.ok(
    (ledger.bytesKeptOut || 0) > bytesBefore,
    'bytes kept out should grow: before=' +
      bytesBefore +
      ' after=' +
      (ledger.bytesKeptOut || 0) +
      ' lastRecord=' +
      JSON.stringify(ledger.history[ledger.history.length - 1])
  );

  const record = ledger.history.find((r) => r.routingReason && r.routingReason.includes('ledger-pass'));
  assert.ok(record, 'the record for this delegation exists');
  assert.equal(record.succeeded, true, 'a unit with no verification is still recorded with its verdict');
  assert.ok(record.bytesWritten > 0, 'and with the bytes it wrote');
});

test('the ledger says what it covers, so it is not read as a session record', () => {
  const ledger = readLedger();
  assert.ok(
    typeof ledger.scope === 'string' && ledger.scope.length > 0,
    'the ledger must state its own scope rather than implying one'
  );
});

test('an UNVERIFIED unit is not counted as a failed attempt', async () => {
  const { SavingsTracker } = require(DIST);
  const dir = tmp();
  const tracker = new SavingsTracker(LEDGER_DIR);
  const before = readLedger();
  const failedBefore = before.failedDelegations || 0;

  const verdict = await runAgainstWorker(emitted('unverified.ts'), {
    taskName: 'ledger-unverified',
    instruction: 'Write unverified.ts.',
    targetFiles: ['unverified.ts'],
    workspaceDir: dir,
  }, tracker);
  assert.equal(verdict.status, 'UNVERIFIED', 'no verification was requested');

  const ledger = readLedger();
  const record = ledger.history.find(
    (r) => r.routingReason && r.routingReason.includes('ledger-unverified')
  );
  assert.ok(record, 'the record exists');
  assert.equal(record.succeeded, false, 'unverified is deliberately not a success');
  assert.notEqual(record.outcome, 'UNIT_FAILED', 'but it is not a failure either');
  assert.equal(
    ledger.failedDelegations || 0,
    failedBefore,
    'so an unverified unit must not inflate the count of absorbed failures'
  );
});

test('the hygiene summary compounds kept-out content across the session model calls', () => {
  const { SavingsTracker } = require(DIST);
  const tracker = new SavingsTracker(LEDGER_DIR);

  // 3800 bytes, which at this codebase's own 3.8-chars-per-token estimator is 1000 tokens.
  tracker.recordUsage({
    route: 'WORKER_LOCAL',
    model: 'qwen/qwen3.8-27b',
    reason: 'SUBAGENT_DELEGATION (hygiene-probe)',
    promptTokens: 100,
    completionTokens: 50,
    totalTokens: 150,
    outcome: 'UNIT_PASSED',
    succeeded: true,
    bytesWritten: 3800,
  });

  const few = tracker.contextHygiene(10);
  const many = tracker.contextHygiene(1000);

  assert.ok(few.bytesKeptOut >= 3800, 'kept-out bytes are reported');
  assert.ok(few.tokensKeptOut > 0, 'and converted to tokens');
  assert.equal(many.modelCalls, 1000, 'the call count is echoed');
  assert.equal(
    many.carriedTokens,
    many.tokensKeptOut * many.modelCalls,
    'the carry is the kept-out tokens times the calls they would have ridden on'
  );
  assert.ok(
    many.carriedTokens > few.carriedTokens,
    'so the figure compounds as the session goes on rather than staying flat'
  );
  assert.match(many.line, /upper bound/i, 'and it says it is a bound, because it is one');
  assert.match(many.line, new RegExp(String(many.bytesKeptOut)), 'the line carries the byte figure');
});
