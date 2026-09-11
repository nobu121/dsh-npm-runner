// Tests for the hand-written client bundle (lib/client.js).
//
// Run with: node tests/client.test.mjs
//
// The bundle is not built by a bundler, so nothing else checks it. This suite
// loads it exactly the way the DSH module loader does — a capturing
// `window.__ModuleLoader__` plus a `require` shim — and then asserts the
// registration contract the shell depends on.
//
// A subset renders the components through real React when it can be located
// (via `DSH_PLUGIN_TEST_NODE_MODULES`, else the local DSH profile store). When
// React cannot be found those cases SKIP rather than fail, so the suite stays
// runnable on a bare checkout. Everything else needs no dependencies.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'

let passed = 0
let failed = 0
let skipped = 0

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

function skip(name, reason) {
  skipped += 1
  console.log(`  skip ${name} — ${reason}`)
}

// ── Load the bundle the way the browser does ───────────────────────────────
// `document` is stubbed so the CSS-injection path runs; the bundle guards on
// `typeof document !== "undefined"`.
const injectedStyles = []
globalThis.document = {
  querySelector(selector) {
    const match = /^style\[data-plugin-css="(.*)"\]$/.exec(selector)
    if (match === null) return null
    return injectedStyles.find((element) => element.dataset.pluginCss === match[1]) ?? null
  },
  createElement(tag) {
    return { tag, dataset: {}, textContent: '' }
  },
  head: {
    appendChild(element) {
      injectedStyles.push(element)
    },
  },
}

const loaded = []
const localStore = new Map()
globalThis.window = {
  innerWidth: 1280,
  innerHeight: 800,
  addEventListener() {},
  removeEventListener() {},
  localStorage: {
    getItem(key) {
      return localStore.has(key) ? localStore.get(key) : null
    },
    setItem(key, value) {
      localStore.set(key, String(value))
    },
    removeItem(key) {
      localStore.delete(key)
    },
  },
  __ModuleLoader__: {
    load(definition) {
      loaded.push(definition)
    },
  },
}

await import('../lib/client.js')

const bundle = loaded[0]
const React = findReact()
const client = bundle === undefined ? undefined : bundle.factory(makeRequire(React))

/** Locate a react install, or undefined when the checkout has none. */
function findReact() {
  const candidates = [
    process.env.DSH_PLUGIN_TEST_NODE_MODULES,
    join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'web', 'node_modules'),
    join(process.cwd(), 'node_modules'),
  ].filter((entry) => typeof entry === 'string' && entry.length > 0)
  for (const dir of candidates) {
    if (!existsSync(join(dir, 'react', 'package.json'))) continue
    try {
      const req = createRequire(join(dir, 'noop.js'))
      return { react: req('react'), server: req('react-dom/server'), dir }
    } catch {
      continue
    }
  }
  return undefined
}

/** The `require` the module loader hands to a factory. */
function makeRequire(react) {
  return (id) => {
    if (id === 'react') {
      if (react === undefined) throw new Error('react is not installed')
      return react.react
    }
    if (id === 'react-dom') {
      if (react === undefined) throw new Error('react-dom is not installed')
      return createRequire(join(react.dir, 'noop.js'))('react-dom')
    }
    throw new Error(`unexpected require: ${id}`)
  }
}

// ── Bundle contract ────────────────────────────────────────────────────────
console.log('module-loader contract')

await test('registers exactly once under the package name', () => {
  assert.equal(loaded.length, 1)
  assert.equal(bundle.id, 'dsh-npm-runner')
  assert.equal(typeof bundle.factory, 'function')
})

await test('the factory exposes apply and inject', () => {
  assert.equal(typeof client.apply, 'function')
  assert.ok(Array.isArray(client.inject))
  assert.deepEqual([...client.inject].sort(), ['locale', 'sessions', 'slots'])
})

