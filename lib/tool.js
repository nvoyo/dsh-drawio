/**
 * The `drawio` model tool.
 *
 * One tool with an `action` disc, because every action edits the same kind of
 * file and the model should not have to remember four names: create a diagram
 * from a node/edge description, edit the page it just made, read it back as
 * structured data, or export an image.
 *
 * The tool returns compact structured facts (ids, counts, warnings) instead of
 * echo pages, and it is the only writer that reports what it changed. Nothing
 * here talks to a network service: diagrams are files in the workspace.
 *
 * @module @sorarisu/dsh-drawio/lib/tool
 */
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { addCells, removeCells, updateCells } from './edit.js'
import { buildDiagram, PALETTES, SHAPES } from './drawio-build.js'
import { describeDiagram } from './drawio-model.js'
import { summarizeDiagram } from './drawio-xml.js'
import { renderSvg } from './drawio-svg.js'
import { PathPolicyError } from './paths.js'
import { pageTitleFor } from './store.js'

/** Shape names offered to the model, so the schema stays a closed enum. */
const SHAPE_NAMES = Object.keys(SHAPES)

/** The tool's own name, shared with the client so both halves agree. */
export const TOOL_NAME = 'drawio'

/** One node description, as both the schema and the builder understand it. */
const NODE_PROPERTIES = {
  id: {
    type: 'string',
    description: 'Stable reference used by edges and later edits. Defaults to the label, then to n1, n2, …',
  },
  label: { type: 'string', description: 'Display text. Line breaks are preserved.' },
  shape: {
    type: 'string',
    enum: SHAPE_NAMES,
    description: `One of: ${SHAPE_NAMES.join(', ')}. Defaults to rect.`,
  },
  role: {
    type: 'string',
    enum: ['start', 'end', 'process'],
    description: 'Semantic role that picks the palette colour. start/end are drawn green/red.',
  },
  level: { type: 'number', description: 'Force this node onto a row; otherwise the row follows its longest predecessor chain.' },
  width: { type: 'number', description: 'Box width in px. Defaults to 140.' },
  height: { type: 'number', description: 'Box height in px. Defaults to 56.' },
  fill: { type: 'string', description: 'Explicit fill colour, e.g. #dae8fc. Overrides the palette.' },
  stroke: { type: 'string', description: 'Explicit stroke colour. Overrides the palette.' },
  color: { type: 'string', description: 'Explicit label colour. Overrides the palette.' },
  bold: { type: 'boolean', description: 'Bold label.' },
  dashed: { type: 'boolean', description: 'Dashed border.' },
}

/** One edge description. */
const EDGE_PROPERTIES = {
  from: { type: 'string', description: 'Source node id or reference.' },
  to: { type: 'string', description: 'Target node id or reference.' },
  label: { type: 'string', description: 'Text on the edge, such as 是 / 否.' },
  dashed: { type: 'boolean', description: 'Dashed line.' },
  dotted: { type: 'boolean', description: 'Dotted line.' },
  color: { type: 'string', description: 'Line colour.' },
}

/** The canonical result value every action returns. */
const OUTPUT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['action', 'path', 'absolutePath', 'created', 'nodes', 'edges', 'pageName'],
  properties: {
    action: { type: 'string' },
    path: { type: 'string', description: 'Workspace-relative path of the touched file.' },
    absolutePath: { type: 'string' },
    created: { type: 'boolean' },
    nodes: { type: 'integer' },
    edges: { type: 'integer' },
    pageName: { type: 'string' },
    exportedPath: { type: 'string', description: 'SVG file written, when the action exported one.' },
    warnings: { type: 'array', items: { type: 'string' } },
    removed: { type: 'array', items: { type: 'string' } },
    missing: { type: 'array', items: { type: 'string' } },
    files: {
      type: 'array',
      description: 'list only: the diagram files found.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path'],
        properties: {
          path: { type: 'string' },
          bytes: { type: 'integer' },
          modifiedAt: { type: 'string' },
        },
      },
    },
    nodeList: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string' },
          label: { type: 'string' },
          shape: { type: 'string' },
          in: { type: 'integer' },
          out: { type: 'integer' },
        },
      },
    },
    edgeList: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          label: { type: 'string' },
        },
      },
    },
    truncatedNodes: { type: 'integer' },
    truncatedEdges: { type: 'integer' },
  },
}

