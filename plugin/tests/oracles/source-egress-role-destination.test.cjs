// Regression oracles for SECURITY-REVIEW-5, findings 1 and 4, driven through the mounted plugin so the
// check is the real `agent/request` handler rather than a re-implementation of it.
//
// F1 pre-role destination desync: the source-egress gate read `classification.destination`, and the
//    classification is computed from the provider the HOST selected -- before `applyAgentRole` repins the
//    request to `cloudProvider` for the architect. A session whose host provider was the local worker
//    therefore carried 'local' into rule 8, and `evaluateSourceEgress` allowed detected source out with
//    the reason "nothing is leaving the machine" while the payload went to the cloud. Measured before the
//    fix: the architect case below RESOLVED with the source in it.
//
// F4 entropy-triggered sticky DLP: the session marker added for SECURITY-REVIEW-4 [6] was set on
//    `hasSensitiveData`, which is true for an entropy-only hit too -- a base64 blob, a digest, a UUID. A
//    remembered session forces `entropyOnly` false, which routes the classifier into its high-confidence
//    refusal, so ONE random-looking token pinned the whole session into hard-blocking every later prompt
//    instead of the medium-confidence soft landing (reroute local, never transmitted) that the entropy
//    backstop is designed to give.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// The plugin resolves its log/data directory from DSH_HOME at require time, so point it at a scratch
// directory before loading the module -- the same preload the other mounted oracles use.
process.env.DSH_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-home-"));
process.env.NODE_ENV = "test";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const PLUGIN = path.resolve(__dirname, "..", "..");
const { apply } = require(PLUGIN + "/dist/index.js");

function mount(options) {
  const handlers = new Map();
  const ctx = {
    on: (event, handler) => {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event).push(handler);
    },
    get: () => undefined,
    tools: undefined,
  };
  apply(ctx, options);
  return handlers;
}

const BASE_OPTIONS = {
  localCodeGuard: false,
  enforceDLP: true,
  dlpAction: "local",
  localProvider: "lm-studio",
  cloudProvider: "deepseek-official",
  localModel: "qwen/qwen3.8-27b",
  cloudModel: "deepseek-chat",
  sourceEgress: "deny",
  sourceEgressMinLines: 3,
};

// A fenced block `detectSourceEgress` counts: a known source language with at least `sourceEgressMinLines`
// lines. Written out rather than generated so a failure diff shows the payload that was judged.
const SOURCE_BLOCK = [
  '```ts',
  'export function total(items: number[]): number {',
  '  let sum = 0',
  '  for (const item of items) sum += item',
  '  return sum',
  '}',
  '```',
].join('\n');

// A pattern rule match ('Generic Secret Keyword'), so `highConfidence` is true.
const SECRET = 'password: "hunter2hunter2"';
// A bare 40-character random token: no keyword, no vendor prefix, so the ONLY rule that sees it is the
// entropy backstop -- `highConfidence` is false for this one, which is the whole distinction under test.
const ENTROPY_ONLY = 'Q7xR2mB9vT4pL8kZ3nW6yH1sD5gJ0aC4eF2uI7oP';

const enter = async () => ({ kind: 'enter' });

test('F1: source stays refused when the architect role repins the request to the cloud', async () => {
  const handlers = mount(BASE_OPTIONS);
  const preStep = handlers.get('agent/pre-step')[0];
  const request = handlers.get('agent/request')[0];
  const agent = { id: 'host-pinned-local' };

  await preStep(
    { turn: 1, agent, messages: [{ role: 'user', content: SOURCE_BLOCK }] },
    enter
  );

  // The host offers the LOCAL worker. Nothing in the options declares `lm-studio` a lead provider, so the
  // role is architect and `applyArchitectConfig` repins the request to `cloudProvider`: the payload leaves
  // the machine. The classifier, asked earlier, said 'local'.
  await assert.rejects(
    () =>
      request({ turn: 1, agent, step: 1 }, async () => ({
        provider: 'lm-studio',
        model: 'qwen/qwen3.8-27b',
        tools: [],
      })),
    /Source may not reach the cloud \(rule 8\)/,
    'the destination must be read from the provider the request is actually sent with'
  );
});

