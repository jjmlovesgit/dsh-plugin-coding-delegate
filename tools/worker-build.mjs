import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// This file lives in tools/, so the repository root is one level up.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Worker dispatch for the contract-first delegation pipeline.
//
//   usage: node tools/worker-build.mjs [targetPath] [contractPath]
//
// Defaults to the priority-queue unit. Requirements are AUTHORED PER TARGET below rather than left
// generic, because a generic prompt is what let the first canonicalMerge generation alias its inputs
// and still pass: the contract named the invariant and the prompt never stated it. A target with no
// authored requirements is refused rather than sent with a vague instruction.
//
// Mirrors plugin/dist/profiles.js -> PROFILES.WORKER (WORKER_LOCAL): qwen/qwen3.8-27b via lm-studio at
// http://127.0.0.1:1234/v1, temperature 0.2, the profile's stop sequences, its
// `enable_thinking: false` / `reasoning_effort: 'none'` flags, and its 8192-token budget.
//
// THE BUDGET IS EMULATED, NOT RAISED. An earlier revision ran at 20000 so reasoning and answer would
// both fit, which made this script succeed where `delegate_worker` fails -- it masked the very hazard
// it exists to expose. At 8192 the script reproduces what the plugin actually does.
//
// THE FLAGS ARE NOT THE CONTROL. This model reasons when LM Studio's PER-MODEL thinking toggle is on,
// and then spends the entire budget on reasoning_content and returns finish_reason=length with EMPTY
// content. The same result is obtained with the flags ABSENT, so they are neither necessary nor
// sufficient: the per-model setting is authoritative. See docs/findings.md.
//
// GENERATION IS NOT DETERMINISTIC. Three identical requests at temperature 0.2 returned 1628, 1848
// and 1636 characters.

// Worker dispatch: mirrors the plugin's WORKER_LOCAL 8192-token budget.
// Requires LM Studio set to "No Thinking" to avoid length exhaustion on reasoning models.
const MAX_TOKENS = 8192;