await test('injects its CSS once, tagged for cleanup', () => {
  assert.equal(injectedStyles.length, 1)
  const style = injectedStyles[0]
  assert.equal(style.dataset.plugin, 'dsh-npm-runner')
  assert.equal(style.dataset.pluginCss, 'dsh-npm-runner/client.css')
  assert.match(style.textContent, /\.dsh-npmr-trigger/)
  assert.match(style.textContent, /\.dsh-npmr-menu/)
})

await test('every style rule is namespaced and every colour is a theme token', () => {
  const css = client.helpers.css
  const selectors = css.split('}').map((rule) => rule.split('{')[0]).filter((part) => part.trim().length > 0)
  for (const selector of selectors) {
    assert.match(selector, /\.dsh-npmr-/, `un-namespaced selector: ${selector}`)
  }
  // Colours must come from `--dsw-*` (which carry light and dark values), never
  // from a literal, so the control re-themes with the app. Keyword values that
  // deliberately take the surrounding colour are fine.
  const inherited = new Set(['inherit', 'currentColor', 'transparent', 'none', '0 0'])
  for (const declaration of css.matchAll(/(?:^|[;{])(color|background|box-shadow|border-color)\s*:\s*([^;}]+)/g)) {
    const value = declaration[2].trim()
    if (inherited.has(value)) continue
    assert.match(value, /var\(--dsw-/, `literal colour in "${declaration[1]}: ${value}"`)
  }
})

await test('ships no sourceMappingURL trailer the host would have to serve', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.equal(/sourceMappingURL/.test(source), false)
})

// ── Registration ───────────────────────────────────────────────────────────
console.log('slot registration')

const captured = { effects: [], dictionaries: [], injected: [], registrations: [] }
const fakeCtx = {
  effect(fn, label) {
    captured.effects.push(label)
    return fn()
  },
  locale: {
    register(ns, dicts) {
      captured.dictionaries.push({ ns, dicts })
      return () => {}
    },
  },
  slots: {
    inject(name, callback) {
      captured.injected.push(name)
      return callback()
    },
    register(registration, component) {
      captured.registrations.push({ registration, component })
      return () => {}
    },
  },
}
client.apply(fakeCtx)

await test('registers its dictionaries under one namespace, wrapped in an effect', () => {
  assert.equal(captured.dictionaries.length, 1)
  assert.equal(captured.dictionaries[0].ns, 'npmRunner')
  assert.ok(captured.effects.some((label) => /dictionaries/.test(label)))
})

await test('contributes the composer dock and the header action row', () => {
  assert.deepEqual(captured.injected, ['conversation.input.dock', 'conversation.session.header.actions'])
  assert.equal(captured.registrations.length, 2)
  const [dock, header] = captured.registrations
  assert.equal(dock.registration.name, 'conversation.input.dock')
  assert.equal(dock.registration.id, 'npm-runner:dock')
  assert.equal(dock.registration.locale, 'npmRunner')
  assert.equal(dock.registration.registrant, 'dsh-npm-runner')
  assert.equal(typeof dock.registration.order, 'number')
  // `header.actions` is inside the title cluster and holds DSH's own session
  // controls. 15 sits it between `schedule-catalog` (10) and the built-in
  // `job-list` (20): just after the mode control, beside the job list.
  assert.equal(header.registration.name, 'conversation.session.header.actions')
  assert.equal(header.registration.id, 'npm-runner:header')
  assert.equal(header.registration.locale, 'npmRunner')
  assert.equal(header.registration.registrant, 'dsh-npm-runner')
  assert.equal(header.registration.order, 15)
})

await test('the two list cells use distinct ids', () => {
  const ids = captured.registrations.map((entry) => entry.registration.id)
  assert.equal(new Set(ids).size, ids.length)
})

await test('each registration is a distinct stable component', () => {
  const [dock, header] = captured.registrations
  assert.equal(typeof dock.component, 'function')
  assert.equal(typeof header.component, 'function')
  assert.notEqual(dock.component, header.component)
})

