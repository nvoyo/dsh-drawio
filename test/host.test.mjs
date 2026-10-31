/**
 * Host-half verification without installing the bundle.
 *
 * The plugin only knows a Cordis context: `tools.register`, `webServer.register`,
 * `effect`, `get`, `logger`, and `systemPrompt.section`. This harness supplies
 * exactly those, runs `apply()`, then drives the registered tool and the
 * registered routes the way the Harness and the browser would.
 *
 * Run with: node test/host.test.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply, ROUTE_PREFIX, normalizeConfig } from '../index.js'

/** A Cordis-shaped context that records what the plugin registers. */
function fakeContext() {
  const tools = new Map()
  const routes = new Map()
  const effects = []
  const sections = []
  let roots = []
  const ctx = {
    logger: {
      warn: (message) => process.stderr.write(`[warn] ${message}\n`),
    },
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => roots.map((path) => ({ path })),
          on: () => () => {},
        }
      }
      return undefined
    },
    effect(callback) {
      const dispose = callback()
      effects.push(dispose)
      return dispose
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => {}
      },
    },
    tools: {
      register(definition) {
        tools.set(definition.name, definition)
        return () => tools.delete(definition.name)
      },
    },
    webServer: {
      register(route) {
        assert.equal(typeof route.handler, 'function', 'route handler must be a function')
        const key = `${route.kind}:${route.path}`
        assert.equal(routes.has(key), false, `duplicate route ${key}`)
        routes.set(key, route)
        return () => routes.delete(key)
      },
    },
  }
  return {
    ctx,
    tools,
    routes,
    effects,
    sections,
    setRoots(next) {
      roots = next
    },
  }
}

/** Invoke one tool call the way the registry does: validate, then execute. */
async function callTool(definition, args) {
  const controller = new AbortController()
  const value = await definition.execute(args, { signal: controller.signal, arguments: args })
  return value
}

