import fs from "node:fs";
import http from "node:http";

// Mirrors plugin/dist/profiles.js -> PROFILES.WORKER (WORKER_LOCAL) -- the model the plugin's
// `delegate_worker` tool actually routes to: provider lm-studio, model qwen/qwen3.8-27b,
// endpoint http://127.0.0.1:1234/v1, temperature 0.2, with the profile's stop sequences and its
// `enable_thinking: false` / `reasoning_effort: 'none'` flags.
//
// WHY max_tokens IS 20000 AND NOT THE PROFILE'S 8192. A deliberate deviation, and the reason is a
// host setting the plugin cannot reach. LM Studio's PER-MODEL thinking toggle is authoritative: with
// it on, this model reasons about a task of this size and the first dispatch spent 34,076 characters
// of reasoning_content against the 8192-token budget, returning finish_reason=length with EMPTY
// content -- a delegation that returns nothing while every layer reports success. With the toggle
// off, 8192 suffices: measured reasoning_content=0 and ~2,000 characters of code in under five
// seconds, BOTH with and without the API flags, which are therefore neither necessary nor
// sufficient. 20000 makes a run survive either setting, since reasoning and answer then both fit
// inside the profile's 32768-token context window. The flags are still transmitted, for fidelity.
//
// An earlier revision of this comment attributed the empty content to the model simply reasoning on
// a task this size. That was wrong: it is the per-model toggle. See docs/findings.md for the
// measurement, and confirm the toggle before re-running this.
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
  max_tokens: 20000,
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
