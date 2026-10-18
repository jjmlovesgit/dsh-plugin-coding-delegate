// Oracle: a non-2xx worker response is bounded before it reaches a message.
//
// Why this is a contract and not a nicety: every other string this pipeline appends is bounded
// upstream. The worker's completion is capped by `max_tokens`, the verification log by
// `parseTestOutput` (2000 chars, raw text on disk), and injected context by a byte budget that
// refuses rather than truncates. The error body had no such bound: `response.text()` returns
// whatever the endpoint sent, and that string went straight into `message` -- which enters the
// conversation and is re-sent on every later turn. A misconfigured endpoint, a proxy's HTML error
// page or an LM Studio traceback is therefore a prompt-sized write with a tool call as its trigger.
//
// The properties:
//   1. Anything at or under the cap is passed through byte for byte, so the ordinary case is
//      unchanged and a short, useful error is still fully readable.
//   2. Anything over it is cut at the cap and marked, so the reader knows text is missing rather
//      than assuming the body ended there.
//   3. The built artefact enforces it against a real HTTP response, not just the helper -- the
//      hole was at the call site, so a passing helper proves nothing on its own.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const http = require('node:http');

const PLUGIN = path.resolve(__dirname, '..', '..');
const { MAX_ERROR_BODY_CHARS, truncateErrorBody, delegateWorker } = require(PLUGIN + '/dist/delegation.js');

const MARKER = ' [truncated]';

test('the cap is exported and matches the verification output bound', () => {
  assert.equal(MAX_ERROR_BODY_CHARS, 2000);
});

test('a short body is passed through unchanged', () => {
  const short = '{"error":{"message":"model not loaded"}}';
  assert.equal(truncateErrorBody(short), short);
});

test('a body exactly at the cap is not marked as truncated', () => {
  const exact = 'x'.repeat(MAX_ERROR_BODY_CHARS);
  const out = truncateErrorBody(exact);
  assert.equal(out, exact);
  assert.doesNotMatch(out, /\[truncated\]/);
});

test('one character over the cap is cut and marked', () => {
  const over = 'x'.repeat(MAX_ERROR_BODY_CHARS + 1);
  const out = truncateErrorBody(over);
  assert.equal(out.length, MAX_ERROR_BODY_CHARS + MARKER.length);
  assert.ok(out.endsWith(MARKER), 'the marker must be the last thing a reader sees');
  assert.equal(out.slice(0, MAX_ERROR_BODY_CHARS), 'x'.repeat(MAX_ERROR_BODY_CHARS));
});

test('a non-string body cannot throw and cannot grow', () => {
  assert.equal(truncateErrorBody(undefined), '');
  assert.equal(truncateErrorBody(null), '');
  assert.equal(truncateErrorBody(500), '500');
});

function startFailingServer(body) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(500, { 'content-type': 'text/html' });
        res.end(body);
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

test('a 100 KB HTML error page reaches the message as 2000 characters plus a marker', async () => {
  const page = '<html><body>' + 'trace '.repeat(20000) + '</body></html>';
  assert.ok(page.length > 100000, 'the fixture must be large enough to be a real flood');
  const { server, port } = await startFailingServer(page);
  try {
    const result = await delegateWorker({
      endpoint: 'http://127.0.0.1:' + port + '/v1',
      instruction: 'this unit fails at the transport layer',
    });

    assert.equal(result.success, false);
    assert.equal(result.status, 'ERROR');
    assert.match(result.message, /HTTP 500/, 'the status code must survive the cut');
    assert.match(result.message, /\[truncated\]/, 'the cut must be disclosed');
    assert.ok(
      result.message.length < MAX_ERROR_BODY_CHARS + 100,
      'the message must stay near the cap, got ' + result.message.length
    );
    assert.ok(!result.message.includes('</body>'), 'the tail of the body must not survive');
  } finally {
    server.closeAllConnections?.();
    server.close();
  }
});