/** Model-facing summary lines for one result. */
function renderToolResult(value) {
  const where = value.exportedPath === undefined ? value.path : `${value.path} (+ ${value.exportedPath})`
  const lines = [`${value.action} → ${where}`, `页面 ${value.pageName}：${value.nodes} 个节点，${value.edges} 条连线`]
  if (value.nodeList !== undefined && value.nodeList.length > 0) {
    const listed = value.nodeList
      .slice(0, 24)
      .map((node) => {
        const degree = node.in === undefined && node.out === undefined ? '' : ` (${node.in ?? 0} in / ${node.out ?? 0} out)`
        return `- ${node.id}: ${node.label ?? ''}${degree}`
      })
    lines.push('节点：', ...listed)
    if ((value.truncatedNodes ?? 0) > 0) lines.push(`…还有 ${value.truncatedNodes} 个节点未列出`)
  }
  if (value.edgeList !== undefined && value.edgeList.length > 0) {
    const listed = value.edgeList.slice(0, 32).map((edge) => `- ${edge.from} → ${edge.to}${edge.label === undefined ? '' : ` [${edge.label}]`}`)
    lines.push('连线：', ...listed)
    if ((value.truncatedEdges ?? 0) > 0) lines.push(`…还有 ${value.truncatedEdges} 条连线未列出`)
  }
  if ((value.files ?? []).length > 0) {
    lines.push('文件：', ...value.files.slice(0, 40).map((file) => `- ${file.path} (${file.bytes} B)`))
  }
  if ((value.removed ?? []).length > 0) lines.push(`已删除：${value.removed.join(', ')}`)
  if ((value.missing ?? []).length > 0) lines.push(`未找到：${value.missing.join(', ')}`)
  if ((value.warnings ?? []).length > 0) lines.push('注意：', ...value.warnings.map((warning) => `- ${warning}`))
  return lines.join('\n')
}

/**
 * Validate one value against the small JSON Schema subset this tool declares.
 *
 * The registry validates arguments only for `defineTool`, and this plugin
 * deliberately imports no Harness package (a profile bundle must load even when
 * a composition does not expose one), so the tool checks its own input before
 * touching a file.
 *
 * @param {unknown} value - the model-supplied value.
 * @param {Record<string, any>} schema - a node of the declared schema.
 * @param {string} path - dotted path used in the violation message.
 * @param {string[]} violations - collected reasons, in walk order.
 */
function validateValue(value, schema, path, violations) {
  if (schema === undefined) return
  const type = schema.type
  if (type === 'string' && typeof value !== 'string') violations.push(`${path || 'arguments'} 应为字符串`)
  if (type === 'number' && (typeof value !== 'number' || !Number.isFinite(value))) violations.push(`${path || 'arguments'} 应为数字`)
  if (type === 'integer' && !Number.isInteger(value)) violations.push(`${path || 'arguments'} 应为整数`)
  if (type === 'boolean' && typeof value !== 'boolean') violations.push(`${path || 'arguments'} 应为布尔值`)
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) {
    violations.push(`${path || 'arguments'} 只能是 ${schema.enum.map((item) => JSON.stringify(item)).join(', ')}`)
  }
  if (type === 'array') {
    if (!Array.isArray(value)) {
      violations.push(`${path || 'arguments'} 应为数组`)
      return
    }
    for (const [index, item] of value.entries()) validateValue(item, schema.items, `${path}[${index}]`, violations)
    return
  }
  if (type === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      violations.push(`${path || 'arguments'} 应为对象`)
      return
    }
    const properties = schema.properties ?? {}
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(value, key)) violations.push(`缺少必填参数 ${path ? `${path}.` : ''}${key}`)
    }
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateValue(item, properties[key], path ? `${path}.${key}` : key, violations)
        continue
      }
      if (schema.additionalProperties === false) violations.push(`未知参数 ${path ? `${path}.` : ''}${key}`)
    }
    return
  }
  // `additionalProperties: true` free-form map: values are caller-owned strings.
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return
}

/** Throw one readable error listing every argument violation. */
function assertArguments(args, schema) {
  const violations = []
  validateValue(args, schema, '', violations)
  if (violations.length > 0) throw new Error(`drawio 参数不合法：${violations.join('；')}`)
}

/** Argument validation beyond the declared schema, with user-facing reasons. */
function checkArguments(args) {
  const action = args.action
  if (!['create', 'edit', 'read', 'export', 'delete', 'list'].includes(action)) {
    throw new Error(`未知 action "${action}"；可用：create / edit / read / export / delete / list。`)
  }
  if ((action === 'create' || action === 'edit' || action === 'export' || action === 'delete') && typeof args.path !== 'string') {
    throw new Error(`action "${action}" 需要 path。`)
  }
  if (action === 'create' && args.nodes === undefined && args.xml === undefined) {
    throw new Error('create 需要 nodes（节点列表），或直接给出 xml。')
  }
  if (action === 'edit' && args.add === undefined && args.update === undefined && args.remove === undefined) {
    throw new Error('edit 需要 add、update、remove 中至少一项；要整体替换请用 create。')
  }
}

