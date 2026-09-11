// A task that spawns a child of its own — the process-tree fixture.
//
// `npm run tree` means the shell runs node, which runs this file, which runs
// `worker.mjs`. Stopping the run must reap all three; killing only the direct
// child would leave the worker alive and still writing output. The pids printed
// here are what tests/real-run.test.mjs checks are gone after a stop.

import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { log } from './_shared.mjs'

const here = dirname(fileURLToPath(import.meta.url))

log(`parent started pid=${process.pid} ppid=${process.ppid}`)

const worker = spawn(process.execPath, [join(here, 'worker.mjs')], {
  stdio: ['ignore', 'pipe', 'pipe'],
})
log(`spawned worker pid=${worker.pid}`)

worker.stdout.on('data', (chunk) => {
  process.stdout.write(`  ${chunk}`)
})
worker.stderr.on('data', (chunk) => {
  process.stderr.write(`  ${chunk}`)
})
worker.on('exit', (code, signal) => {
  log(`worker exited code=${code} signal=${signal}`)
  process.exit(code ?? 1)
})

log('stopping this run should also stop the worker — check that its pid is gone')
log(`  on Windows:  tasklist /FI "PID eq ${worker.pid}"`)
log(`  on POSIX:    ps -p ${worker.pid}`)

// Keep the parent alive even if the worker somehow exits first.
setInterval(() => {}, 1 << 30)