const REQUIREMENTS = {
  "tools/event-emitter.ts": [
    "Export a generic class exactly as: export class EventEmitter<Events extends Record<string, (...args: any[]) => void>>  -- one generic parameter constrained to a record of functions, and exactly one export in the file.",
    "on(event, listener): this -- registers a listener. Registering the SAME function twice creates TWO registrations, both of which run, in registration order.",
    "once(event, listener): this -- registers a listener that is UNREGISTERED BEFORE IT IS INVOKED. A once listener that re-emits the same event during its own call must not run a second time.",
    "off(event, listener): this -- removes the first registration of that listener. Removing a listener that is not registered is a no-op and must not disturb the others.",
    "emit(event, ...args): boolean -- invokes every listener registered for the event, in registration order, forwarding every argument BY REFERENCE (no cloning, no serialising, no truncation). Returns true if at least one listener ran, false if none did. Emitting an event with no listeners is a normal call, not an error.",
    "listenerCount(event): number -- the number of registrations for that event; 0 for an unknown event.",
    "removeAllListeners(event?): this -- with an event, clears only that event; with no argument, clears every event. The emitter must be fully reusable afterwards.",
    "CRITICAL - SNAPSHOT DISPATCH: emit MUST take a snapshot of the listener set for the event at the moment emit is called, and iterate THAT. A listener that removes itself or another listener during the dispatch must not cause any listener present at the start to be skipped. A listener registered DURING a dispatch must not be invoked by that dispatch; it runs on the next one.",
    "on, once, off and removeAllListeners MUST return `this` so calls chain.",
    "Keep the listener store in a #private field. A caller must not be able to reach a live Array, Map, Set or listener object through any own property or prototype accessor.",
    "No imports, no external runtime dependencies, no console output.",
  ],
  "tools/lru-cache.ts": [
    "Export a generic class exactly as: export class LRUCache<K, V>",
    "The constructor takes capacity: number and MUST throw a RangeError when capacity is not a positive integer. 0, negative values, fractional values, NaN and Infinity are all invalid. A capacity of 1 is valid.",
    "get(key: K): V | undefined -- returns the stored value, or undefined when absent. A successful get MUST promote the entry to most-recently-used.",
    "set(key: K, value: V): void -- inserts or updates. Setting a key that is already present MUST update the value in place, MUST NOT grow size, and MUST promote the entry to most-recently-used.",
    "has(key: K): boolean -- a pure membership test. It MUST NOT promote: asking whether a key is present must not reorder the cache.",
    "delete(key: K): boolean -- removes the entry and its recency position; returns true if it was present, false otherwise.",
    "clear(): void -- removes every entry.",
    "A GETTER `size: number` and a GETTER `capacity: number`. Both are getters, not methods.",
    "EVICTION: when an insertion would take size past capacity, drop the least-recently-used entry. Exactly one entry is dropped per insertion, and the entry dropped is the one least recently used by the rules above.",
    "COMPLEXITY: get, set and delete must be O(1) amortised. Use a hash Map for lookup plus a doubly-linked list for recency order. An array scan over the entries satisfies the behaviour but is O(n) and is NOT acceptable.",
    "CRITICAL: keep the map and the list nodes in #private fields. A caller must not be able to reach a live Map, Array, Set or node object through any own property or prototype accessor.",
    "No imports, no external runtime dependencies, no console output.",
  ],
  "tools/ring-buffer.ts": [
    "Export a generic class exactly as: export class RingBuffer<T>",
    "The constructor takes capacity: number and MUST throw a RangeError when capacity is not a positive integer. 0, negative values, fractional values, NaN and Infinity are all invalid. A capacity of 1 is valid.",
    "push(item: T): boolean -- appends item as the NEWEST element. Returns true when it was stored, and false when the buffer is already full. A refused push must change NOTHING: no overwrite of the oldest element, no eviction, no change to size, and no reordering.",
    "pop(): T | undefined -- removes and returns the OLDEST element (FIFO). Returns undefined when empty.",
    "peek(): T | undefined -- returns the OLDEST element without removing it. Returns undefined when empty. Calling it twice must return the same element.",
    "isFull(): boolean and isEmpty(): boolean.",
    "A GETTER `size: number` for the current element count and a GETTER `capacity: number` for the fixed capacity. Both are getters, not methods.",
    "CRITICAL: keep the store in a #private field and wrap the write index modulo capacity. After a pop, the next push MUST reuse the freed slot rather than appending, so the buffer never grows past capacity and the oldest element is not at index 0 once it has wrapped. Use #buffer, #head and #size (or equivalent #private fields).",
    "The backing store MUST NOT be reachable from the instance: a caller must not be able to reach a live array through any own property or prototype accessor.",
    "No imports, no external runtime dependencies, no console output.",
  ],
  "tools/priority-queue.ts": [
    "Export a generic class exactly as: export class PriorityQueue<T>",
    "The constructor takes an optional comparator (a: T, b: T) => number. With no comparator, order naturally ascending, i.e. a min-heap.",
    "Methods: push(item: T): void, pop(): T | undefined, peek(): T | undefined, isEmpty(): boolean, and a GETTER `size: number` (a getter, not a method call).",
    "Use standard binary heap arithmetic: parent = (i - 1) >> 1, left = 2 * i + 1, right = 2 * i + 2.",
    "pop() and peek() on an empty queue return undefined rather than throwing.",
    "CRITICAL: the backing store MUST NOT be reachable from the instance. Use a #private field. A caller must not be able to reach a live array through any own property or prototype accessor, because the contract attacks the instance and then asserts it still behaves. A public `heap: T[] = []` fails this.",
    "No imports, no external runtime dependencies, no console output.",
  ],
  "tools/json-canonical-merge.ts": [
    "Exact signature: export function canonicalMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): Record<string, any>",
    "Deep cloning: return completely decoupled plain objects and arrays. Never alias references from base or patch.",
    "Forbidden keys: skip __proto__, constructor, and prototype at every recursive level.",
    "Preserve every key that exists only in base: an absent patch key must keep the base value. Never write undefined for a missing patch key.",
    "A null patch value deletes the key at any depth.",
    "Exactly one named export, no default exports, no imports, no console output.",
  ],
};

