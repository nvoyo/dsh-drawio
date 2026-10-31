/**
 * Client-half verification without a browser.
 *
 * `client.js` is a plain script that calls `window.__ModuleLoader__.load`.
 * This harness supplies that loader, a React stand-in, and a slot/locale context
 * shaped like the Harness Client, then drives the real component code:
 * the panel is rendered with a fake React renderer, its fetches are answered by
 * the real Host routes, and the draw.io message protocol is exercised by
 * posting the exact messages the editor sends.
 *
 * Run with: node test/client.test.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply, ROUTE_PREFIX } from '../index.js'

/** The package's own identity, read from its manifest: tests must not guess it. */
const PKG = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const PKG_NAME = PKG.name

/**
 * A tiny React stand-in: components are plain functions, so rendering one means
 * calling it and walking the returned element tree for assertions.
 */
function createReactStub() {
  const createElement = (type, props, ...children) => ({
    type,
    props: { ...(props ?? {}), children: children.length === 1 ? children[0] : children.length === 0 ? undefined : children },
  })
  const state = []
  let cursor = 0
  let firstRefValue = null
  const React = {
    createElement,
    Fragment: Symbol('fragment'),
    createContext: () => ({ Provider: Symbol('provider'), Consumer: Symbol('consumer') }),
    useRef: (initial) => {
      const index = cursor
      cursor += 1
      // Each ref slot is its own object: components call useRef more than once
      // and sharing one handle would let `xmlRef.current = …` clobber `frameRef`.
      if (state[index] === undefined) {
        if (firstRefValue !== null && !firstRefValue.taken) {
          firstRefValue.taken = true
          state[index] = firstRefValue.value
        } else {
          state[index] = { current: initial }
        }
      }
      return state[index]
    },
    useState: (initial) => {
      const index = cursor
      cursor += 1
      if (state[index] === undefined) state[index] = { value: typeof initial === 'function' ? initial() : initial }
      const setter = (next) => {
        state[index].value = typeof next === 'function' ? next(state[index].value) : next
      }
      return [state[index].value, setter]
    },
    useCallback: (fn) => fn,
    useEffect: (effect) => {
      const index = cursor
      cursor += 1
      if (state[index] === undefined) state[index] = { ran: false }
      if (!state[index].ran) {
        state[index].ran = true
        const cleanup = effect()
        state[index].cleanup = typeof cleanup === 'function' ? cleanup : undefined
      }
    },
    useMemo: (fn) => fn(),
    useLayoutEffect: (effect) => {
      const index = cursor
      cursor += 1
      if (state[index] === undefined) state[index] = { ran: false }
      if (!state[index].ran) {
        state[index].ran = true
        effect()
      }
    },
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
    /** Rewind hook indices so a re-render sees fresh state. */
    reset() {
      cursor = 0
    },
    /** Drop all hook state, so effects run again on the next render. */
    resetAll() {
      cursor = 0
      state.length = 0
    },
    /**
     * Route the *first* `useRef` of the next render to `value`, so a test can
     * control the iframe handle while every other ref keeps its own slot.
     */
    firstRef(value) {
      firstRefValue = { value, taken: false }
    },
  }
  return React
}

/** A slot/locale context that records registrations. */
function createClientContext(React) {
  const panels = new Map()
  const rows = new Map()
  const toolviews = new Map()
  const rightTabs = new Map()
  const dictionaries = []
  const locale = {
    active: 'zh',
    register(ns, dicts) {
      dictionaries.push({ ns, dicts })
      return () => {}
    },
    bind(ns) {
      return (key, params) => {
        const dict = dictionaries.find((entry) => entry.ns === ns)
        const table = dict?.dicts?.[locale.active] ?? {}
        const template = table[key] ?? key
        if (params === undefined) return template
        return String(template).replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
      }
    },
    getLocale: () => ({ active: locale.active, locales: [], revision: 0 }),
  }
  const ctx = {
    effect(callback) {
      callback()
      return () => {}
    },
    locale,
    slots: {
      register(options, component) {
        if (options.name === 'main') panels.set(options.key, { options, component })
        else if (options.name === 'tool.call.toolview') toolviews.set(options.key, { options, component })
        else if (options.name === 'sidebar.right.pane.tab') rightTabs.set(options.id, { options, component })
        else rows.set(options.id, { options, component })
        return () => {
          if (options.name === 'main') panels.delete(options.key)
          else if (options.name === 'tool.call.toolview') toolviews.delete(options.key)
          else if (options.name === 'sidebar.right.pane.tab') rightTabs.delete(options.id)
          else rows.delete(options.id)
        }
      },
      inject(name, callback) {
        callback()
        return () => {}
      },
    },
  }
  return { ctx, panels, rows, toolviews, rightTabs, dictionaries, React }
}

