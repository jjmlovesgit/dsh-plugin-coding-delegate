// Diagnostic: an OpenAI-compatible pass-through proxy for the local worker that tees every request
// and every reply to disk. The plugin reports only a verdict, so the exact bytes the model returned
// are otherwise unobservable, and a parse refusal cannot be told from a generation problem.
//
//   node scripts/proxy-worker.cjs <port> <out-prefix> [upstream-base]
const fs = require('node:fs')
const http = require('node:http')

const port = Number(process.argv[2] || 1235)
const outPrefix = process.argv[3]
const upstream = process.argv[4] || 'http://127.0.0.1:1234/v1'

if (!outPrefix) {
  console.error('usage: node scripts/proxy-worker.cjs <port> <out-prefix> [upstream-base]')
  process.exit(2)
}

let counter = 0

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', async () => {
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const n = ++counter
    fs.writeFileSync(outPrefix + '.' + n + '.request.json', bodyText, 'utf8')
    try {
      const upstreamRes = await fetch(upstream + req.url, {
        method: req.method,
        headers: { 'Content-Type': 'application/json' },
        body: bodyText,
      })
      const text = await upstreamRes.text()
      fs.writeFileSync(outPrefix + '.' + n + '.response.json', text, 'utf8')
      res.writeHead(upstreamRes.status, { 'Content-Type': 'application/json' })
      res.end(text)
    } catch (err) {
      fs.writeFileSync(outPrefix + '.' + n + '.error.txt', String(err), 'utf8')
      res.writeHead(502, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: String(err) }))
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log('proxy listening on http://127.0.0.1:' + port + '/v1  ->  ' + upstream)
})
