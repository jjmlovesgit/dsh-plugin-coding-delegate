import http from "node:http";

// Cheap diagnostic: which thinking control does LM Studio actually honour for qwen/qwen3.8-27b?
// The WORKER profile asserts enable_thinking/reasoning_effort are ignored; that assertion decides
// whether a delegation can ever return content inside max_tokens.
const variants = [
  { name: "baseline (no flags)", extra: {} },
  { name: "enable_thinking:false + reasoning_effort:none", extra: { enable_thinking: false, reasoning_effort: "none" } },
  { name: "chat_template_kwargs.enable_thinking:false", extra: { chat_template_kwargs: { enable_thinking: false } } },
  { name: "/no_think in prompt", extra: {}, promptSuffix: " /no_think" },
];

function ask(v) {
  return new Promise((resolve) => {
    const payload = JSON.stringify(Object.assign({
      model: "qwen/qwen3.8-27b",
      messages: [
        { role: "system", content: "You are terse." },
        { role: "user", content: "Reply with exactly: OK" + (v.promptSuffix || "") },
      ],
      temperature: 0.2,
      max_tokens: 256,
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
          resolve({
            name: v.name,
            finish: ch.finish_reason,
            reasoningChars: (ch.message.reasoning_content || "").length,
            contentChars: (ch.message.content || "").trim().length,
            content: (ch.message.content || "").trim().slice(0, 30),
          });
        } catch (e) {
          resolve({ name: v.name, error: "unparseable: " + body.slice(0, 200) });
        }
      });
    });
    req.write(payload);
    req.end();
  });
}

for (const v of variants) {
  const r = await ask(v);
  if (r.error) console.log(r.name.padEnd(52) + " ERROR: " + r.error);
  else console.log(r.name.padEnd(52) + " finish=" + r.finish + " reasoning=" + r.reasoningChars + " content=" + r.contentChars + " " + JSON.stringify(r.content));
}
