// Diagnostic: can a request parameter turn reasoning on when the model server has it off?
//
// This exists because the answer decided an architecture. The plan was a three-tier loop with a local
// "lead" doing the code-level engineering, and it assumed the lead could be made to think. It cannot:
// LM Studio's per-model setting is authoritative and every request-level flag is ignored.
//
// Run it with the local model server up. It sends the same prompt four ways and reports completion
// tokens, the presence and length of a reasoning field, and a behavioural check -- the bat-and-ball
// problem, which a non-deliberating model usually answers "0.10" and a deliberating one answers "0.05".
//
// On the machine this was written for, all four variants returned byte-identical results:
// completion=64, reasoning=183 chars, answer="$0.05". Configure thinking where the model is served,
// not on the request.
//
//   node scripts/probe-thinking.mjs
import process from 'node:process'

const ENDPOINT = process.env.LOCAL_ENDPOINT || 'http://127.0.0.1:1234/v1/chat/completions'
const MODEL = process.env.LOCAL_MODEL || 'qwen/qwen3.8-27b'
const PROMPT =
  'A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. ' +
  'How much does the ball cost? Reply with just the amount.'

const variants = [
  { label: 'server default (no params)', body: {} },
  { label: 'enable_thinking: false', body: { enable_thinking: false } },
  { label: 'enable_thinking: true', body: { enable_thinking: true } },
  { label: 'reasoning_effort: high', body: { reasoning_effort: 'high' } },
]

for (const variant of variants) {
  const started = Date.now()
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer local' },
      body: JSON.stringify({
        model: MODEL,
        messages: [{ role: 'user', content: PROMPT }],
        temperature: 0,
        max_tokens: 8192,
        ...variant.body,
      }),
      signal: AbortSignal.timeout(180000),
    })
    const json = await res.json()
    if (!res.ok) {
      console.log(variant.label.padEnd(30) + ' HTTP ' + res.status + ': ' + JSON.stringify(json).slice(0, 160))
      continue
    }
    const msg = json.choices?.[0]?.message ?? {}
    const usage = json.usage ?? {}
    const reasoning = msg.reasoning_content ?? msg.reasoning ?? null
    const answer = String(msg.content ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
    console.log(
      variant.label.padEnd(30) + ' completion=' + String(usage.completion_tokens ?? '?').padEnd(6) +
        ' reasoning=' + (reasoning ? 'YES(' + String(reasoning).length + ' chars)' : 'no ') +
        ' answer="' + answer + '"  ' + (Date.now() - started) + 'ms'
    )
  } catch (err) {
    console.log(variant.label.padEnd(30) + ' FAILED: ' + err.message)
  }
}