/** Walk a rendered tree depth-first, rendering child components as React would. */
function* walk(node) {
  if (node === null || node === undefined) return
  if (Array.isArray(node)) {
    for (const child of node) yield* walk(child)
    return
  }
  if (typeof node !== 'object') return
  // A function element is a component: render it so its subtree is reachable.
  if (typeof node.type === 'function') {
    yield* walk(node.type(node.props))
    return
  }
  yield node
  yield* walk(node.props?.children)
}

/** Collect rendered host elements of one tag. */
function collect(tree, tag) {
  return [...walk(tree)].filter((element) => element.type === tag)
}

/** Find a rendered component by its function name anywhere in a tree. */
function findComponent(node, name, seen = new Set()) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined
  if (seen.has(node)) return undefined
  seen.add(node)
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findComponent(child, name, seen)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (typeof node.type === 'function' && node.type.name === name) return node.type
  return findComponent(node.props?.children, name, seen)
}

/** Collect text of one rendered element, skipping nested component props. */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (typeof node !== 'object') return ''
  return textOf(node.props?.children)
}

/**
 * Window message listeners registered by the components under test. One array
 * for the whole run, so re-installing the stub (undici clears the `document`
 * global on first use) never hides a listener an earlier render registered.
 */
const listeners = []

/** Minimal browser globals the panel touches. */
function installDomStub() {
  const documentStub = {
    createElement: () => ({ href: '', download: '', click() {} }),
    documentElement: {
      getAttribute: () => null,
      style: {},
      setAttribute() {},
    },
    body: { dataset: {} },
    addEventListener() {},
    removeEventListener() {},
  }
  globalThis.document = documentStub
  globalThis.window = {
    __ModuleLoader__: { load: (entry) => (globalThis.__dshDrawioEntry = entry) },
    addEventListener: (name, handler) => listeners.push({ name, handler }),
    removeEventListener: (name, handler) => {
      const index = listeners.findIndex((entry) => entry.name === name && entry.handler === handler)
      if (index !== -1) listeners.splice(index, 1)
    },
    setTimeout: (fn) => {
      fn()
      return 0
    },
    clearTimeout() {},
    prompt: () => null,
  }
  globalThis.getComputedStyle = () => ({ colorScheme: 'light' })
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
  globalThis.URL.createObjectURL = () => 'blob:stub'
  globalThis.URL.revokeObjectURL = () => {}
  return { listeners }
}

/** Route the panel's fetches to a real server serving the plugin's own routes. */
async function withServer(routes, run) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.get(`exact:${path}`)
    if (route === undefined) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    await route.handler(request, response)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const origin = `http://127.0.0.1:${port}`
  const originalFetch = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input.url
    const absolute = url.startsWith('http') ? url : `${origin}${url}`
    const request = new Request(absolute, init)
    // Node's fetch drops a loopback Origin when the request is same-origin, but
    // the panel always sends one from a real page; keep it explicit.
    const headers = new Headers(request.headers)
    if (init?.headers?.origin !== undefined) headers.set('origin', init.headers.origin)
    if (init?.headers?.origin === undefined && init?.method === 'POST') headers.set('origin', origin)
    return originalFetch(new Request(absolute, { method: request.method, headers, body: init?.body }))
  }
  try {
    return await run(origin)
  } finally {
    globalThis.fetch = originalFetch
    await new Promise((resolve) => server.close(resolve))
  }
}