// ── Pure helpers ───────────────────────────────────────────────────────────
console.log('helpers')

const {
  isBlankSession,
  formatDuration,
  format,
  statusLabel,
  packageLabel,
  baseName,
  runsForWorkspace,
  readCollapsed,
  writeCollapsed,
  dictionaries,
  route,
  css,
} = client.helpers

await test('the route prefix matches the host half', () => {
  assert.equal(route, '/npm-runner')
})

await test('both dictionaries carry an identical key set', () => {
  const zhKeys = Object.keys(dictionaries.zh).sort()
  const enKeys = Object.keys(dictionaries.en).sort()
  assert.deepEqual(zhKeys, enKeys)
  assert.ok(zhKeys.length > 0)
})

await test('format interpolates named placeholders and leaves unknown ones', () => {
  assert.equal(format('{a} and {b}', { a: 1, b: 'x' }), '1 and x')
  assert.equal(format('{a}', undefined), '{a}')
  assert.equal(format('{missing}', {}), '{missing}')
})

await test('formatDuration uses at most two adjacent units', () => {
  assert.equal(formatDuration(0), '0s')
  assert.equal(formatDuration(59_400), '59s')
  assert.equal(formatDuration(61_000), '1m 1s')
  assert.equal(formatDuration(3_600_000), '1h 0m')
  assert.equal(formatDuration(3_725_000), '1h 2m')
  assert.equal(formatDuration(-5), '0s')
})

await test('statusLabel maps every wire status', () => {
  for (const status of ['running', 'stopping', 'completed', 'failed', 'killed']) {
    assert.equal(statusLabel(status, (key) => key), `status.${status}`)
  }
})

console.log('package group labels')

await test('baseName takes the final segment of either separator style', () => {
  assert.equal(baseName('D:\\work\\app'), 'app')
  assert.equal(baseName('/home/nobu/app'), 'app')
  assert.equal(baseName('/home/nobu/app/'), 'app')
  assert.equal(baseName('app'), 'app')
})

await test('the root package is labelled by its folder, not by "."', () => {
  const label = packageLabel({ dir: 'D:\\work\\npm-runner', relDir: '.', name: 'dsh-npm-runner' })
  assert.equal(label.name, 'npm-runner')
  assert.equal(label.meta, 'dsh-npm-runner')
})

await test('a nested package is labelled by its relative path', () => {
  const label = packageLabel({ dir: '/ws/packages/app', relDir: 'packages/app', name: 'app' })
  assert.equal(label.name, 'packages/app')
  assert.equal(label.meta, 'app')
})

await test('the secondary label is dropped when it would only repeat the primary', () => {
  assert.equal(packageLabel({ dir: '/ws/app', relDir: 'app', name: 'app' }).meta, undefined)
  assert.equal(packageLabel({ dir: '/ws/app', relDir: 'app' }).meta, undefined)
  assert.equal(packageLabel({ dir: '/ws/app', relDir: 'app' }).name, 'app')
})

console.log('run visibility')

const RUNS = [
  { id: 'a', script: 'serve', workspace: 'D:\\work\\alpha' },
  { id: 'b', script: 'dev', workspace: 'D:\\work\\alpha' },
  { id: 'c', script: 'test', workspace: 'D:\\work\\beta' },
  { id: 'd', script: 'orphan' },
]

await test('shows every run of the current workspace, across conversations', () => {
  assert.deepEqual(runsForWorkspace(RUNS, 'D:\\work\\alpha').map((run) => run.id), ['a', 'b'])
  assert.deepEqual(runsForWorkspace(RUNS, 'D:\\work\\beta').map((run) => run.id), ['c'])
})

await test('never shows a run from another workspace', () => {
  const shown = runsForWorkspace(RUNS, 'D:\\work\\alpha').map((run) => run.id)
  assert.equal(shown.includes('c'), false, 'beta is a different workspace')
})

