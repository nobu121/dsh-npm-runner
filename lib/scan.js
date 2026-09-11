// dsh-npm-runner — workspace npm-script discovery.
//
// Pure, dependency-free logic: it never touches DSH, `node:fs`, or the
// network. Every filesystem access goes through the injected `io` port, which
// is what makes this module unit-testable against an in-memory tree and keeps
// the host half a thin adapter.
//
// "Ignore node_modules" is enforced in one place: `isIgnoredDir`. It is
// consulted by every directory traversal here, so a nested dependency tree can
// never contribute a package or a script.
//
// Layout handled:
//   <cwd>/package.json                     the workspace root package
//   <cwd>/<child>/package.json             sibling packages
//   workspaces: ["packages/*", "apps/*"]   glob-matched monorepo packages
//
// Only the nearest manifest level is surfaced on purpose: a plugin that lists
// every package.json in a deep tree would be useless in a large monorepo.

/**
 * Split a path into an absoluteness flag plus resolved segments, collapsing
 * `.` and `..` and accepting either separator. Used for the containment check
 * so the security decision does not depend on the host adapter supplying a
 * correct `contains`.
 * @param path - the raw path.
 * @returns `{ abs, segments }`.
 */
function resolveSegments(path) {
  const raw = String(path).replace(/\\/g, '/')
  const abs = raw.startsWith('/')
  const segments = []
  for (const part of raw.split('/')) {
    if (part.length === 0 || part === '.') continue
    if (part === '..') {
      segments.pop()
      continue
    }
    segments.push(part)
  }
  return { abs, segments }
}

/** True when the path's first segment is a Windows drive letter. */
function isDrivePath(segments) {
  return segments.length > 0 && /^[A-Za-z]:$/.test(segments[0])
}

/**
 * Lexical containment test: is `child` the same as, or below, `parent`?
 * Comparison is case-insensitive only for Windows drive paths, where the
 * filesystem is; everywhere else it stays case-sensitive so the check can
 * never widen access.
 * @param parent - the containing directory.
 * @param child - the candidate directory.
 * @returns true when `child` is inside `parent`.
 */
export function isWithin(parent, child) {
  const p = resolveSegments(parent)
  const c = resolveSegments(child)
  if (p.abs !== c.abs) return false
  if (c.segments.length < p.segments.length) return false
  const fold = isDrivePath(p.segments)
  for (let i = 0; i < p.segments.length; i += 1) {
    const a = p.segments[i]
    const b = c.segments[i]
    if (a === b) continue
    if (fold && a.toLowerCase() === b.toLowerCase()) continue
    return false
  }
  return true
}

/** Default cap on how many packages one scan may report. */
export const DEFAULT_MAX_PACKAGES = 60
/** Default cap on how many directories one glob pattern may expand to. */
export const DEFAULT_MAX_PATTERN_MATCHES = 200

/**
 * Directory names never entered during traversal. `node_modules` is the
 * requirement; dot-directories (`.git`, `.cache`, …) are excluded because they
 * never hold a runnable manifest and can be enormous.
 * @param name - one directory entry name.
 * @returns true when the directory must be skipped entirely.
 */
export function isIgnoredDir(name) {
  return name === 'node_modules' || name.startsWith('.')
}

/**
 * Choose the package manager from the lockfiles present at a package root.
 * npm is the fallback: it is the only one guaranteed to exist alongside node.
 * @param names - entry names present in the directory.
 * @returns the executable to drive `run`, plus its lockfile for diagnostics.
 */
export function pickPackageManager(names) {
  const set = names instanceof Set ? names : new Set(names)
  if (set.has('pnpm-lock.yaml') || set.has('pnpm-workspace.yaml')) return { command: 'pnpm', lockfile: 'pnpm-lock.yaml' }
  if (set.has('yarn.lock')) return { command: 'yarn', lockfile: 'yarn.lock' }
  if (set.has('bun.lockb') || set.has('bun.lock')) return { command: 'bun', lockfile: 'bun.lockb' }
  if (set.has('package-lock.json')) return { command: 'npm', lockfile: 'package-lock.json' }
  return { command: 'npm', lockfile: undefined }
}

/**
 * Translate one workspace glob segment into a matcher. Supports `*` and `?`
 * inside a single path segment, which covers the patterns npm workspaces and
 * pnpm-workspace.yaml actually use in practice.
 * @param segment - one path segment, possibly containing wildcards.
 * @returns a matcher for one entry name, or undefined when the segment is literal.
 */