/** The tool's parameter schema: object-rooted so the registry and this file agree. */
const PARAMETERS = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: ['create', 'edit', 'read', 'export', 'delete', 'list'],
      description:
        'What to do. create = write a new diagram; edit = modify cells in place; read = structured listing; export = SVG copy; delete = remove the file; list = find diagrams.',
    },
    path: {
      type: 'string',
      description:
        'Diagram file path, absolute or relative to the workspace root. Required for create/edit/read/export/delete.',
    },
    directory: { type: 'string', description: 'list only: directory to scan. Defaults to the workspace root.' },
    recursive: {
      type: 'boolean',
      description: 'list only: descend into subdirectories (up to 3 levels). Defaults to true.',
    },
    title: { type: 'string', description: 'create only: page name. Defaults to the filename.' },
    palette: {
      type: 'string',
      enum: Object.keys(PALETTES),
      description: 'create only: colour palette. Defaults to default.',
    },
    nodes: {
      type: 'array',
      description: 'create only: the boxes to draw.',
      items: { type: 'object', additionalProperties: false, properties: NODE_PROPERTIES },
    },
    edges: {
      type: 'array',
      description: 'create only: the arrows between nodes. Each needs from and to.',
      items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: EDGE_PROPERTIES },
    },
    xml: {
      type: 'string',
      description: 'create only: full mxfile XML, used instead of nodes/edges when the model needs exact control.',
    },
    add: {
      type: 'object',
      additionalProperties: false,
      description: 'edit only: cells to append. New nodes are placed in a row below what is already drawn.',
      properties: {
        nodes: { type: 'array', items: { type: 'object', additionalProperties: false, properties: NODE_PROPERTIES } },
        edges: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['from', 'to'], properties: EDGE_PROPERTIES },
        },
      },
    },
    update: {
      type: 'array',
      description: 'edit only: change existing cells by id.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'Cell id from a previous read.' },
          label: { type: 'string', description: 'New label.' },
          style: {
            type: 'object',
            additionalProperties: true,
            description: 'Style keys to merge, e.g. {"fillColor":"#ffe6cc"}. An empty string removes a key.',
          },
          geometry: {
            type: 'object',
            additionalProperties: false,
            properties: {
              x: { type: 'number' },
              y: { type: 'number' },
              width: { type: 'number' },
              height: { type: 'number' },
            },
          },
        },
      },
    },
    remove: {
      type: 'array',
      items: { type: 'string' },
      description: 'edit only: cell ids to delete. Edges touching a deleted cell are removed too.',
    },
    format: {
      type: 'string',
      enum: ['svg'],
      description: 'export only: image format. Only svg is produced locally, without any network round trip.',
    },
    outputPath: {
      type: 'string',
      description: 'export only: where to write the SVG. Defaults to the diagram path with .svg.',
    },
  },
}

/**
 * Register the tool on one context.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - a context that provides `tools`.
 * @param {{ store: import('./store.js').DiagramStore, logger?: { warn: (message: string) => void } }} deps
 */
export function registerDrawioTool(ctx, deps) {
  const { store } = deps
  ctx.tools.register({
    name: TOOL_NAME,
    description: [
      'Create and edit draw.io (.drawio) diagrams in the workspace: flowcharts, process diagrams, org charts, UML-ish boxes, ER boxes.',
      'action=create writes a new diagram from nodes + edges; action=edit adds/updates/removes cells in an existing one;',
      'action=read returns its nodes and edges as structured data; action=export renders a standalone SVG file;',
      'action=delete removes the file; action=list finds diagrams in the workspace.',
      'The result is a .drawio file the user can open in the draw.io editor panel, so nothing is sent to any draw.io server.',
    ].join(' '),
    parameters: PARAMETERS,
    output: {
      schema: OUTPUT_VALUE_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
    },
    async execute(args, exec) {
      assertArguments(args, PARAMETERS)
      checkArguments(args)
      const signal = exec.signal
      switch (args.action) {
        case 'create':
          return createDiagram(store, args, signal)
        case 'edit':
          return editDiagram(store, args, signal)
        case 'read':
          return readDocument(store, args, signal)
        case 'export':
          return exportDiagram(store, args, signal)
        case 'delete': {
          const removed = await store.remove(args.path)
          return {
            action: 'delete',
            path: removed.path,
            absolutePath: removed.absolutePath,
            created: false,
            nodes: 0,
            edges: 0,
            pageName: '',
          }
        }
        case 'list': {
          // Recursive by default: diagrams usually live under docs/ or diagrams/,
          // and a list that silently misses them is worse than a slightly larger one.
          const directory = store.resolve(args.directory ?? store.baseDir, { mustBeDiagram: false })
          const rows = await store.list(directory, { recursive: args.recursive !== false })
          return {
            action: 'list',
            path: store.display(directory),
            absolutePath: directory,
            created: false,
            nodes: rows.length,
            edges: 0,
            pageName: '',
            files: rows.map((row) => ({ path: row.path, bytes: row.bytes, modifiedAt: row.modifiedAt })),
            warnings: rows.length === 0 ? ['该目录下没有 .drawio 文件。'] : undefined,
          }
        }
        default:
          throw new Error(`unreachable action ${String(args.action)}`)
      }
    },
  })
}