await test('shows nothing when the workspace is unresolved', () => {
  assert.deepEqual(runsForWorkspace(RUNS, undefined), [])
  assert.deepEqual(runsForWorkspace(RUNS, ''), [])
})

await test('a run with no workspace of its own never matches', () => {
  for (const cwd of ['D:\\work\\alpha', 'D:\\work\\beta']) {
    assert.equal(runsForWorkspace(RUNS, cwd).some((run) => run.id === 'd'), false)
  }
})

await test('an empty run list is handled', () => {
  assert.deepEqual(runsForWorkspace([], 'D:\\work\\alpha'), [])
})

console.log('collapse persistence')

await test('collapsed groups round-trip per workspace', () => {
  writeCollapsed('/ws-a', { '/ws-a/packages/app': true })
  writeCollapsed('/ws-b', { '/ws-b/other': true })
  assert.deepEqual(readCollapsed('/ws-a'), { '/ws-a/packages/app': true })
  assert.deepEqual(readCollapsed('/ws-b'), { '/ws-b/other': true })
  assert.deepEqual(readCollapsed('/ws-c'), {}, 'an unvisited workspace starts expanded')
})

await test('only true entries survive a read, and junk never throws', () => {
  window.localStorage.setItem('dsh-npm-runner:collapsed:/ws-junk', '{"a":true,"b":false,"c":"yes"}')
  assert.deepEqual(readCollapsed('/ws-junk'), { a: true })
  window.localStorage.setItem('dsh-npm-runner:collapsed:/ws-bad', 'not json')
  assert.deepEqual(readCollapsed('/ws-bad'), {})
  window.localStorage.setItem('dsh-npm-runner:collapsed:/ws-arr', '[1,2]')
  assert.deepEqual(readCollapsed('/ws-arr'), {})
})

await test('an empty or missing workspace key is a no-op', () => {
  assert.deepEqual(readCollapsed(undefined), {})
  assert.deepEqual(readCollapsed(''), {})
  writeCollapsed('', { a: true })
  assert.deepEqual(readCollapsed(''), {})
})

console.log('collapse styles')

await test('ships the disclosure and indentation rules the groups need', () => {
  for (const selector of ['.dsh-npmr-chevron', '.dsh-npmr-chevronOpen', '.dsh-npmr-pkg', '.dsh-npmr-pkgName', '.dsh-npmr-pkgMeta', '.dsh-npmr-pkgCount', '.dsh-npmr-scripts']) {
    assert.ok(css.includes(selector), `missing style for ${selector}`)
  }
  assert.match(css, /\.dsh-npmr-chevronOpen\{[^}]*rotate\(90deg\)/, 'the chevron must turn when expanded')
  assert.match(css, /\.dsh-npmr-scripts\{[^}]*padding:[^;}]*16px/, 'scripts must be indented under their package')
})

await test('a Session is blank exactly as the shell computes it', () => {
  const conversation = { activeTargets: new Set() }
  // The shell's rule is `activeTargets.size > 0 || (!blank && !awaitingFirstTurn) || running`,
  // so a Session only leaves the blank phase when BOTH `blank` and
  // `awaitingFirstTurn` are falsy — one flag alone is not enough.
  const fresh = { blank: true, awaitingFirstTurn: true, running: false, promptAttempted: false }

  assert.equal(isBlankSession(undefined, conversation), true, 'no Session at all')
  assert.equal(isBlankSession(fresh, conversation), true, 'fresh Session')
  assert.equal(isBlankSession(fresh, { activeTargets: new Set(['target']) }), false, 'a conversation target exists')
  assert.equal(isBlankSession({ ...fresh, blank: false }, conversation), true, 'awaitingFirstTurn still holds it')
  assert.equal(isBlankSession({ ...fresh, awaitingFirstTurn: false }, conversation), true, 'blank still holds it')
  assert.equal(isBlankSession({ ...fresh, blank: false, awaitingFirstTurn: false }, conversation), false, 'both cleared')
  assert.equal(isBlankSession({ ...fresh, running: true }, conversation), false, 'running')
  assert.equal(isBlankSession({ ...fresh, promptAttempted: true }, conversation), false, 'first prompt attempted')

  // A missing Conversation snapshot must not crash the decision.
  assert.equal(isBlankSession(fresh, undefined), true)
  assert.equal(isBlankSession({ ...fresh, running: true }, undefined), false)
  assert.equal(isBlankSession(undefined, undefined), true)
})