// Flags are separated from positionals first: `node tools/worker-build.mjs --attest` must not read
// `--attest` as the target path.
const argv = process.argv.slice(2);
const wantAttest = argv.includes("--attest");
const positionals = argv.filter((token) => !token.startsWith("--"));

const targetPath = positionals[0] || "tools/priority-queue.ts";
const contractPath = positionals[1] || "tests/contracts/priority-queue.contract.cjs";

const requirements = REQUIREMENTS[targetPath];
if (!requirements) {
  console.error(
    "No authored requirements for '" +
      targetPath +
      "'. Add them to REQUIREMENTS in this file: a vague prompt is how the first canonicalMerge " +
      "generation passed its contract while aliasing both inputs."
  );
  process.exit(2);
}
if (!fs.existsSync(contractPath)) {
  console.error("Contract not found: " + contractPath);
  process.exit(2);
}

const contractSource = fs.readFileSync(contractPath, "utf8");

const systemPrompt =
  "You are a senior TypeScript engineer. Output ONLY valid TypeScript code without markdown fences, comments, or explanations.";
const userMessage =
  "Write " +
  targetPath +
  " to satisfy this contract suite:\n" +
  "```javascript\n" +
  contractSource +
  "\n```\n\nStrict Requirements:\n" +
  requirements.map((line, i) => i + 1 + ". " + line).join("\n");

const payload = JSON.stringify({
  model: "qwen/qwen3.8-27b",
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ],
  temperature: 0.2,
  max_tokens: MAX_TOKENS,
  enable_thinking: false,
  reasoning_effort: "none",
  stop: ["<|im_end|>", "<|endoftext|>"],
  stream: false,
});

/**
 * Post-generation phase, opt-in with `--attest`.
 *
 * WHY IT DOES NOT COMMIT. `attest-unit.cjs` refuses an artifact that is not in the commit it would
 * anchor to, because a record naming a hash that commit does not contain cannot be reproduced by
 * checking that commit out. A freshly generated artifact is by definition not committed, so this phase
 * has two honest outcomes and never signs over uncommitted bytes.
 *
 * The commit is left to the operator on purpose. A passing contract proves conformance to the contract,
 * and it cannot prove the absence of a hidden dependency, a mock escape or a silent O(n) shortcut --
 * none of which any contract in this repository can observe. The commit boundary is the step where a
 * person looks at what the worker actually produced before it is anchored into history, and a build
 * script that both generates and commits would delete that step.
 *
 * `git status` is invoked with argv and NO shell, so a path cannot be read as an option or as shell
 * syntax -- the same reason attestation-notes.js builds its command as an argument array.
 */
