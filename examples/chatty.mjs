// A high-volume writer, for watching the plugin's bounded output retention.
//
// It emits far more than the plugin keeps (64 KiB by default), so the popover
// shows the retained tail and flags the run as truncated — the visible face of
// `bufferBytes`.
//
// Configuration, all optional:
//   LINES   how many lines to write (default 20000)

import { log } from './_shared.mjs'

const lines = Number(process.env.LINES ?? 20000)
const padding = 'x'.repeat(56)

log(`writing ${lines} lines as fast as possible (~${Math.round((lines * 76) / 1024)} KiB)`)
log('only the newest bytes are retained, so the start of this run will be dropped')

for (let index = 1; index <= lines; index += 1) {
  process.stdout.write(`line ${String(index).padStart(6)} ${padding}\n`)
}

log(`done: wrote ${lines} lines — everything above the retention cap was discarded`)
