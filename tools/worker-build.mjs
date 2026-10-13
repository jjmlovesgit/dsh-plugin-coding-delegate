import fs from "node:fs";
import path from "node:path";
import http from "node:http";

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

const targetPath = process.argv[2] || "tools/priority-queue.ts";
const contractPath = process.argv[3] || "tests/contracts/priority-queue.contract.cjs";

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
    });
  }
);
req.write(payload);
req.end();
