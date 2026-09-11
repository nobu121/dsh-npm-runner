// Shared helpers for the example scripts.
//
// Every example writes one line per event through `log`, so output is
// line-oriented and easy to watch in the DSH popover.

/**
 * Write one timestamped line to stdout.
 * @param message - the line body.
 */
export function log(message) {
  const stamp = new Date().toISOString().slice(11, 23)
  process.stdout.write(`[${stamp}] ${message}\n`)
}

/**
 * Sleep for a while.
 * @param ms - milliseconds.
 * @returns a promise resolving after the delay.
 */
export function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
