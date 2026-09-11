// Prints where the script actually ran.
//
// The fixture for the plugin's per-package guarantee: a script listed under
// `examples/` must run with `examples/` as its working directory, not the
// workspace root. In a monorepo that is the difference between running one
// package's script and running the wrong one.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { log } from './_shared.mjs'

let manifest = {}
try {
  manifest = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))
} catch {
  // Report the missing manifest rather than crashing: the point is the cwd.
}

log(`cwd                 ${process.cwd()}`)
log(`package.json here   ${manifest.name ?? '(none)'}@${manifest.version ?? '0.0.0'}`)
log(`owns this script    ${Object.keys(manifest.scripts ?? {}).includes('where') ? 'yes' : 'no'}`)
log(`npm_lifecycle_event ${process.env.npm_lifecycle_event ?? '(not run through npm)'}`)
log(`node                ${process.version}`)
