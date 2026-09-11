// A finite task that streams progress and then exits 0.
//
// The counterpart to `serve`: it exercises live output arriving while the task
// is still running, and the transition to a settled "completed" row.
//
// Configuration, all optional:
//   STEPS    number of steps (default 24)
//   GAP_MS   delay between steps in ms (default 120)

import { log, sleep } from './_shared.mjs'

const steps = Number(process.env.STEPS ?? 24)
const gapMs = Number(process.env.GAP_MS ?? 120)
const width = 20

log(`streaming ${steps} steps, ${gapMs}ms apart (~${Math.round((steps * gapMs) / 1000)}s total)`)

for (let step = 1; step <= steps; step += 1) {
  const filled = Math.round((step / steps) * width)
  const bar = `${'#'.repeat(filled)}${'.'.repeat(width - filled)}`
  log(`step ${String(step).padStart(3)}/${steps} [${bar}] ${String(Math.round((step / steps) * 100)).padStart(3)}%`)
  await sleep(gapMs)
}

log(`finished ${steps} steps — exiting 0`)