export function segmentMatcher(segment) {
  if (!segment.includes('*') && !segment.includes('?')) return undefined
  const source = segment
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .replace(/\?/g, '[^/]')
  const re = new RegExp(`^${source}$`)
  return (name) => re.test(name)
}

/**
 * Normalize a `workspaces` field into plain pattern strings.
 * Accepts the array form and the `{ packages: [...] }` object form.
 * @param value - the raw `workspaces` field of a package.json.
 * @returns the positive patterns and the negated (`!`) patterns, in order.
 */
export function parseWorkspaces(value) {
  const list = Array.isArray(value)
    ? value
    : (value !== null && typeof value === 'object' && Array.isArray(value.packages) ? value.packages : [])
  const include = []
  const exclude = []
  for (const raw of list) {
    if (typeof raw !== 'string') continue
    const pattern = raw.trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
    if (pattern.length === 0) continue
    if (pattern.startsWith('!')) exclude.push(pattern.slice(1))
    else include.push(pattern)
  }
  return { include, exclude }
}

/**
 * Expand one workspace glob into concrete directories, relative to `base`.
 * A pattern with no wildcard is taken literally (existence is not checked
 * here; the caller discovers that when it reads the manifest). Wildcards
 * expand one segment at a time with bounded breadth.
 * @param io - the filesystem port.
 * @param base - absolute directory the pattern is relative to.
 * @param pattern - one workspace pattern (no leading `!`).
 * @param limit - maximum directories to return.
 * @returns absolute candidate directories.
 */
export async function expandPattern(io, base, pattern, limit = DEFAULT_MAX_PATTERN_MATCHES) {
  const segments = pattern.split('/').filter((part) => part.length > 0 && part !== '.')
  let current = [base]
  for (const segment of segments) {
    const matcher = segmentMatcher(segment)
    if (matcher === undefined) {
      current = current.map((dir) => io.join(dir, segment))
      continue
    }
    const next = []
    for (const dir of current) {
      let names = []
      try {
        names = await io.listDirNames(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (isIgnoredDir(name)) continue
        if (matcher(name)) next.push(io.join(dir, name))
        if (next.length >= limit) break
      }
      if (next.length >= limit) break
    }
    current = next
    if (current.length === 0) return []
  }
  return current
}

/**
 * Read and parse one package.json. A missing file, unreadable directory, or
 * malformed JSON yields undefined rather than throwing: a single broken
 * manifest in a monorepo must not take the whole feature down.
 * @param io - the filesystem port.
 * @param dir - absolute package directory.
 * @returns the manifest facts, or undefined when this directory is not a package.
 */
export async function readPackage(io, dir) {
  let text
  try {
    text = await io.readTextFile(io.join(dir, 'package.json'))
  } catch {
    return undefined
  }
  if (typeof text !== 'string' || text.length === 0) return undefined
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined
  const scripts = parsed.scripts !== null && typeof parsed.scripts === 'object' && !Array.isArray(parsed.scripts)
    ? parsed.scripts
    : {}
  const entries = []
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue
    if (name.length === 0 || name.startsWith('#')) continue
    entries.push({ name, command })
  }
  return {
    dir,
    name: typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : undefined,
    private: parsed.private === true,
    scripts: entries,
    workspaces: parsed.workspaces,
  }
}

/**
 * Discover every runnable npm script belonging to one workspace.
 *
 * The search is deliberately shallow and bounded:
 *   1. the workspace root manifest, when present;
 *   2. when that manifest declares `workspaces`, exactly the glob-matched
 *      package directories;
 *   3. otherwise the root's immediate non-ignored subdirectories.
 *
 * `node_modules` is never entered at any step.
 * @param io - the filesystem port: `{ join, readTextFile, listDirNames }`.
 * @param options - `{ cwd, maxPackages }`.
 * @returns a JSON-safe snapshot for the client, or an empty result when the
 *          workspace holds no runnable script.
 */
