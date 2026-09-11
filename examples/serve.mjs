// A long-running stand-in for a backend dev server.
//
// This is the fixture for watching a *live* task: it never exits on its own, it
// keeps emitting output, and it answers requests, so the DSH popover's status
// dot, elapsed-time counter, streaming output pane and Stop button all have
// something real to show.
//
// Configuration, all optional:
//   PORT     preferred port (default 4319); falls back to an OS-chosen port
//            when it is already taken
//   PERIOD   heartbeat interval in ms (default 1000)

import { createServer } from 'node:http'

import { log } from './_shared.mjs'

const preferredPort = Number(process.env.PORT ?? 4319)
const periodMs = Number(process.env.PERIOD ?? 1000)
const startedAt = Date.now()

let requests = 0
let heartbeats = 0
let heartbeatTimer
let retried = false

const server = createServer((request, response) => {
  requests += 1
  const uptimeMs = Date.now() - startedAt
  if ((request.url ?? '/') === '/health') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ ok: true, pid: process.pid, uptimeMs, requests, heartbeats }))
    return
  }
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
  response.end(
    'dsh-npm-runner example service\n'
    + `pid      ${process.pid}\n`
    + `uptime   ${Math.round(uptimeMs / 1000)}s\n`
    + `requests ${requests}\n`,
  )
})

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE' && !retried) {
    retried = true
    log(`port ${preferredPort} is busy — asking the OS for a free one`)
    server.listen(0, '127.0.0.1')
    return
  }
  log(`server error: ${error.message}`)
  process.exit(1)
})

server.on('listening', () => {
  const { port } = server.address()
  log(`listening on http://127.0.0.1:${port}  (pid ${process.pid})`)
  log(`try: curl http://127.0.0.1:${port}/health`)
  log('stop it with the Stop button in the DSH popover')
  heartbeatTimer = setInterval(() => {
    heartbeats += 1
    log(`heartbeat #${heartbeats} · up ${Math.round((Date.now() - startedAt) / 1000)}s · ${requests} request(s)`)
  }, periodMs)
})

server.listen(preferredPort, '127.0.0.1')

// Shut down cleanly on a graceful stop, so a POSIX SIGTERM from the plugin
// shows an orderly close rather than a bare kill. Windows force-terminates the
// tree instead, so this path is not reached there.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log(`${signal} received — closing cleanly`)
    clearInterval(heartbeatTimer)
    server.close(() => {
      log('closed; bye')
      process.exit(0)
    })
    // Never hang on a lingering keep-alive socket.
    setTimeout(() => process.exit(0), 1000).unref()
  })
}