console.log('trigger')

await test('uses the Solar play-outline glyph', () => {
  const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  assert.ok(source.includes('M7.23832 3.04445'), "solar:play-outline's path must be the one shipped")
  assert.ok(source.includes('viewBox: "0 0 24 24"'), 'the glyph keeps its 24-unit source box')
  assert.ok(source.includes('fill: "currentColor"'), 'the glyph must take the button colour')
  assert.ok(source.includes('fillRule: "evenodd"'), 'the outlined triangle needs the even-odd rule')
})

await test('shows no script count', () => {
  assert.equal(css.includes('triggerLabel'), false, 'the count label is gone')
})

await test('shares the Hero workspace/preset row instead of claiming one', () => {
  const row = /\.dsh-npmr-dockRow\{([^}]*)\}/.exec(css)
  const dock = /\.dsh-npmr-dock\{([^}]*)\}/.exec(css)
  assert.ok(row !== null, 'the dock row has a rule')
  assert.ok(dock !== null, 'the dock wrapper has a rule')
  assert.match(row[1], /height:0/, 'the row must claim no height of its own')
  assert.match(row[1], /position:relative/, 'the wrapper is placed against the row')
  assert.match(dock[1], /position:absolute/)
  assert.match(dock[1], /bottom:8px/, 'lift by the composerHero gap so it lands on that line')
  assert.match(dock[1], /right:16px/, "align with the workspace row's own right padding")
})

await test('matches the host header icon-button recipe', () => {
  const trigger = /\.dsh-npmr-trigger\{([^}]*)\}/.exec(css)
  assert.ok(trigger !== null, 'the trigger has a rule')
  const rule = trigger[1]
  assert.match(rule, /width:28px/, 'the host uses a 28px square target')
  assert.match(rule, /height:28px/)
  assert.match(rule, /border-radius:28px/, 'the host hover is a circle, not a rounded square')
  assert.match(rule, /color:var\(--dsw-alias-label-secondary\)/, 'same tint as the neighbouring icons')
  assert.match(rule, /background:0 0/, 'no resting background')
  assert.match(css, /\.dsh-npmr-trigger svg\{[^}]*width:15px/, 'the host sizes header glyphs at 15px')
  // Hover only tints the background, exactly as the host does.
  const hover = /\.dsh-npmr-trigger:hover[^{]*\{([^}]*)\}/.exec(css)
  assert.ok(hover !== null, 'the trigger has a hover rule')
  assert.match(hover[1], /background:var\(--dsw-alias-interactive-bg-hover\)/)
  assert.equal(/color:/.test(hover[1]), false, 'hover must not change the glyph colour')
})

await test('keeps the running indicator off the 28px footprint', () => {
  const badge = /\.dsh-npmr-dotBadge\{([^}]*)\}/.exec(css)
  assert.ok(badge !== null, 'the badge has a rule')
  assert.match(badge[1], /position:absolute/, 'a corner badge leaves the square target intact')
})

await test('the run-list header is a row, so the clear action can ride it', () => {
  const section = /\.dsh-npmr-section\{([^}]*)\}/.exec(css)
  assert.ok(section !== null, 'the section header has a rule')
  assert.match(section[1], /display:flex/, 'the header must lay its label and action out in a row')
  assert.match(section[1], /align-items:center/)
  const label = /\.dsh-npmr-sectionLabel\{([^}]*)\}/.exec(css)
  assert.ok(label !== null, 'the label has its own rule')
  assert.match(label[1], /flex:1/, 'the label takes the space so the action sits at the right')
})

