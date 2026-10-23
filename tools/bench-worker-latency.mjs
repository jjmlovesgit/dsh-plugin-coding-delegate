#!/usr/bin/env node
/**
 * Worker latency benchmark, with the completion length PINNED.
 *
 * WHY THE PIN. The first two benchmarks measured the model's phrasing as much as the code: one run's
 * medium tier produced 41 completion tokens against a colleague's 28, which at ~65 tok/s is 150-250 ms
 * of difference the tolerance then attributed to the commit under test. `maxTokens` is fixed here so a
 * comparison between commits compares prefill and transport, not verbosity.
 *
 * PROMPT CACHE. Every request carries a unique nonce, so no two share a prefix. A benchmark that reuses
 * its prompt measures the host's KV cache: an earlier pass produced a flat ~520 ms at every context size
 * that way, which looked like excellent scaling and was nothing of the kind.
 *
 * WHAT IT DOES NOT REPORT. Time-to-first-token. `delegate_worker` awaits the whole JSON body, so a
 * "TTFT" from this path would be total latency under another name.
 *
 * REQUIRES a live OpenAI-compatible worker (default 127.0.0.1:1234) and a built plugin
 * (`npm --prefix plugin run build`). It is operator tooling, not a CI test: it cannot run without a
 * model, and a test that silently skips is worse than no test.
 *
 * Usage: node tools/bench-worker-latency.mjs [--runs 5] [--max-tokens 30] [--tier small,large] [--json]
 */
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { delegateWorker } = require(path.join(here, '..', 'plugin', 'dist', 'index.js'));

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const at = argv.indexOf('--' + name);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
};

const RUNS = Number(flag('runs', '5'));
const MAX_TOKENS = Number(flag('max-tokens', '30'));
const ONLY = flag('tier', '');
const TIERS = [
  { name: 'small', chars: 1000 },
  { name: 'medium', chars: 8000 },
  { name: 'large', chars: 32000 },
].filter((tier) => !ONLY || ONLY.split(',').includes(tier.name));

let nonce = 0;
function context(chars) {
  nonce += 1;
  const marker = '// unique run ' + nonce + '-' + Date.now() + '\n';
  const line = 'export function helper(value: number): number { return value * 2; }\n';
  return (marker + line.repeat(Math.ceil(chars / line.length))).slice(0, chars);
}

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-worker-'));

async function once(tier) {
  const started = Date.now();
  const verdict = await delegateWorker({
    taskName: 'bench-' + tier.name,
    instruction:
      'Summarise the code below in one short sentence, then stop. Do not emit code.\n\n' + context(tier.chars),
    endpoint: 'http://127.0.0.1:1234/v1/chat/completions',
    model: 'qwen/qwen3.8-27b',
    maxTokens: MAX_TOKENS,
    workspaceDir: workspace,
  });
  return {
    promptTokens: verdict.tokens ? verdict.tokens.prompt : 0,
    completionTokens: verdict.tokens ? verdict.tokens.completion : 0,
    elapsedMs: Date.now() - started,
  };
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
};

try {
  // Warm-up, reported rather than hidden: a cold first call is a model load, not a latency sample.
  const warmup = await once({ name: 'warmup', chars: 500 });

  const rows = [];
  for (const tier of TIERS) {
    const runs = [];
    for (let i = 0; i < RUNS; i += 1) runs.push(await once(tier));
    rows.push({
      tier: tier.name,
      promptTokens: runs[0].promptTokens,
      completionTokens: median(runs.map((r) => r.completionTokens)),
      medianMs: median(runs.map((r) => r.elapsedMs)),
      minMs: Math.min(...runs.map((r) => r.elapsedMs)),
      maxMs: Math.max(...runs.map((r) => r.elapsedMs)),
      runs: runs.map((r) => r.elapsedMs),
    });
  }

  const report = { warmupMs: warmup.elapsedMs, maxTokens: MAX_TOKENS, runs: RUNS, tiers: rows };

  if (argv.includes('--json')) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log('warm-up ' + warmup.elapsedMs + ' ms   (max_tokens ' + MAX_TOKENS + ', ' + RUNS + ' runs per tier)');
    console.log('');
    console.log('tier    promptTok  compTok  median   min-max');
    for (const row of rows) {
      console.log(
        String(row.tier).padEnd(8) +
          String(row.promptTokens).padEnd(11) +
          String(row.completionTokens).padEnd(9) +
          String(row.medianMs).padEnd(9) +
          row.minMs + '-' + row.maxMs
      );
    }
  }
} finally {
  fs.rmSync(workspace, { recursive: true, force: true });
}
