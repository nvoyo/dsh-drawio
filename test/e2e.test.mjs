/**
 * End-to-end: the flow a user and the model actually share.
 *
 * create with the tool → read it back → open it through the panel's routes →
 * edit in the panel (as the editor's save posts it) → edit with the tool again →
 * export an SVG → confirm the two writers never corrupt each other's work.
 *
 * Run with: node test/e2e.test.mjs
 */
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import assert from 'node:assert/strict'
import { apply, ROUTE_PREFIX } from '../index.js'

/** A Host context that records the tool and its routes. */
function hostContext(roots) {
  const tools = new Map()
  const routes = new Map()
  return {
    tools,
    routes,
    ctx: {
      logger: { warn: () => {} },
      get: (name) =>
        name === 'workspaceRegistry'
          ? { list: () => roots.map((path) => ({ path })), on: () => () => {} }
          : undefined,
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
    },
  }
}

/** Serve the recorded routes on a real socket. */
async function serve(routes, run) {
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
  try {
    return await run(origin)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function main() {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-drawio-e2e-'))
  const host = hostContext([workspace])
  apply(host.ctx, { rootDir: workspace })
  const tool = host.tools.get('drawio')
  const signal = new AbortController().signal
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

  process.stdout.write('end-to-end\n')

  await check('the model creates a diagram the user can open', async () => {
    const created = await tool.execute(
      {
        action: 'create',
        path: 'diagrams/pay.drawio',
        title: '支付流程',
        nodes: [
          { id: 'start', label: '下单', role: 'start', shape: 'ellipse' },
          { id: 'pay', label: '发起支付', shape: 'rect' },
          { id: 'check', label: '支付成功？', shape: 'diamond' },
          { id: 'done', label: '完成订单' },
          { id: 'fail', label: '提示重试' },
        ],
        edges: [
          { from: 'start', to: 'pay' },
          { from: 'pay', to: 'check' },
          { from: 'check', to: 'done', label: '是' },
          { from: 'check', to: 'fail', label: '否' },
        ],
      },
      { signal },
    )
    assert.equal(created.created, true)
    assert.equal(created.nodes, 5)
    assert.equal(created.edges, 4)
  })

  await serve(host.routes, async (origin) => {
    await check('the panel lists it and loads the same bytes the tool wrote', async () => {
      const listed = await (await fetch(`${origin}${ROUTE_PREFIX}/list?recursive=1`)).json()
      assert.ok(listed.files.some((file) => file.path === 'diagrams/pay.drawio'))
      const loaded = await (
        await fetch(`${origin}${ROUTE_PREFIX}/document?path=${encodeURIComponent('diagrams/pay.drawio')}`)
      ).json()
      const onDisk = await readFile(join(workspace, 'diagrams/pay.drawio'), 'utf8')
      assert.equal(loaded.xml, onDisk)
    })

    await check('a save from the editor is visible to the tool immediately', async () => {
      const loaded = await (
        await fetch(`${origin}${ROUTE_PREFIX}/document?path=${encodeURIComponent('diagrams/pay.drawio')}`)
      ).json()
      // Stand in for a human dragging a box and renaming it in draw.io.
      const edited = loaded.xml
        .replace('提示重试', '提示重试并保留订单')
        .replace(/<mxGeometry x="60" y="\d+" width="140"/u, '<mxGeometry x="420" y="300" width="140"')
      const response = await fetch(`${origin}${ROUTE_PREFIX}/save`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin },
        body: JSON.stringify({ path: 'diagrams/pay.drawio', xml: edited }),
      })
      assert.equal(response.status, 200)
      await response.text()

      const reread = await tool.execute({ action: 'read', path: 'diagrams/pay.drawio' }, { signal })
      assert.ok(
        reread.nodeList.some((node) => node.label === '提示重试并保留订单'),
        'the tool must see the editor\'s new label',
      )
      const moved = reread.nodeList.some((node) => node.id === 'fail')
      assert.equal(moved, true)
    })
  })

  await check("the tool then edits without discarding the editor's geometry", async () => {
    const before = await readFile(join(workspace, 'diagrams/pay.drawio'), 'utf8')
    // The editor moved `fail` to x=420; the tool must not rewrite other cells.
    assert.match(before, /x="420"/u)
    const edited = await tool.execute(
      {
        action: 'edit',
        path: 'diagrams/pay.drawio',
        add: { nodes: [{ id: 'refund', label: '退款' }], edges: [{ from: 'fail', to: 'refund' }] },
      },
      { signal },
    )
    assert.equal(edited.warnings, undefined)
    const after = await readFile(join(workspace, 'diagrams/pay.drawio'), 'utf8')
    assert.match(after, /x="420"/u, 'the moved cell must keep its coordinates')
    assert.match(after, /value="退款"/u)
    assert.match(after, /value="提示重试并保留订单"/u, "the editor's label must survive")
  })

  await check('export renders every label, including CJK', async () => {
    const exported = await tool.execute({ action: 'export', path: 'diagrams/pay.drawio' }, { signal })
    assert.equal(exported.exportedPath, 'diagrams/pay.svg')
    const svg = await readFile(join(workspace, 'diagrams/pay.svg'), 'utf8')
    for (const label of ['下单', '发起支付', '支付成功？', '完成订单', '提示重试并保留订单', '退款', '是', '否']) {
      assert.ok(svg.includes(label), `expected ${label} in the exported SVG`)
    }
  })

  await check('a hand-written legacy document still opens and previews', async () => {
    // draw.io's own files can be compressed; the plugin must accept one.
    const { deflateRawSync } = await import('node:zlib')
    const model =
      '<mxGraphModel pageWidth="400" pageHeight="300"><root><mxCell id="0"/><mxCell id="1" parent="0"/><mxCell id="n" value="旧文件" vertex="1" parent="1"><mxGeometry x="40" y="40" width="120" height="50" as="geometry"/></mxCell></root></mxGraphModel>'
    const compressed = deflateRawSync(Buffer.from(encodeURIComponent(model), 'utf8')).toString('base64')
    const document = `<mxfile host="app.diagrams.net"><diagram id="legacy" name="旧页">${compressed}</diagram></mxfile>`
    await writeFile(join(workspace, 'diagrams/legacy.drawio'), document, 'utf8')
    const read = await tool.execute({ action: 'read', path: 'diagrams/legacy.drawio' }, { signal })
    assert.equal(read.nodes, 1)
    assert.equal(read.pageName, '旧页')
    assert.equal(read.nodeList[0].label, '旧文件')

    await serve(host.routes, async (origin) => {
      const response = await fetch(`${origin}${ROUTE_PREFIX}/preview?path=${encodeURIComponent('diagrams/legacy.drawio')}`)
      assert.equal(response.status, 200)
      const svg = await response.text()
      assert.match(svg, /旧文件/u)
    })
  })

  await check('the tool refuses to write outside the workspace even mid-flow', async () => {
    await assert.rejects(
      () => tool.execute({ action: 'create', path: '/etc/dsh-drawio.drawio', nodes: [{ label: 'x' }] }, { signal }),
      (error) => error.code === 'outside-workspace',
    )
  })

  await rm(workspace, { recursive: true, force: true })

  if (failures.length > 0) {
    process.stdout.write(`\n${failures.length} failure(s)\n`)
    process.exitCode = 1
    return
  }
  process.stdout.write('\nend-to-end checks passed\n')
}

await main()
