import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const port = Number(process.env.LX_DEBUG_LOG_PORT || 39117)
const output = process.env.LX_DEBUG_LOG_FILE || path.join(os.homedir(), 'AppData', 'Roaming', 'easy-music', 'debug-lx-music-info.jsonl')

fs.mkdirSync(path.dirname(output), { recursive: true })

const server = http.createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/lx-debug-log') {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'not found' }))
    return
  }

  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    try {
      const body = raw ? JSON.parse(raw) : {}
      fs.appendFileSync(output, `${JSON.stringify({ receivedAt: new Date().toISOString(), ...body })}\n`, 'utf8')
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
    } catch (error) {
      fs.appendFileSync(output, `${JSON.stringify({ receivedAt: new Date().toISOString(), parseError: String(error), raw })}\n`, 'utf8')
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
    }
  })
})

server.listen(port, '127.0.0.1', () => {
  console.log(`LX 参数日志接收器已启动：http://127.0.0.1:${port}/lx-debug-log`)
  console.log(`日志文件：${output}`)
})

process.on('SIGINT', () => {
  server.close(() => process.exit(0))
})
