import fs from "node:fs";
import http from "node:http";

// Does the LM Studio PER-MODEL thinking toggle decide whether the worker reasons, or do the API
// flags? The distinction matters: profiles.js transmits `enable_thinking: false` and
// `reasoning_effort: 'none'` on every delegation and documents them as advisory, "because LM Studio's
// per-model setting is authoritative". If the toggle is what counts, the plugin is transmitting two
// parameters that do nothing, and a GUI setting decides whether a delegation returns code or an
// empty string.
//
// A TRIVIAL PROMPT DOES NOT DISCRIMINATE. An earlier revision of this probe asked for "OK" and got
// reasoning_content=0 under every variant -- including the baseline with no flags -- because the
// model never chose to reason about it. That reading was inconclusive, and it was read as if it were
// evidence. This version uses the real contract-sized prompt at the profile's max_tokens 8192, where
// the model does choose to reason. The row that settles the question is the NO-FLAGS one.
//
// Diagnostic only: writes nothing to disk. See docs/findings.md.
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

const variants = [
  { name: "8192 + enable_thinking:false + reasoning_effort:none", extra: { max_tokens: 8192, enable_thinking: false, reasoning_effort: "none" } },
  { name: "8192, NO thinking flags at all", extra: { max_tokens: 8192 } },
  { name: "20000, NO thinking flags at all", extra: { max_tokens: 20000 } },
];

function ask(v) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(Object.assign({
      model: "qwen/qwen3.8-27b",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
      temperature: 0.2,
      stop: ["<|im_end|>", "<|endoftext|>"],
      stream: false,
    }, v.extra));
    const req = http.request({
      hostname: "127.0.0.1", port: 1234, path: "/v1/chat/completions", method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
    }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => {
        try {
          const p = JSON.parse(body);
          if (p.error) return resolve({ name: v.name, error: p.error.message || JSON.stringify(p.error) });
          const ch = p.choices[0];
          const content = String(ch.message.content || "");
          resolve({
            name: v.name,
            finish: ch.finish_reason,
            reasoningChars: (ch.message.reasoning_content || "").length,
            contentChars: content.trim().length,
            codeShaped: /export\s+function\s+canonicalMerge/.test(content),
          });
        } catch {
          resolve({ name: v.name, error: "unparseable: " + body.slice(0, 200) });
        }
      });
    });
    req.write(payload);
    req.end();
  });
}

console.log("model: qwen/qwen3.8-27b @ 127.0.0.1:1234 -- toggle it in LM Studio and re-run to compare\n");
console.log("variant (max_tokens, flags)".padEnd(56) + "finish".padEnd(9) + "reasoning".padEnd(11) + "content".padEnd(9) + "code?");
console.log("-".repeat(90));
for (const v of variants) {
  const started = Date.now();
  const r = await ask(v);
  const secs = ((Date.now() - started) / 1000).toFixed(1) + "s";
  if (r.error) {
    console.log(v.name.padEnd(56) + "ERROR: " + r.error);
  } else {
    console.log(
      v.name.padEnd(56) +
      String(r.finish).padEnd(9) +
      String(r.reasoningChars).padEnd(11) +
      String(r.contentChars).padEnd(9) +
      (r.codeShaped ? "yes" : "NO") +
      " (" + secs + ")"
    );
  }
}
console.log("\nIf the no-flags row also shows reasoning=0, the per-model toggle is authoritative and the");
console.log("transmitted flags are doing nothing. If it shows a large reasoning count, the flags work.");
