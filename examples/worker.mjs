// A worker that never exits on its own.
//
// Spawned by `tree.mjs` to give the run a grandchild process: `npm run tree`
// puts the real work two levels down, which is exactly the case a plain
// child-process kill would orphan. Prints its own pid so it can be checked
// after a stop.

import { log } from './_shared.mjs'

log(`worker started pid=${process.pid} ppid=${process.ppid}`)

let ticks = 0
setInterval(() => {
  ticks += 1
  log(`worker tick #${ticks} pid=${process.pid}`)
}, 700)