/** `create`: build a document and write it. */
async function createDiagram(store, args, signal) {
  signal.throwIfAborted()
  const absolute = store.resolve(args.path)
  const title = typeof args.title === 'string' && args.title.length > 0 ? args.title : pageTitleFor(absolute)
  let xml
  let warnings = []
  if (typeof args.xml === 'string' && args.xml.trim().length > 0) {
    xml = args.xml
  } else {
    const built = buildDiagram({ nodes: args.nodes ?? [], edges: args.edges ?? [] }, { title, palette: args.palette })
    xml = built.xml
    warnings = built.warnings
  }
  signal.throwIfAborted()
  const written = await store.write(args.path, xml)
  return {
    action: 'create',
    path: written.path,
    absolutePath: written.absolutePath,
    created: written.created,
    nodes: written.summary.cells === 0 ? 0 : countNodes(written.summary, xml),
    edges: countEdges(xml),
    pageName: written.summary.pageName,
    warnings: warnings.length > 0 ? warnings : undefined,
  }
}

/** `edit`: apply the described additions, updates, and removals. */
async function editDiagram(store, args, signal) {
  signal.throwIfAborted()
  const current = await store.read(args.path)
  let xml = current.xml
  const warnings = []
  const removed = []
  const missing = []
  if (Array.isArray(args.remove) && args.remove.length > 0) {
    const result = removeCells(xml, args.remove)
    xml = result.xml
    removed.push(...result.removed, ...result.removedEdges.map((id) => `${id} (edge)`))
    missing.push(...result.missing)
  }
  if (args.add !== undefined) {
    const result = addCells(xml, { nodes: args.add.nodes ?? [], edges: args.add.edges ?? [] })
    xml = result.xml
    warnings.push(...result.warnings)
  }
  if (Array.isArray(args.update) && args.update.length > 0) {
    const result = updateCells(xml, args.update)
    xml = result.xml
    missing.push(...result.missing)
  }
  signal.throwIfAborted()
  const written = await store.write(args.path, xml)
  return {
    action: 'edit',
    path: written.path,
    absolutePath: written.absolutePath,
    created: false,
    nodes: countNodes(written.summary, xml),
    edges: countEdges(xml),
    pageName: written.summary.pageName,
    warnings: warnings.length > 0 ? warnings : undefined,
    removed: removed.length > 0 ? removed : undefined,
    missing: missing.length > 0 ? unique(missing) : undefined,
  }
}

/** `read`: structured nodes and edges. */
async function readDocument(store, args, signal) {
  signal.throwIfAborted()
  const document = await store.read(args.path)
  const described = describeDiagram(document.xml)
  return {
    action: 'read',
    path: document.path,
    absolutePath: document.absolutePath,
    created: false,
    nodes: described.nodes,
    edges: described.edges,
    pageName: document.summary.pageName,
    nodeList: described.nodeList,
    edgeList: described.edgeList,
    truncatedNodes: described.truncatedNodes > 0 ? described.truncatedNodes : undefined,
    truncatedEdges: described.truncatedEdges > 0 ? described.truncatedEdges : undefined,
  }
}

/** `export`: render a local SVG next to the diagram. */
async function exportDiagram(store, args, signal) {
  signal.throwIfAborted()
  const document = await store.read(args.path)
  const target = typeof args.outputPath === 'string' && args.outputPath.length > 0
    ? store.resolve(args.outputPath, { mustBeDiagram: false })
    : document.absolutePath.replace(/\.drawio$/iu, '.svg')
  if (target === document.absolutePath) {
    throw new PathPolicyError('导出路径不能覆盖源 .drawio 文件。', 'unresolvable')
  }
  const svg = renderSvg(document.xml, { title: document.summary.pageName, background: '#ffffff' })
  signal.throwIfAborted()
  await writeFile(target, svg, 'utf8')
  return {
    action: 'export',
    path: document.path,
    absolutePath: document.absolutePath,
    created: false,
    nodes: document.summary.cells,
    edges: countEdges(document.xml),
    pageName: document.summary.pageName,
    exportedPath: store.display(target),
  }
}

/** Node count of a document. */
function countNodes(summary, xml) {
  const described = describeDiagram(xml)
  return described.nodes > 0 ? described.nodes : summary.cells
}

/** Edge count of a document. */
function countEdges(xml) {
  return describeDiagram(xml).edges
}

/** Deduplicate while keeping the first occurrence. */
function unique(values) {
  return [...new Set(values)]
}

/** Re-export for the host half's own use. */
export { summarizeDiagram, basename }
