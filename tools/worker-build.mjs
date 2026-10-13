import fs from "node:fs";
import http from "node:http";

// Worker dispatch: mirrors plugin/dist/profiles.js -> PROFILES.WORKER (WORKER_LOCAL) -- model
// qwen/qwen3.8-27b via lm-studio at http://127.0.0.1:1234/v1, temperature 0.2, the profile's stop
// sequences, its `enable_thinking: false` / `reasoning_effort: 'none'` flags, and its 8192-token
// budget.
//
// THE BUDGET IS EMULATED, NOT RAISED. An earlier revision ran at 20000 so that reasoning and answer
// would both fit, which made this script succeed where `delegate_worker` fails -- it masked the very
// hazard it was written to expose. At 8192 the script reproduces what the plugin actually does, so a
// regression is visible here rather than only in production.
//
// THE FLAGS ARE NOT THE CONTROL. This model reasons when LM Studio's PER-MODEL thinking toggle is on,
// and on a task of this size it spends the entire budget on reasoning_content and returns
// finish_reason=length with EMPTY content -- a delegation that returns nothing while every layer
// reports success. Measured: toggle on -> 34,076 reasoning chars and no code; toggle off ->
// reasoning_content=0 and ~1,600-2,000 chars of code in under five seconds. The same result is
// obtained with the flags ABSENT, so they are neither necessary nor sufficient: the per-model setting
// is authoritative. See docs/findings.md.
//
// GENERATION IS NOT DETERMINISTIC. Three identical requests at temperature 0.2 returned 1628, 1848
// and 1636 characters. Disabling thinking removes reasoning tokens, not sampling.

// Worker dispatch: mirrors the plugin's WORKER_LOCAL 8192-token budget.
// Requires LM Studio set to "No Thinking" to avoid length exhaustion on reasoning models.
const MAX_TOKENS = 8192;
const targetPath = "tools/json-canonical-merge.ts";
const contractSource = fs.readFileSync("tests/contracts/json-canonical-merge.contract.cjs", "utf8");

const systemPrompt = "You are a senior TypeScript engineer. Output ONLY valid TypeScript code without markdown fences, comments, or explanations.";
const userMessage = `Write tools/json-canonical-merge.ts to satisfy this contract suite:
\`\`\`javascript
${contractSource}
\`\`\`

Strict Requirements:
1. Exact signature:
export function canonicalMerge<T extends Record<string, any>>(base: T, patch: Record<string, any>): Record<string, any>
2. Deep cloning: Return completely decoupled plain objects and arrays. Never alias references from base or patch.
3. Forbidden keys: Skip __proto__, constructor, and prototype at every recursive level.
4. Preserve every key that exists only in base: an absent patch key must keep the base value. Never write undefined for a missing patch key.
5. null patch value deletes the key at any depth.
6. Clean export: exactly one named export, no default exports, no imports, no console output.`;

const payload = JSON.stringify({
  model: "qwen/qwen3.8-27b",
  messages: [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ],
  temperature: 0.2,
  max_tokens: MAX_TOKENS,
  enable_thinking: false,
  reasoning_effort: "none",
  stop: ["<|im_end|>", "<|endoftext|>"],
  stream: false
});

const req = http.request({
  hostname: "127.0.0.1",
  port: 1234,
  path: "/v1/chat/completions",
  method: "POST",
  headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
}, (res) => {
  let body = "";
  res.on("data", chunk => body += chunk);
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
    let code = String(choice.message.content || "").trim();
    if (code.startsWith("```")) code = code.replace(/^```[a-z]*\r?\n/, "").replace(/```$/, "").trim();
    if (!code) {
      console.error("model returned empty content; refusing to overwrite the target");
      process.exitCode = 1;
      return;
    }
    fs.writeFileSync(targetPath, code, "utf8");
    console.log("Model generation finished. bytes: " + Buffer.byteLength(code, "utf8"));
  });
});
req.write(payload);
req.end();