function runAttestPhase() {
  const asRelative = (p) => path.relative(REPO_ROOT, path.resolve(REPO_ROOT, p)).split(path.sep).join("/");
  const targetRel = asRelative(targetPath);
  const contractRel = asRelative(contractPath);
  const base = path.basename(targetRel).replace(/\.ts$/, "");
  const fixtureRel = "tests/contracts/fixtures/" + base + ".negative.ts";
  const buildScriptRel = "tools/worker-build.mjs";

  console.log("");
  console.log("=== contract verification ===");
  const run = spawnSync(process.execPath, [path.resolve(REPO_ROOT, contractRel)], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  const output = String(run.stdout || "") + String(run.stderr || "");
  for (const line of output.split("\n")) {
    if (/^# (tests|pass|fail)/.test(line)) console.log("  " + line);
  }

  // A spawn failure is NOT a contract failure, and reporting it as one sends the operator to look at
  // the wrong artifact. `status` is null when the child never ran.
  if (run.error) {
    console.error("  the contract could not be RUN: " + run.error.message);
    console.error("  this is an environment failure, not a verdict on the unit; nothing was attested");
    process.exitCode = 1;
    return;
  }

  if (typeof run.status !== "number" || run.status !== 0) {
    console.error(
      "  contract FAILED (exit " + run.status + "). Nothing will be attested: a signature over a unit " +
        "its own contract rejects would launder a failure into an operator statement."
    );
    process.exitCode = 1;
    return;
  }
  console.log("  contract PASSED (exit " + run.status + ")");

  // Every path that the commit would need, so the guidance below is complete rather than partial.
  const paths = [targetRel, contractRel, fixtureRel, buildScriptRel];
  const status = execFileSync("git", ["status", "--porcelain", "--", ...paths], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim();

  if (status.length === 0) {
    console.log("");
    console.log("[ATTEST] the artifact and its contract are committed and clean; invoking the signer");
    const signer = path.join(REPO_ROOT, "scripts", "attest-unit.cjs");
    const signed = spawnSync(process.execPath, [signer, targetRel, contractRel], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    if (typeof signed.status === "number" && signed.status !== 0) process.exitCode = signed.status;
    return;
  }

  console.log("");
  console.log("============================================================");
  console.log("CONTRACT PASSED -- THE UNIT IS NOT COMMITTED");
  console.log("A record can only anchor to a commit that CONTAINS these bytes, so");
  console.log("the commit is the next step and it is deliberately yours:");
  console.log("============================================================");
  console.log("");
  console.log("  git add " + paths.join(" "));
  console.log('  git commit -m "feat(tools): add ' + base + ' utility with verified contract"');
  console.log("  node scripts/attest-unit.cjs " + targetRel + " " + contractRel);
  console.log("");
  console.log("still uncommitted:");
  for (const line of status.split("\n")) console.log("  " + line);
  console.log("");
}

const req = http.request(
  {
    hostname: "127.0.0.1",
    port: 1234,
    path: "/v1/chat/completions",
    method: "POST",
    headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
  },
  (res) => {
    let body = "";
    res.on("data", (chunk) => (body += chunk));
    res.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        console.error("response was not JSON: " + body.slice(0, 400));
        process.exitCode = 1;
        return;
      }
      const choice = parsed.choices && parsed.choices[0];
      if (!choice || !choice.message) {
        console.error("no completion in response: " + body.slice(0, 400));
        process.exitCode = 1;
        return;
      }
      console.log("finish_reason: " + choice.finish_reason);
      if (typeof choice.message.reasoning_content === "string") {
        console.log("reasoning_content chars: " + choice.message.reasoning_content.length);
      }
      // The gate the plugin now enforces, mirrored here: a starved worker is a failure, not an empty
      // edit, and refusing to overwrite the target is what keeps it from becoming one.
      if (choice.finish_reason === "length" && !String(choice.message.content || "").trim()) {
        console.error(
          "WORKER_OUTPUT_STARVED: finish_reason 'length' with empty content; refusing to overwrite " + targetPath
        );
        process.exitCode = 1;
        return;
      }
      let code = String(choice.message.content || "").trim();
      if (code.startsWith("```")) code = code.replace(/^```[a-z]*\r?\n/, "").replace(/```$/, "").trim();
      if (!code) {
        console.error("model returned empty content; refusing to overwrite the target");
        process.exitCode = 1;
        return;
      }
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      fs.writeFileSync(targetPath, code, "utf8");
      console.log(
        "Model generation finished. target: " + targetPath + " bytes: " + Buffer.byteLength(code, "utf8")
      );
      // Runs AFTER the write, inside the response handler. A block at module scope would have executed
      // before the model answered, and would have checked the PREVIOUS contents of the file.
      if (wantAttest) runAttestPhase();
    });
  }
);
req.write(payload);
req.end();