await test('uses the app UI font, reserving the code font for code', () => {
  const menu = /\.dsh-npmr-menu\{([^}]*)\}/.exec(css)
  assert.ok(menu !== null, 'the menu has a rule')
  assert.match(menu[1], /font-family:var\(--dsw-font-family\)/, 'labels must follow the app font')
  // `--dsw-font-mono` is not a real token. DSH's own use of it resolves to the
  // inherited font; adding a fallback list here would force monospace on every
  // label and make the whole panel look foreign.
  assert.equal(css.includes('--dsw-font-mono'), false, 'do not reference a token that does not exist')
  const codeSelectors = [...css.matchAll(/([^{}]+)\{[^}]*--ds-font-family-code/g)].map((match) => match[1].trim())
  assert.deepEqual(codeSelectors, ['.dsh-npmr-cmd', '.dsh-npmr-output'], 'only commands and raw output are code')
})

// ── Render (needs React) ───────────────────────────────────────────────────
console.log('render')

/** Standard slot props for one render case. */
function slotProps({ blank, cwd = '/ws', placement, sessionId = 's1' }) {
  return {
    sessionId,
    placement,
    useSessions: (selector) => selector({ byId: { s1: { cwd } } }),
    useSession: (selector) => selector({ blank, awaitingFirstTurn: true, running: false, promptAttempted: false }),
    useConversation: (selector) => selector({ activeTargets: new Set() }),
    t: (key) => key,
  }
}

/** Render one registered component to static markup, or null when it renders nothing. */
function renderComponent(component, props) {
  const element = React.react.createElement(component, props)
  const markup = React.server.renderToStaticMarkup(element)
  return markup === '' ? null : markup
}

if (React === undefined) {
  skip('placement gating picks exactly one slot', 'no react install found')
  skip('stays hidden until the workspace scan resolves', 'no react install found')
  skip('renders without throwing for either placement', 'no react install found')
} else {
  const [dock, header] = captured.registrations

  // Effects do not run under static rendering, so these cases all land on one
  // of the component's two early returns. That still pins the two decisions
  // that matter most: which placement owns which Session state, and that the
  // control never appears before it has something to offer. The populated
  // render is exercised in the browser.
  await test('placement gating picks exactly one slot', () => {
    // `visible` is false in both, so these return before any data is needed.
    assert.equal(renderComponent(dock.component, slotProps({ blank: false, placement: 'dock' })), null, 'dock must not render for an established conversation')
    assert.equal(renderComponent(header.component, slotProps({ blank: true, placement: 'header' })), null, 'header must not render for a blank Session')
  })

  await test('stays hidden until the workspace scan resolves', () => {
    // `visible` holds, but no scan has landed yet.
    assert.equal(renderComponent(dock.component, slotProps({ blank: true, placement: 'dock' })), null)
    assert.equal(renderComponent(header.component, slotProps({ blank: false, placement: 'header' })), null)
    assert.equal(renderComponent(dock.component, slotProps({ blank: true, placement: 'dock', cwd: '' })), null, 'no cwd')
    assert.equal(renderComponent(header.component, slotProps({ blank: false, placement: 'header', cwd: undefined })), null, 'undefined cwd')
  })

  await test('renders without throwing for either placement', () => {
    for (const sessionId of ['s1', undefined]) {
      for (const placement of ['dock', 'header']) {
        for (const blank of [true, false]) {
          const markup = renderComponent(dock.component, slotProps({ blank, placement, sessionId }))
          assert.equal(markup, null)
        }
      }
    }
  })
}

console.log('')
console.log(`${passed} passed, ${failed} failed${skipped > 0 ? `, ${skipped} skipped` : ''}`)
if (failed > 0) process.exitCode = 1
