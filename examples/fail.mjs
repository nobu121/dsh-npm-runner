// A task that fails on purpose, after producing output on both streams.
//
// The fixture for the "failed" row: a non-zero exit code, output written before
// the failure, and a stderr line proving the plugin merges stderr into the same
// stream as stdout.

import { log, sleep } from './_shared.mjs'

log('about to fail on purpose')
await sleep(300)

process.stderr.write('this line goes to stderr, which the plugin merges into one stream\n')
await sleep(200)

log('exiting with code 3 — the popover should show "failed" and the exit code')
process.exit(3)
