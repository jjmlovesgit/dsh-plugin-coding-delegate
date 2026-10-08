// Contract oracle: the architect route is rewritten only when there is a route to rewrite it to.
//
// Both provider options are operator configuration and both are optional, and the old code assigned the
// ternary unconditionally -- so with no `cloudProvider` configured it wrote `provider: undefined` over
// whatever route the host had selected. That is not a corner case: the plugin's own entry in `config.json`
// carries no options at all, so a plugin registered without a profile patch would have clobbered every
// request's provider with `undefined`.
//
// What the host does with an undefined provider is still unread -- that is the question `findings.md` left
// open. Which is the point of this fix: the answer stops mattering on the default path.
//
// Properties:
//   1. With a provider configured, the route is pinned exactly as before.
//   2. With none configured and no local reroute intended, the host's route is left alone, and `provider`
//      is not added to the config at all -- an absent route must not become present-and-undefined.
//   3. `rerouteLocal` KEEPS writing undefined when no local provider is configured. That request was meant
//      to stay off the cloud, so falling back to the host's route could send source there; the
//      misconfiguration is left to fail loudly rather than succeed somewhere wrong.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PLUGIN = path.resolve(__dirname, '..', '..');
const ROLES = PLUGIN + '/dist/roles.js';

const { applyArchitectConfig } = require(ROLES);

test('a configured provider pins the route exactly as before', () => {
  const cloud = applyArchitectConfig(
    { provider: 'host-route', model: 'host-model' },
    { cloudProvider: 'deepseek-official', cloudModel: 'deepseek-chat' }
  );
  assert.equal(cloud.provider, 'deepseek-official');
  assert.equal(cloud.model, 'deepseek-chat');

  const local = applyArchitectConfig(
    { provider: 'host-route', model: 'host-model' },
    { rerouteLocal: true, localProvider: 'lm-studio', localModel: 'qwen/qwen3.8-27b' }
  );
  assert.equal(local.provider, 'lm-studio');
  assert.equal(local.model, 'qwen/qwen3.8-27b');
});

test('with no provider configured the host route is left alone rather than clobbered', () => {
  const result = applyArchitectConfig({ provider: 'host-route', model: 'host-model' }, {});
  assert.equal(result.provider, 'host-route', 'the host chose this route and nothing here overrides it');
  assert.equal(result.model, 'host-model');
});

test('with no provider configured, `provider` is not added to the config at all', () => {
  const result = applyArchitectConfig({ messages: [] }, {});
  assert.equal(
    Object.prototype.hasOwnProperty.call(result, 'provider'),
    false,
    'an absent route must not become present-and-undefined'
  );
});

test('a local reroute with no local provider still refuses to fall back to the host route', () => {
  const result = applyArchitectConfig(
    { provider: 'host-route', model: 'host-model' },
    { rerouteLocal: true }
  );
  assert.equal(result.provider, undefined, 'this request was meant to stay off the cloud');
  assert.notEqual(result.provider, 'host-route', 'so the host route must not become the answer');
});

test('the architect treatment that is not about routing is unchanged', () => {
  const result = applyArchitectConfig(
    { provider: 'p', model: 'm', contextWindow: 32768, maxTokens: 8192, apiKey: 'secret' },
    { cloudProvider: 'cloud', cloudModel: 'model' }
  );
  for (const gone of ['contextWindow', 'maxTokens', 'max_tokens', 'max_completion_tokens', 'apiKey']) {
    assert.equal(gone in result, false, gone + ' is uncapped or removed for the architect');
  }
  assert.equal(result.provider, 'cloud', 'and the route is still pinned when one is configured');
});
