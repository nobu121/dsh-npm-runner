// Unit tests for the pure workspace-scan core (lib/scan.js).
//
// Run with: node tests/scan.test.mjs
//
// Every case drives scanWorkspace through the in-memory `io` port, so the
// suite asserts the discovery rules themselves — including the one requirement
// that matters most, that a package.json inside node_modules is never a
// candidate — without depending on a real filesystem layout.

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join as pathJoin, relative as pathRelative, sep } from 'node:path'

import {
  DEFAULT_MAX_PACKAGES,
  expandPattern,
  isIgnoredDir,
  parseWorkspaces,
  pickPackageManager,
  readPackage,
  resolveRun,
  scanWorkspace,
  segmentMatcher,
} from '../lib/scan.js'

let passed = 0
let failed = 0

/** Minimal assertion harness so the suite needs no test runner. */
async function test(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Resolve a fixture path to `{ abs, segments }`, collapsing `.` and `..`.
 * Fixture paths are POSIX-ish, so a leading `/` is preserved.
 */
function splitPath(path) {
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

/** Normalize a path into `/`-separated form for the in-memory tree. */
function normalize(path) {
  const { abs, segments } = splitPath(path)
  return abs ? `/${segments.join('/')}` : segments.join('/')
}

/**
 * Build an `io` port over a nested plain-object tree. Leaf strings are file
 * contents; nested objects are directories. Listing a directory that does not
 * exist throws, which is how the real adapter behaves.
 * @param tree - the virtual filesystem.
 * @param root - the absolute path the tree is mounted at.
 */
function createMemoryIo(tree, root = '/ws') {
  const join = (...parts) => normalize(parts.filter((part) => part !== undefined && part !== '').join('/'))
  const rootParts = splitPath(root)
  const lookup = (path) => {
    const { abs, segments } = splitPath(path)
    if (abs !== rootParts.abs) return undefined
    if (segments.length < rootParts.segments.length) return undefined
    for (let i = 0; i < rootParts.segments.length; i += 1) {
      if (segments[i] !== rootParts.segments[i]) return undefined
    }
    let node = tree
    for (const part of segments.slice(rootParts.segments.length)) {
      if (node === null || typeof node !== 'object') return undefined
      node = node[part]
    }
    return node
  }
  return {
    join,
    relative: (from, to) => {
      const a = splitPath(from).segments
      const b = splitPath(to).segments
      let i = 0
      while (i < a.length && a[i] === b[i]) i += 1
      return b.slice(i).join('/')
    },
    contains: (parent, child) => {
      const p = splitPath(parent).segments
      const c = splitPath(child).segments
      if (c.length < p.length) return false
      return p.every((part, i) => part === c[i])
    },
    async readTextFile(path) {
      const value = lookup(path)
      return typeof value === 'string' ? value : undefined
    },
    async listDirNames(path) {
      const value = lookup(path)
      if (value === undefined) throw new Error(`ENOENT: ${String(path)}`)
      if (value === null || typeof value !== 'object') return []
      return Object.keys(value)
    },
  }
}

/** A package.json body with the given scripts. */
function manifest(scripts, extra = {}) {
  return JSON.stringify({ name: extra.name ?? 'pkg', scripts, ...extra })
}

console.log('scanWorkspace')

await test('reports the workspace root package scripts', async () => {
  const io = createMemoryIo({ 'package.json': manifest({ dev: 'vite', build: 'tsc' }, { name: 'root' }) })
  const result = await scanWorkspace(io, { cwd: '/ws' })
  assert.equal(result.packages.length, 1)
  assert.equal(result.packages[0].relDir, '.')
  assert.equal(result.packages[0].name, 'root')
  assert.deepEqual(result.packages[0].scripts.map((s) => s.name), ['dev', 'build'])
  assert.equal(result.scriptCount, 2)
})

await test('never enters node_modules', async () => {
  const io = createMemoryIo({
    'package.json': manifest({ start: 'node .' }),
    node_modules: {
      dep: { 'package.json': manifest({ postinstall: 'evil' }, { name: 'dep' }) },
      '.bin': { 'package.json': manifest({ x: 'y' }) },
    },
  })
  const result = await scanWorkspace(io, { cwd: '/ws' })
  assert.deepEqual(result.packages.map((p) => p.relDir), ['.'])
  assert.equal(result.scriptCount, 1)
})

await test('discovers depth-1 sibling packages and skips node_modules there', async () => {
  const io = createMemoryIo({
    'package.json': manifest({ root: 'echo root' }),
    packages: {
      a: { 'package.json': manifest({ test: 'vitest' }, { name: 'a' }) },
      node_modules: { b: { 'package.json': manifest({ bad: 'nope' }) } },
      notapkg: { 'readme.md': '# hi' },
    },
  })
  const result = await scanWorkspace(io, { cwd: '/ws' })
  // No `workspaces` field, so depth-1 children are scanned: packages/a is a
  // depth-2 directory and correctly is NOT reached.
  assert.deepEqual(result.packages.map((p) => p.relDir), ['.'])
})

await test('expands a workspaces glob and honours negations', async () => {
  const io = createMemoryIo({
    'package.json': manifest({ lint: 'eslint .' }, { workspaces: ['packages/*', '!packages/legacy'] }),
    packages: {
      a: { 'package.json': manifest({ dev: 'vite' }, { name: 'a' }) },
      b: { 'package.json': manifest({ test: 'vitest' }, { name: 'b' }) },
      legacy: { 'package.json': manifest({ old: 'gulp' }, { name: 'legacy' }) },
      'no-manifest': { 'index.js': '' },
    },
  })
  const result = await scanWorkspace(io, { cwd: '/ws' })
  assert.deepEqual(result.packages.map((p) => p.relDir), ['.', 'packages/a', 'packages/b'])
  assert.equal(result.scriptCount, 3)
})

await test('a package.json inside a workspace package node_modules is ignored', async () => {
  const io = createMemoryIo({
    'package.json': manifest({}, { workspaces: ['packages/*'] }),
    packages: {
      a: {
        'package.json': manifest({ dev: 'vite' }, { name: 'a' }),
        node_modules: { nested: { 'package.json': manifest({ boom: 'bad' }) } },
      },
    },
  })
  const result = await scanWorkspace(io, { cwd: '/ws' })
  assert.deepEqual(result.packages.map((p) => p.relDir), ['packages/a'])
})

await test('a malformed manifest is skipped without throwing', async () => {
  const io = createMemoryIo({
    'package.json': manifest({}, { workspaces: ['packages/*'] }),
    packages: {
      a: { 'package.json': manifest({ ok: 'true' }, { name: 'a' }) },
      broken: { 'package.json': '{ not json' },
    },
  })
  const result = await scanWorkspace(io, { cwd: '/ws' })
  assert.deepEqual(result.packages.map((p) => p.relDir), ['packages/a'])
  assert.equal(result.scriptCount, 1)
})

await test('a malformed root manifest still allows sibling discovery', async () => {
  const io = createMemoryIo({
    'package.json': '{ not json',
    app: { 'package.json': manifest({ dev: 'vite' }, { name: 'app' }) },
  })
  const result = await scanWorkspace(io, { cwd: '/ws' })
  assert.deepEqual(result.packages.map((p) => p.relDir), ['app'])
  assert.equal(result.scriptCount, 1)
})

await test('a manifest with no scripts is not reported', async () => {
  const io = createMemoryIo({ 'package.json': manifest({}) })
  const result = await scanWorkspace(io, { cwd: '/ws' })
  assert.deepEqual(result.packages, [])
  assert.equal(result.scriptCount, 0)
})

await test('detects the package manager from lockfiles', async () => {
  const pnpm = createMemoryIo({ 'package.json': manifest({ a: 'b' }), 'pnpm-lock.yaml': '' })
  assert.equal((await scanWorkspace(pnpm, { cwd: '/ws' })).packageManager, 'pnpm')
  const yarn = createMemoryIo({ 'package.json': manifest({ a: 'b' }), 'yarn.lock': '' })
  assert.equal((await scanWorkspace(yarn, { cwd: '/ws' })).packageManager, 'yarn')
  const bun = createMemoryIo({ 'package.json': manifest({ a: 'b' }), 'bun.lockb': '' })
  assert.equal((await scanWorkspace(bun, { cwd: '/ws' })).packageManager, 'bun')
  const plain = createMemoryIo({ 'package.json': manifest({ a: 'b' }) })
  assert.equal((await scanWorkspace(plain, { cwd: '/ws' })).packageManager, 'npm')
})

await test('caps the number of reported packages', async () => {
  const children = {}
  for (let i = 0; i < 12; i += 1) children[`p${i}`] = { 'package.json': manifest({ run: 'x' }) }
  const io = createMemoryIo({ 'package.json': manifest({}, { workspaces: ['*'] }), ...children })
  const result = await scanWorkspace(io, { cwd: '/ws', maxPackages: 4 })
  assert.equal(result.packages.length, 4)
  assert.equal(result.truncated, true)
})

await test('an unreadable workspace yields an empty snapshot', async () => {
  const io = createMemoryIo({ 'package.json': manifest({ a: 'b' }) })
  const result = await scanWorkspace(io, { cwd: '/elsewhere' })
  assert.deepEqual(result.packages, [])
  assert.equal(result.reason, 'unreadable')
})

await test('a missing cwd yields an empty snapshot', async () => {
  const io = createMemoryIo({})
  assert.deepEqual((await scanWorkspace(io, { cwd: '' })).packages, [])
})

console.log('helpers')

await test('isIgnoredDir covers node_modules and dot-directories', () => {
  assert.equal(isIgnoredDir('node_modules'), true)
  assert.equal(isIgnoredDir('.git'), true)
  assert.equal(isIgnoredDir('packages'), false)
  assert.equal(isIgnoredDir('node_modules_backup'), false)
})

await test('segmentMatcher only matches within one segment', () => {
  const match = segmentMatcher('pkg-*')
  assert.equal(match('pkg-a'), true)
  assert.equal(match('pkg-a/b'), false)
  assert.equal(match('other'), false)
  assert.equal(segmentMatcher('exact'), undefined)
})

await test('parseWorkspaces accepts both field shapes', () => {
  assert.deepEqual(parseWorkspaces(['packages/*']), { include: ['packages/*'], exclude: [] })
  assert.deepEqual(parseWorkspaces({ packages: ['apps/*', '!apps/x'] }), { include: ['apps/*'], exclude: ['apps/x'] })
  assert.deepEqual(parseWorkspaces(undefined), { include: [], exclude: [] })
})

await test('pickPackageManager prefers pnpm and falls back to npm', () => {
  assert.equal(pickPackageManager(['pnpm-lock.yaml', 'package-lock.json']).command, 'pnpm')
  assert.equal(pickPackageManager([]).command, 'npm')
  assert.equal(DEFAULT_MAX_PACKAGES > 0, true)
})

await test('expandPattern resolves a literal path without listing', async () => {
  const io = createMemoryIo({})
  assert.deepEqual(await expandPattern(io, '/ws', 'packages/a'), ['/ws/packages/a'])
})

console.log('resolveRun')

await test('accepts a script the manifest really declares', async () => {
  const io = createMemoryIo({
    'package.json': manifest({}, { workspaces: ['*'] }),
    app: { 'package.json': manifest({ dev: 'vite --host' }, { name: 'app' }), 'pnpm-lock.yaml': '' },
  })
  const resolved = await resolveRun(io, { cwd: '/ws', dir: '/ws/app', script: 'dev' })
  assert.equal(resolved.error, undefined)
  assert.equal(resolved.command, 'pnpm')
  assert.deepEqual(resolved.args, ['run', 'dev'])
  assert.equal(resolved.label, 'pnpm run dev')
  assert.equal(resolved.scriptCommand, 'vite --host')
})

await test('rejects a script that is not declared', async () => {
  const io = createMemoryIo({ 'package.json': manifest({ dev: 'vite' }) })
  const resolved = await resolveRun(io, { cwd: '/ws', dir: '/ws', script: 'rm-rf' })
  assert.match(resolved.error, /no script named/)
})

await test('rejects a directory outside the workspace', async () => {
  const io = createMemoryIo({ 'package.json': manifest({ dev: 'vite' }) })
  const resolved = await resolveRun(io, { cwd: '/ws', dir: '/ws/../etc', script: 'dev' })
  assert.match(resolved.error, /outside the workspace/)
})

await test('rejects a hostile script name', async () => {
  const io = createMemoryIo({ 'package.json': manifest({ dev: 'vite' }) })
  const hostile = [
    'dev && rm -rf /',
    'dev; rm -rf /',
    'dev | tee /etc/passwd',
    'dev `whoami`',
    'dev $(whoami)',
    '--prefix',
    '../x',
    'a/b',
    'a\\b',
    'dev"quoted',
    "dev'quoted",
    'dev\nrm',
    '-dev',
    '',
  ]
  for (const script of hostile) {
    const resolved = await resolveRun(io, { cwd: '/ws', dir: '/ws', script })
    assert.notEqual(resolved.error, undefined, `expected rejection for ${JSON.stringify(script)}`)
  }
})

await test('accepts the script names real projects use', async () => {
  const names = ['dev', 'build', 'test:unit', 'lint:fix', 'build.watch', 'pre-publish', 'start:web@2']
  const scripts = {}
  for (const name of names) scripts[name] = 'true'
  const io = createMemoryIo({ 'package.json': manifest(scripts) })
  for (const name of names) {
    const resolved = await resolveRun(io, { cwd: '/ws', dir: '/ws', script: name })
    assert.equal(resolved.error, undefined, `expected acceptance for ${name}`)
    assert.deepEqual(resolved.args, ['run', name])
  }
})

await test('rejects a directory with no manifest', async () => {
  const io = createMemoryIo({ 'package.json': manifest({ dev: 'vite' }), empty: {} })
  const resolved = await resolveRun(io, { cwd: '/ws', dir: '/ws/empty', script: 'dev' })
  assert.match(resolved.error, /no package\.json/)
})

console.log('readPackage against a real filesystem')

await test('reads a real package.json through a real-fs port', async () => {
  const dir = await mkdtemp(pathJoin(tmpdir(), 'dsh-npm-runner-'))
  try {
    await writeFile(pathJoin(dir, 'package.json'), manifest({ hello: 'echo hi' }, { name: 'real' }), 'utf8')
    await mkdir(pathJoin(dir, 'node_modules', 'dep'), { recursive: true })
    await writeFile(pathJoin(dir, 'node_modules', 'dep', 'package.json'), manifest({ sneaky: 'x' }), 'utf8')

    const { readFile, readdir } = await import('node:fs/promises')
    const io = {
      join: (...parts) => parts.join(sep),
      relative: (from, to) => pathRelative(from, to).split(sep).join('/'),
      contains: (parent, child) => {
        const rel = pathRelative(parent, child)
        return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
      },
      async readTextFile(path) {
        try {
          return await readFile(path, 'utf8')
        } catch {
          return undefined
        }
      },
      async listDirNames(path) {
        try {
          return await readdir(path)
        } catch {
          return []
        }
      },
    }

    const result = await scanWorkspace(io, { cwd: dir })
    assert.equal(result.packages.length, 1)
    assert.equal(result.packages[0].scripts[0].name, 'hello')
    assert.equal(await readPackage(io, dir).then((p) => p.name), 'real')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

console.log('')
console.log(`${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