/** A Host context that records the tool and routes, as the real Host does. */
function fakeHostContext(root) {
  const tools = new Map()
  const routes = new Map()
  const ctx = {
    logger: { warn: () => {} },
    get: () => undefined,
    effect: (callback) => {
      callback()
      return () => {}
    },
    systemPrompt: { section: () => () => {} },
    tools: { register: (definition) => tools.set(definition.name, definition) },
    webServer: {
      register: (route) => {
        routes.set(`${route.kind}:${route.path}`, route)
        return () => {}
      },
    },
  }
  void root
  return { ctx, tools, routes }
}

async function main() {
  const failures = []
  const check = async (name, fn) => {
    try {
      await fn()
      process.stdout.write(`  ok   ${name}\n`)
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
      process.stdout.write(`  FAIL ${name}\n         ${error.message}\n`)
    }
  }

  process.stdout.write('client half\n')

  const dom = installDomStub()
  const React = createReactStub()
  await import('../client.js')
  const entry = globalThis.__dshDrawioEntry
  await check('registers under the package id', async () => {
    assert.equal(entry.id, PKG_NAME)
    assert.equal(typeof entry.factory, 'function')
  })

  const exportsObject = entry.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require ${name}`)
  })
  const client = createClientContext(React)
  exportsObject.apply(client.ctx)

  await check('registers zh and en dictionaries', async () => {
    assert.equal(client.dictionaries.length, 1)
    const { ns, dicts } = client.dictionaries[0]
    assert.equal(ns, PKG_NAME)
    assert.equal(typeof dicts.zh['panel.title'], 'string')
    assert.equal(typeof dicts.en['panel.title'], 'string')
    const zhKeys = Object.keys(dicts.zh).sort()
    const enKeys = Object.keys(dicts.en).sort()
    assert.deepEqual(zhKeys, enKeys, 'both locales must carry the same keys')
  })

  await check('registers a sidebar entry matching the panel key', async () => {
    const row = client.rows.get('drawio')
    assert.ok(row, 'expected a sidebar.panellist entry with id drawio')
    assert.equal(row.options.name, 'sidebar.panellist')
    assert.equal(typeof row.options.label, 'function')
    assert.equal(row.options.label(), '图表')
  })

  await check('registers the main panel under the same key', async () => {
    const panel = client.panels.get('drawio')
    assert.ok(panel, 'expected a main panel keyed drawio')
    assert.equal(typeof panel.component, 'function')
  })

  // Real Host routes, so the panel talks to the same code the tool uses.
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-drawio-client-'))
  const host = fakeHostContext(workspace)
  apply(host.ctx, { rootDir: workspace })
  const tool = host.tools.get('drawio')
  await tool.execute(
    {
      action: 'create',
      path: 'charts/login.drawio',
      title: '登录流程',
      nodes: [
        { id: 'a', label: '开始', role: 'start' },
        { id: 'b', label: '校验', shape: 'diamond' },
      ],
      edges: [{ from: 'a', to: 'b' }],
    },
    { signal: new AbortController().signal },
  )

  await withServer(host.routes, async () => {
    const panel = client.panels.get('drawio')
    // Undici clears a user-installed `document` global on first use; reinstall
    // the stub right before rendering so the panel's effects see it.
    installDomStub()
    // Render once: effects run, the list and the config are fetched.
    React.reset()
    panel.component({ t: client.ctx.locale.bind(PKG_NAME) })
    await new Promise((resolve) => setTimeout(resolve, 120))
    React.reset()
    const tree = panel.component({ t: client.ctx.locale.bind(PKG_NAME) })

    await check('renders the panel title and the file list', async () => {
      const text = textOf(tree)
      assert.match(text, /图表/u)
      assert.match(text, /login\.drawio/u)
      assert.ok(text.length > 0)
    })

    await check('renders the empty-stage hint before a file is picked', async () => {
      const text = textOf(tree)
      assert.match(text, /选一个文件开始/u)
    })

    await check('renders one list row per diagram file', async () => {
      const rows = collect(tree, 'button').filter((element) => element.props.className === 'dshdrawio_row')
      assert.equal(rows.length, 1)
      assert.match(textOf(rows[0]), /login\.drawio/u)
    })

    await check('the selected row highlights the file it opened', async () => {
      const row = collect(tree, 'button').find((element) => element.props.className === 'dshdrawio_row')
      // Clicking the row opens the file through the Host's /document route.
      row.props.onClick()
      await new Promise((resolve) => setTimeout(resolve, 120))
      React.reset()
      const after = panel.component({ t: client.ctx.locale.bind(PKG_NAME) })
      const activeRow = collect(after, 'button').find((element) => element.props.className === 'dshdrawio_row')
      assert.equal(activeRow.props['data-active'], 'true')
      // The toolbar appears only after a document is loaded.
      const toolbars = collect(after, 'div').filter((element) => element.props.className === 'dshdrawio_toolbar')
      assert.equal(toolbars.length, 1)
    })

    await check('the preview image points at the Host preview route', async () => {
      installDomStub()
      React.reset()
      const after = panel.component({ t: client.ctx.locale.bind(PKG_NAME) })
      const images = collect(after, 'img')
      assert.equal(images.length, 1)
      assert.match(images[0].props.src, new RegExp(`^${ROUTE_PREFIX}/preview[?]path=`, 'u'))
      assert.match(decodeURIComponent(images[0].props.src), /charts\/login\.drawio/u)
    })

    await check('opening the editor mounts an iframe with the embed protocol', async () => {
      installDomStub()
      React.reset()
      const after = panel.component({ t: client.ctx.locale.bind(PKG_NAME) })
      const openButton = collect(after, 'button').find((element) => textOf(element).length > 0 && element.props.className === 'dshdrawio_btn')
      const labelled = collect(after, 'button').filter((element) => element.props.className === 'dshdrawio_btn')
      // The first btn in the toolbar toggles the editor; fall back to a scan.
      const toggles = labelled.filter((element) => textOf(element) === '在 draw.io 中打开')
      assert.equal(toggles.length, 1, `expected an editor toggle, saw ${labelled.map(textOf).join(' | ')}`)
      toggles[0].props.onClick()
      React.reset()
      const mounted = panel.component({ t: client.ctx.locale.bind(PKG_NAME) })
      const frames = collect(mounted, 'iframe')
      assert.equal(frames.length, 1)
      assert.match(frames[0].props.src, /^https:\/\/embed\.diagrams\.net\/\?/u)
      assert.match(frames[0].props.src, /embed=1/u)
      assert.match(frames[0].props.src, /proto=json/u)
      void openButton
    })

    await check('the draw.io message protocol loads and captures a save', async () => {
      // Drive the editor component the way draw.io does: post `init` from the
      // frame's origin, expect a `load`, then post autosave/save and confirm the
      // panel treats each as a draft.
      const panelEntry = client.panels.get('drawio')
      // Open a file and switch the editor on so the panel's tree contains it.
      const renderSettled = async () => {
        installDomStub()
        React.reset()
        panelEntry.component({ t: client.ctx.locale.bind(PKG_NAME) })
        await new Promise((resolve) => setTimeout(resolve, 150))
        React.reset()
        return panelEntry.component({ t: client.ctx.locale.bind(PKG_NAME) })
      }
      const listing = await renderSettled()
      const fileRow = collect(listing, 'button').find((element) => element.props.className === 'dshdrawio_row')
      assert.ok(fileRow !== undefined, 'expected a file row')
      fileRow.props.onClick()
      await new Promise((resolve) => setTimeout(resolve, 150))
      let panel = await renderSettled()
      if (collect(panel, 'iframe').length === 0) {
        const openToggle = collect(panel, 'button').find(
          (element) => element.props.className === 'dshdrawio_btn' && textOf(element) === '在 draw.io 中打开',
        )
        assert.ok(openToggle !== undefined, 'expected the editor toggle')
        openToggle.props.onClick()
        panel = await renderSettled()
      }
      const editorComponent = findComponent(panel, 'DrawioEditor')
      assert.ok(editorComponent !== undefined, 'the panel must render the editor component')

      const posted = []
      const fakeWindow = { postMessage: (data, origin) => posted.push({ message: JSON.parse(data), origin }) }
      const frameRef = { current: { contentWindow: fakeWindow } }
      const editorProps = {
        embedOrigin: 'https://embed.diagrams.net',
        xml: '<mxfile><diagram id="p" name="P"/></mxfile>',
        title: 'chart.drawio',
        dark: false,
        t: (key) => key,
        onDirty: () => {},
        onError: () => {},
      }

      // First pass renders the iframe; the ref is attached before the effect runs.
      React.resetAll()
      React.reset()
      React.firstRef(frameRef)
      const listenersBefore = listeners.length
      const editorTree = editorComponent(editorProps)
      const [iframe] = collect(editorTree, 'iframe')
      assert.ok(iframe !== undefined, 'the editor must render an iframe')
      assert.match(iframe.props.src, /^https:\/\/embed\.diagrams\.net\//u)
      assert.match(iframe.props.src, /embed=1/u)
      assert.match(iframe.props.src, /proto=json/u)
      assert.equal(iframe.props.referrerPolicy, 'no-referrer')

      const listener = listeners.slice(listenersBefore).at(-1)
      assert.ok(listener !== undefined, 'the editor must listen for messages')
      const source = fakeWindow

      // A foreign origin is ignored.
      listener.handler({ origin: 'https://evil.example', source, data: JSON.stringify({ event: 'init' }) })
      assert.equal(posted.length, 0, 'foreign origins must be ignored')

      // A foreign frame on the right origin is ignored.
      listener.handler({ origin: 'https://embed.diagrams.net', source: { other: true }, data: JSON.stringify({ event: 'init' }) })
      assert.equal(posted.length, 0, 'foreign frames must be ignored')

      // The real `init` answers with a load action carrying the document.
      listener.handler({ origin: 'https://embed.diagrams.net', source, data: JSON.stringify({ event: 'init' }) })
      assert.equal(posted.length, 1)
      assert.equal(posted[0].origin, 'https://embed.diagrams.net')
      assert.equal(posted[0].message.action, 'load')
      assert.equal(posted[0].message.autosave, 1)
      assert.match(posted[0].message.xml, /<mxfile/u)

      // A non-JSON payload is ignored rather than thrown.
      listener.handler({ origin: 'https://embed.diagrams.net', source, data: 'ready' })
      assert.equal(posted.length, 1)

      // `autosave` and `save` both surface a draft; other events do not.
      const drafts = []
      React.resetAll()
      React.reset()
      React.firstRef({ current: { contentWindow: fakeWindow } })
      const beforeDrafts = listeners.length
      editorComponent({ ...editorProps, onDirty: (xml) => drafts.push(xml) })
      const draftListener = listeners.slice(beforeDrafts).at(-1)
      assert.ok(draftListener !== undefined)
      draftListener.handler({
        origin: 'https://embed.diagrams.net',
        source: fakeWindow,
        data: JSON.stringify({ event: 'autosave', xml: '<mxfile><diagram id="p" name="P"/></mxfile>' }),
      })
      draftListener.handler({
        origin: 'https://embed.diagrams.net',
        source: fakeWindow,
        data: JSON.stringify({ event: 'save', xml: '<mxfile><diagram id="p" name="P"/></mxfile>' }),
      })
      draftListener.handler({
        origin: 'https://embed.diagrams.net',
        source: fakeWindow,
        data: JSON.stringify({ event: 'load' }),
      })
      assert.equal(drafts.length, 2, 'autosave and save must each surface a draft')
    })
  })

  await check('registers the chat toolview and the right-sidebar tab', async () => {
    installDomStub()
    React.resetAll()
    React.reset()
    const entry = globalThis.__dshDrawioEntry
    const exportsObject = entry.factory((name) => {
      if (name === 'react') return React
      throw new Error(`unexpected require ${name}`)
    })
    const fresh = createClientContext(React)
    exportsObject.apply(fresh.ctx)

    // toolview: keyed by the tool name
    const toolview = fresh.toolviews.get('drawio')
    assert.ok(toolview !== undefined, 'expected a tool.call.toolview entry keyed drawio')
    assert.equal(toolview.options.name, 'tool.call.toolview')

    // right pane: registered as a tab
    const pane = fresh.rightTabs.get('drawio-preview')
    assert.ok(pane !== undefined, 'expected a sidebar.right.pane.tab entry')
  })

  await rm(workspace, { recursive: true, force: true })
  void dom
  void exportsObject

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} failure(s)\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write('\nall client checks passed\n')
}

await main()