export async function scanWorkspace(io, options = {}) {
  const cwd = options.cwd
  const maxPackages = Number.isInteger(options.maxPackages) && options.maxPackages > 0
    ? options.maxPackages
    : DEFAULT_MAX_PACKAGES
  if (typeof cwd !== 'string' || cwd.length === 0) {
    return { cwd: '', packageManager: 'npm', packages: [], scriptCount: 0 }
  }

  let rootNames = []
  try {
    rootNames = await io.listDirNames(cwd)
  } catch {
    return { cwd, packageManager: 'npm', packages: [], scriptCount: 0, reason: 'unreadable' }
  }
  const packageManager = pickPackageManager(rootNames)

  const root = await readPackage(io, cwd)

  /** Absolute package directories to probe besides the root, in scan order. */
  const candidates = []
  const seen = new Set([cwd])
  const push = (dir) => {
    if (seen.has(dir)) return
    seen.add(dir)
    candidates.push(dir)
  }

  const { include, exclude } = parseWorkspaces(root?.workspaces)
  if (include.length > 0) {
    const excluded = new Set()
    for (const pattern of exclude) {
      for (const dir of await expandPattern(io, cwd, pattern)) excluded.add(dir)
    }
    for (const pattern of include) {
      for (const dir of await expandPattern(io, cwd, pattern)) {
        if (excluded.has(dir)) continue
        push(dir)
      }
    }
  } else {
    for (const name of rootNames) {
      if (isIgnoredDir(name)) continue
      push(io.join(cwd, name))
    }
  }

  const packages = []
  if (root !== undefined && root.scripts.length > 0) {
    packages.push({
      dir: root.dir,
      relDir: '.',
      name: root.name,
      private: root.private,
      scripts: root.scripts,
    })
  }

  for (const dir of candidates) {
    if (packages.length >= maxPackages) break
    const pkg = await readPackage(io, dir)
    if (pkg === undefined || pkg.scripts.length === 0) continue
    packages.push({
      dir: pkg.dir,
      relDir: io.relative === undefined ? pkg.dir : io.relative(cwd, pkg.dir),
      name: pkg.name,
      private: pkg.private,
      scripts: pkg.scripts,
    })
  }

  packages.sort((left, right) => {
    if (left.relDir === '.') return -1
    if (right.relDir === '.') return 1
    return left.relDir.localeCompare(right.relDir)
  })

  let scriptCount = 0
  for (const pkg of packages) scriptCount += pkg.scripts.length

  return {
    cwd,
    packageManager: packageManager.command,
    lockfile: packageManager.lockfile,
    packages,
    scriptCount,
    truncated: packages.length >= maxPackages,
  }
}

/**
 * Script names a run request may carry.
 *
 * This is an allowlist, not a denylist, because on Windows the package manager
 * is a `.cmd` shim and Node refuses to spawn it without `shell: true`. Since
 * the name reaches that shell, anything outside this character set — a space,
 * a quote, `;`, `&`, `|`, `$`, a backtick, a slash — must be rejected here
 * rather than relied on to be escaped later.
 */
const SCRIPT_NAME = /^[A-Za-z0-9][A-Za-z0-9._:@+-]*$/

/**
 * Re-validate one run request against the live filesystem.
 *
 * The client sends a directory and a script name; neither is trusted. The
 * directory must stay inside the workspace root and must still be a package
 * whose own manifest declares that script, and the returned command is always
 * `<packageManager> run <name>` — the manifest's raw command string is never
 * executed, so a crafted request cannot smuggle in an arbitrary command.
 * @param io - the filesystem port.
 * @param request - `{ cwd, dir, script }` as received from the browser.
 * @returns the resolved `{ command, args, cwd, label }`, or an error string.
 */
export async function resolveRun(io, request) {
  const cwd = request?.cwd
  const dir = request?.dir
  const script = request?.script
  if (typeof cwd !== 'string' || cwd.length === 0) return { error: 'missing workspace' }
  if (typeof dir !== 'string' || dir.length === 0) return { error: 'missing package directory' }
  if (typeof script !== 'string' || script.length === 0) return { error: 'missing script name' }
  if (!SCRIPT_NAME.test(script)) return { error: `invalid script name: ${script}` }
  // Both checks must agree: the lexical one is always available, and the
  // adapter's own `contains` (which understands the composed filesystem, and
  // may span a sandbox boundary) can only narrow the result.
  if (!isWithin(cwd, dir)) return { error: 'package is outside the workspace' }
  if (io.contains !== undefined && !io.contains(cwd, dir)) return { error: 'package is outside the workspace' }

  const pkg = await readPackage(io, dir)
  if (pkg === undefined) return { error: 'no package.json in that directory' }
  const match = pkg.scripts.find((entry) => entry.name === script)
  if (match === undefined) return { error: `no script named "${script}" in ${dir}` }

  let names = []
  try {
    names = await io.listDirNames(dir)
  } catch {
    names = []
  }
  const manager = pickPackageManager(names)
  return {
    command: manager.command,
    args: ['run', script],
    cwd: dir,
    label: `${manager.command} run ${script}`,
    packageName: pkg.name,
    scriptCommand: match.command,
  }
}