/** Serve the registered routes on a real socket, so response handling is exercised. */
async function withRoutes(routes, run) {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? '/', 'http://127.0.0.1').pathname
    const route = routes.get(`exact:${path}`)
    if (route === undefined) {
      response.writeHead(404)
      response.end('not found')
      return
    }
    try {
      await route.handler(request, response)
    } catch (error) {
      response.writeHead(500)
      response.end(String(error))
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const origin = `http://127.0.0.1:${port}`
  try {
    return await run(origin)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

/** One GET returning parsed JSON. */
async function getJson(url) {
  const response = await fetch(url)
  const text = await response.text()
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : {} }
}

/** A same-origin POST, as the panel sends it. */
async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: new URL(url).origin },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : {} }
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-drawio-test-'))
  const outside = await mkdtemp(join(tmpdir(), 'dsh-drawio-outside-'))
  const harness = fakeContext()
  harness.setRoots([workspace])

  const teardown = apply(harness.ctx, { rootDir: workspace, maxDocumentBytes: 4 * 1024 * 1024 })
  const failures = []
  const check = (name, fn) => {
    try {
      fn()
      process.stdout.write(`  ok   ${name}\n`)
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
      process.stdout.write(`  FAIL ${name}\n         ${error.message}\n`)
    }
  }
  const checkAsync = async (name, fn) => {
    try {
      await fn()
      process.stdout.write(`  ok   ${name}\n`)
    } catch (error) {
      failures.push(`${name}: ${error.message}`)
      process.stdout.write(`  FAIL ${name}\n         ${error.message}\n`)
    }
  }

  process.stdout.write('host half\n')

  check('registers the drawio tool', () => {
    assert.equal(harness.tools.has('drawio'), true)
  })
  check('registers five routes under the plugin prefix', () => {
    const paths = [...harness.routes.keys()].filter((key) => key.startsWith('exact:'))
    assert.deepEqual(
      paths.map((key) => key.slice('exact:'.length)).sort(),
      [`${ROUTE_PREFIX}/config`, `${ROUTE_PREFIX}/document`, `${ROUTE_PREFIX}/list`, `${ROUTE_PREFIX}/preview`, `${ROUTE_PREFIX}/save`],
    )
  })
  check('adds one system-prompt section', () => {
    assert.equal(harness.sections.length, 1)
    assert.match(harness.sections[0].text, /drawio/u)
  })
  check('rejects a non-positive config value safely', () => {
    const config = normalizeConfig({ maxDocumentBytes: 'nope' })
    assert.equal(config.maxDocumentBytes, 8 * 1024 * 1024)
  })

  const tool = harness.tools.get('drawio')

  await checkAsync('create writes a flowchart file', async () => {
    const value = await callTool(tool, {
      action: 'create',
      path: 'docs/flow.drawio',
      title: '登录流程',
      nodes: [
        { id: 'start', label: '开始', role: 'start', shape: 'ellipse' },
        { id: 'check', label: '密码正确？', shape: 'diamond' },
        { id: 'ok', label: '进入首页' },
        { id: 'bad', label: '提示错误' },
        { id: 'end', label: '结束', role: 'end', shape: 'ellipse' },
      ],
      edges: [
        { from: 'start', to: 'check' },
        { from: 'check', to: 'ok', label: '是' },
        { from: 'check', to: 'bad', label: '否' },
        { from: 'ok', to: 'end' },
        { from: 'bad', to: 'end' },
      ],
    })
    assert.equal(value.action, 'create')
    assert.equal(value.created, true)
    assert.equal(value.nodes, 5)
    assert.equal(value.edges, 5)
    assert.equal(value.pageName, '登录流程')
    assert.equal(value.path, 'docs/flow.drawio')
    const text = await readFile(join(workspace, 'docs/flow.drawio'), 'utf8')
    assert.match(text, /<mxfile/u)
    assert.match(text, /value="密码正确？"/u)
  })

  await checkAsync('read returns structured nodes and edges', async () => {
    const value = await callTool(tool, { action: 'read', path: 'docs/flow.drawio' })
    assert.equal(value.nodes, 5)
    assert.equal(value.edges, 5)
    assert.equal(value.nodeList.length, 5)
    const check = value.nodeList.find((node) => node.id === 'check')
    assert.equal(check.shape, 'rhombus')
    assert.equal(check.out, 2)
    const start = value.nodeList.find((node) => node.id === 'start')
    assert.equal(start.in, 0)
    assert.equal(start.out, 1)
  })

  await checkAsync('edit adds, updates, and removes cells', async () => {
    const added = await callTool(tool, {
      action: 'edit',
      path: 'docs/flow.drawio',
      add: {
        nodes: [{ id: 'retry', label: '重试' }],
        edges: [{ from: 'bad', to: 'retry', label: '重试' }],
      },
    })
    assert.equal(added.warnings, undefined)
    assert.equal(added.nodes, 6)
    assert.equal(added.edges, 6)

    const updated = await callTool(tool, {
      action: 'edit',
      path: 'docs/flow.drawio',
      update: [{ id: 'retry', label: '重新输入', style: { fillColor: '#ffe6cc' } }],
    })
    assert.equal(updated.missing, undefined)

    const removed = await callTool(tool, {
      action: 'edit',
      path: 'docs/flow.drawio',
      remove: ['retry'],
    })
    // The appended edge's id depends on what the page already used, so assert
    // the shape (the node plus exactly one edge) rather than a literal id.
    assert.equal(removed.removed.filter((id) => id.endsWith('(edge)')).length, 1)
    assert.ok(removed.removed.includes('retry'))
    const final = await callTool(tool, { action: 'read', path: 'docs/flow.drawio' })
    assert.equal(final.nodes, 5)
    assert.equal(final.edges, 5)
  })

  await checkAsync('edit reports a missing id instead of failing', async () => {
    const value = await callTool(tool, {
      action: 'edit',
      path: 'docs/flow.drawio',
      update: [{ id: 'ghost', label: '不存在' }],
    })
    assert.deepEqual(value.missing, ['ghost'])
  })

  await checkAsync('export writes an SVG beside the diagram', async () => {
    const value = await callTool(tool, { action: 'export', path: 'docs/flow.drawio' })
    assert.equal(value.exportedPath, 'docs/flow.svg')
    const svg = await readFile(join(workspace, 'docs/flow.svg'), 'utf8')
    assert.match(svg, /^<svg/u)
    assert.match(svg, /密码正确？/u)
    assert.match(svg, /<polyline/u)
  })

  await checkAsync('list finds diagram files recursively', async () => {
    const value = await callTool(tool, { action: 'list' })
    assert.ok(value.nodes >= 1, 'expected at least one file')
    assert.ok(
      (value.files ?? []).some((file) => file.path === 'docs/flow.drawio'),
      `expected docs/flow.drawio in ${JSON.stringify(value.files)}`,
    )
  })

  await checkAsync('refuses a path outside every workspace', async () => {
    await assert.rejects(
      () => callTool(tool, { action: 'create', path: join(outside, 'escape.drawio'), nodes: [{ label: 'x' }] }),
      (error) => error.code === 'outside-workspace',
    )
  })

  await checkAsync('refuses a non-diagram extension', async () => {
    await assert.rejects(
      () => callTool(tool, { action: 'create', path: 'notes.md', nodes: [{ label: 'x' }] }),
      (error) => error.code === 'not-a-diagram',
    )
  })

  await checkAsync('refuses an action without its required argument', async () => {
    await assert.rejects(() => callTool(tool, { action: 'create', path: 'x.drawio' }), /nodes/u)
    await assert.rejects(() => callTool(tool, { action: 'edit', path: 'docs/flow.drawio' }), /add/u)
  })

  await checkAsync('delete removes the file', async () => {
    await callTool(tool, { action: 'create', path: 'tmp/one.drawio', nodes: [{ label: '临时' }] })
    const value = await callTool(tool, { action: 'delete', path: 'tmp/one.drawio' })
    assert.equal(value.action, 'delete')
    const listed = await callTool(tool, { action: 'list', directory: 'tmp' })
    assert.equal(listed.nodes, 0)
  })

  process.stdout.write('routes\n')

  await withRoutes(harness.routes, async (origin) => {
    await checkAsync('config reports the roots and editor origin', async () => {
      const { status, body } = await getJson(`${origin}${ROUTE_PREFIX}/config`)
      assert.equal(status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.embedOrigin, 'https://embed.diagrams.net')
      assert.ok(Array.isArray(body.roots) && body.roots.includes(workspace))
    })

    await checkAsync('list returns the workspace diagrams', async () => {
      const { status, body } = await getJson(`${origin}${ROUTE_PREFIX}/list?recursive=1`)
      assert.equal(status, 200)
      assert.ok(body.files.some((file) => file.path === 'docs/flow.drawio'))
    })

    await checkAsync('document returns xml and its summary', async () => {
      const { status, body } = await getJson(`${origin}${ROUTE_PREFIX}/document?path=${encodeURIComponent('docs/flow.drawio')}`)
      assert.equal(status, 200)
      assert.match(body.xml, /<mxfile/u)
      assert.equal(body.summary.pageName, '登录流程')
    })

    await checkAsync('preview serves SVG with the image content type', async () => {
      const response = await fetch(`${origin}${ROUTE_PREFIX}/preview?path=${encodeURIComponent('docs/flow.drawio')}`)
      assert.equal(response.status, 200)
      assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/u)
      const svg = await response.text()
      assert.match(svg, /^<svg/u)
    })

    await checkAsync('save writes what the editor posts back', async () => {
      const document = await getJson(`${origin}${ROUTE_PREFIX}/document?path=${encodeURIComponent('docs/flow.drawio')}`)
      const edited = document.body.xml.replace('进入首页', '进入工作台')
      const { status, body } = await postJson(`${origin}${ROUTE_PREFIX}/save`, { path: 'docs/flow.drawio', xml: edited })
      assert.equal(status, 200)
      assert.equal(body.ok, true)
      assert.equal(body.summary.pageName, '登录流程')
      const reread = await callTool(tool, { action: 'read', path: 'docs/flow.drawio' })
      assert.ok(reread.nodeList.some((node) => node.label === '进入工作台'))
    })

    await checkAsync('save refuses a path outside the workspace', async () => {
      const { status, body } = await postJson(`${origin}${ROUTE_PREFIX}/save`, {
        path: join(outside, 'nope.drawio'),
        xml: '<mxfile/>',
      })
      assert.equal(status, 403)
      assert.equal(body.ok, false)
    })

    await checkAsync('save requires the same-origin signal', async () => {
      const response = await fetch(`${origin}${ROUTE_PREFIX}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify({ path: 'docs/x.drawio', xml: '<mxfile/>' }),
      })
      assert.equal(response.status, 403)
      await response.text()
    })

    await checkAsync('document without a path is a 400', async () => {
      const { status } = await getJson(`${origin}${ROUTE_PREFIX}/document`)
      assert.equal(status, 400)
    })

    await checkAsync('unknown route is a 404', async () => {
      const response = await fetch(`${origin}${ROUTE_PREFIX}/nothing`)
      assert.equal(response.status, 404)
      await response.text()
    })
  })

  teardown()
  await rm(workspace, { recursive: true, force: true })
  await rm(outside, { recursive: true, force: true })

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} failure(s)\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write('\nall host checks passed\n')
}

await main()