test('F1 control: the same source on a lead left local is not egress', async () => {
  const handlers = mount({ ...BASE_OPTIONS, leadProviders: ['lm-studio'] });
  const preStep = handlers.get('agent/pre-step')[0];
  const request = handlers.get('agent/request')[0];
  const agent = { id: 'lead-left-local' };

  await preStep(
    { turn: 1, agent, messages: [{ role: 'user', content: SOURCE_BLOCK }] },
    enter
  );

  // `applyAgentRole` returns a lead request unchanged, so the payload really does go to the local worker
  // and rule 8 has nothing to refuse. Without this control the check above could pass by refusing every
  // request that carries source, which is not the policy.
  const config = await request({ turn: 1, agent, step: 1 }, async () => ({
    provider: 'lm-studio',
    model: 'qwen/qwen3.8-27b',
    tools: [],
  }));

  assert.equal(config.provider, 'lm-studio', 'a lead request is left on the provider the host chose');
});

test('F1 control: source bound for the cloud is refused with no role repin involved', async () => {
  const handlers = mount(BASE_OPTIONS);
  const preStep = handlers.get('agent/pre-step')[0];
  const request = handlers.get('agent/request')[0];
  const agent = { id: 'cloud-host' };

  await preStep(
    { turn: 1, agent, messages: [{ role: 'user', content: SOURCE_BLOCK }] },
    enter
  );

  await assert.rejects(
    () =>
      request({ turn: 1, agent, step: 1 }, async () => ({
        provider: 'deepseek-official',
        model: 'deepseek-chat',
        tools: [],
      })),
    /Source may not reach the cloud \(rule 8\)/
  );
});

test('F4: an entropy-only hit keeps its per-turn soft landing instead of pinning the session', async () => {
  // No `dlpAction` of 'local' here on purpose. With a reroute authorised, a pinned session and an
  // unpinned one both land on the local worker, so the poisoning is invisible; without it the medium
  // confidence hit takes the soft landing (`entropyOnly && dlpAction !== 'block'`) while a session the
  // marker remembers is forced out of that branch and into the high-confidence refusal. That difference is
  // the regression: one random-looking token turned every later prompt into a hard block.
  const handlers = mount({ ...BASE_OPTIONS, dlpAction: undefined });
  const preStep = handlers.get('agent/pre-step')[0];
  const request = handlers.get('agent/request')[0];
  const agent = { id: 'session-with-random-blob' };

  const ask = (turn) =>
    request({ turn, agent, step: 1 }, async () => ({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      tools: [],
    }));

  await preStep(
    { turn: 1, agent, messages: [{ role: 'user', content: `here is a blob: ${ENTROPY_ONLY}` }] },
    enter
  );
  const first = await ask(1);
  assert.equal(first.provider, 'lm-studio', 'an entropy-only hit is rerouted local');

  // The blob is still inside the scanned window, so the gate trips again. The assertion is that the answer
  // is the same soft landing: a remembered session would refuse this request outright.
  await preStep(
    { turn: 2, agent, messages: [{ role: 'user', content: 'a harmless follow-up question' }] },
    enter
  );
  const second = await ask(2);
  assert.equal(
    second.provider,
    'lm-studio',
    'one entropy-only hit must not pin the session into refusing every later prompt'
  );
});

test('F4 control: a matched credential still pins the session after the corpus evicts it', async () => {
  const handlers = mount(BASE_OPTIONS);
  const preStep = handlers.get('agent/pre-step')[0];
  const request = handlers.get('agent/request')[0];
  const agent = { id: 'session-with-real-credential' };

  const ask = (turn) =>
    request({ turn, agent, step: 1 }, async () => ({
      provider: 'deepseek-official',
      model: 'deepseek-chat',
      tools: [],
    }));

  await preStep(
    { turn: 1, agent, messages: [{ role: 'user', content: `here is my key ${SECRET}` }] },
    enter
  );
  const withCredential = await ask(1);
  assert.equal(withCredential.provider, 'lm-studio', 'a matched credential is never transmitted');

  // 210k benign characters push the secret out of the 200k-character scanned window, so the remembered fact
  // is the only thing left holding the session. A single character repeated has zero entropy, so this turn
  // contributes no hit of its own: without the marker the request would proceed to the cloud.
  await preStep(
    { turn: 2, agent, messages: [{ role: 'user', content: 'y'.repeat(210000) }] },
    enter
  );
  const afterEviction = await ask(2);
  assert.equal(
    afterEviction.provider,
    'lm-studio',
    'narrowing the pin to pattern matches must not lose the credential case'
  );
});
