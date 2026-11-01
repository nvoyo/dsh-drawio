/**
 * Build a draw.io document from a compact, model-friendly description.
 *
 * The model never hand-writes `mxGraphModel` XML. It describes nodes and edges,
 * this module owns ids, geometry, and the style strings, and the result is a
 * document that opens in draw.io's editor without repair work.
 *
 * Layout is layered top-down: every node's `level` (or its distance from an
 * entry node) selects a row, and nodes in one row are packed left-to-right.
 * That is enough for flowcharts, sequence-ish diagrams, and org trees, which is
 * what the tool is for; anything more precise belongs in the editor.
 *
 * @module @sorarisu/dsh-drawio/lib/drawio-build
 */
import { escapeXml, emptyGraphModel, GRAPH_MODEL_DEFAULTS } from './drawio-xml.js'

/** Named shapes the tool accepts, mapped onto draw.io style strings. */
export const SHAPES = {
  rect: 'rounded=0;whiteSpace=wrap;html=1;',
  rounded: 'rounded=1;whiteSpace=wrap;html=1;arcSize=12;',
  ellipse: 'ellipse;whiteSpace=wrap;html=1;',
  circle: 'ellipse;whiteSpace=wrap;html=1;aspect=fixed;',
  diamond: 'rhombus;whiteSpace=wrap;html=1;',
  rhombus: 'rhombus;whiteSpace=wrap;html=1;',
  decision: 'rhombus;whiteSpace=wrap;html=1;',
  parallelogram: 'shape=parallelogram;perimeter=parallelogramPerimeter;whiteSpace=wrap;html=1;fixedSize=1;',
  hexagon: 'shape=hexagon;perimeter=hexagonPerimeter2;whiteSpace=wrap;html=1;fixedSize=1;',
  cylinder: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;',
  document: 'shape=document;whiteSpace=wrap;html=1;boundedLbl=1;',
  cloud: 'ellipse;shape=cloud;whiteSpace=wrap;html=1;',
  note: 'shape=note;whiteSpace=wrap;html=1;backgroundOutline=1;darkOpacity=0.05;size=18;',
  actor: 'shape=umlActor;verticalLabelPosition=bottom;verticalAlign=top;html=1;',
  database: 'shape=cylinder3;whiteSpace=wrap;html=1;boundedLbl=1;backgroundOutline=1;size=15;',
  text: 'text;html=1;align=center;verticalAlign=middle;resizable=0;points=[];autosize=1;',
}

/** Named palettes, so a diagram is readable in both light and dark themes. */
export const PALETTES = {
  default: {
    fill: '#dae8fc',
    stroke: '#6c8ebf',
    font: '#1a1a1a',
    start: '#d5e8d4',
    startStroke: '#82b366',
    end: '#f8cecc',
    endStroke: '#b85450',
    decision: '#fff2cc',
    decisionStroke: '#d6b656',
  },
  mono: { fill: '#f5f5f5', stroke: '#666666', font: '#111111', start: '#ffffff', startStroke: '#333333', end: '#e6e6e6', endStroke: '#333333', decision: '#fafafa', decisionStroke: '#333333' },
  warm: { fill: '#ffe6cc', stroke: '#d79b00', font: '#2b1a0a', start: '#d5e8d4', startStroke: '#82b366', end: '#f8cecc', endStroke: '#b85450', decision: '#fff2cc', decisionStroke: '#d6b656' },
}

/** Geometry of one generated node. */
export const DEFAULT_WIDTH = 140
export const DEFAULT_HEIGHT = 56
const COLUMN_GAP = 48
const ROW_GAP = 72
const ORIGIN_X = 60
const ORIGIN_Y = 40

/** One style string for a node description. */
function nodeStyle(node, palette) {
  const shapeKey = typeof node.shape === 'string' ? node.shape.toLowerCase() : 'rect'
  const base = SHAPES[shapeKey] ?? SHAPES.rect
  let fill = palette.fill
  let stroke = palette.stroke
  if (node.role === 'start' || shapeKey === 'start') {
    fill = palette.start
    stroke = palette.startStroke
  } else if (node.role === 'end' || shapeKey === 'end') {
    fill = palette.end
    stroke = palette.endStroke
  } else if (shapeKey === 'diamond' || shapeKey === 'rhombus' || shapeKey === 'decision') {
    fill = palette.decision
    stroke = palette.decisionStroke
  }
  const overrides = [
    typeof node.fill === 'string' ? `fillColor=${node.fill};` : `fillColor=${fill};`,
    typeof node.stroke === 'string' ? `strokeColor=${node.stroke};` : `strokeColor=${stroke};`,
    typeof node.color === 'string' ? `fontColor=${node.color};` : `fontColor=${palette.font};`,
    typeof node.fontSize === 'number' ? `fontSize=${node.fontSize};` : '',
    node.bold === true ? 'fontStyle=1;' : '',
    node.dashed === true ? 'dashed=1;' : '',
  ]
    .join('')
  return `${base}${overrides}`
}

/**
 * Compose a draw.io style string from resolved parts. Shared with the surgical
 * editor so an appended node looks exactly like a freshly built one.
 * @param {{ base: string, fill: string, stroke: string, font: string, fontSize?: number, bold?: boolean, dashed?: boolean }} parts
 * @returns {string} one `key=value;` style string.
 */
export function formatStyleOf(parts) {
  return [
    parts.base,
    `fillColor=${parts.fill};`,
    `strokeColor=${parts.stroke};`,
    `fontColor=${parts.font};`,
    typeof parts.fontSize === 'number' ? `fontSize=${parts.fontSize};` : '',
    parts.bold === true ? 'fontStyle=1;' : '',
    parts.dashed === true ? 'dashed=1;' : '',
  ].join('')
}

/** One style string for an edge description. */
function edgeStyle(edge, dashedDefault) {
  const parts = ['edgeStyle=orthogonalEdgeStyle;', 'rounded=0;', 'html=1;', 'endArrow=classic;', 'endFill=1;']
  if (edge.dashed === true || (edge.dashed === undefined && dashedDefault)) parts.push('dashed=1;')
  if (typeof edge.color === 'string') parts.push(`strokeColor=${edge.color};`)
  if (typeof edge.label === 'string' && edge.label.length > 0) parts.push('labelBackgroundColor=default;')
  if (edge.dotted === true) parts.push('dashed=1;dashPattern=1 2;')
  return parts.join('')
}

/** Stable, XML-safe id for a user-supplied node key. */
function normalizeId(raw, index, used) {
  const base = String(raw ?? '')
    .trim()
    .replace(/[^\w\u4e00-\u9fff-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  const candidate = base.length > 0 ? base : `n${index + 1}`
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  let suffix = 2
  while (used.has(`${candidate}-${suffix}`)) suffix += 1
  const unique = `${candidate}-${suffix}`
  used.add(unique)
  return unique
}

/**
 * Longest-path layering: a node's level is one more than that of its deepest
 * predecessor, with cycles tolerated by leaving the back edge where it is.
 *
 * @param {string[]} ids - node ids in declaration order.
 * @param {Array<{ from: string, to: string }>} links - resolved edges.
 * @param {Map<string, number>} explicit - levels the caller pinned.
 * @returns {Map<string, number>} level per node.
 */
function assignLevels(ids, links, explicit, options) {
  const level = new Map(ids.map((id) => [id, explicit.get(id) ?? 0]))
  for (const [id, value] of explicit) level.set(id, value)
  const outgoing = new Map(ids.map((id) => [id, []]))
  for (const link of links) {
    if (outgoing.has(link.from) && level.has(link.to)) outgoing.get(link.from).push(link.to)
  }
  // Relax forward edges only. Two guards keep cycles tame: the depth cap, and
  // the fact that a relax pass only moves a node DEEPER. A feed-back edge (the
  // game server reporting to Ingress, the render pipeline feeding state) makes
  // its target a predecessor, so relaxing it would inflate the whole cycle one
  // level per pass — the "60 rows of blank" failure. Nodes already placed by
  // an earlier pass stay put, and the edge is simply drawn across rows.
  const maxDepth = Math.min(ids.length, options?.maxDepth ?? 12)
  for (let pass = 0; pass < ids.length; pass += 1) {
    let changed = false
    for (const [from, targets] of outgoing) {
      for (const to of targets) {
        if (explicit.has(to)) continue
        const candidate = (level.get(from) ?? 0) + 1
        if (candidate > (level.get(to) ?? 0) && candidate <= maxDepth) {
          level.set(to, candidate)
          changed = true
        }
      }
    }
    if (!changed) break
  }
  return level
}

/**
 * Build one page of draw.io XML.
 *
 * @param {object} input - the model-facing description.
 * @param {Array<{ id?: string, label?: string, shape?: string, level?: number, width?: number, height?: number, role?: string, fill?: string, stroke?: string, color?: string, fontSize?: number, bold?: boolean, dashed?: boolean }>} input.nodes
 * @param {Array<{ from: string, to: string, label?: string, dashed?: boolean, dotted?: boolean, color?: string }>} [input.edges]
 * @param {object} [options]
 * @param {string} [options.title] - page name.
 * @param {keyof PALETTES} [options.palette] - named palette.
 * @param {boolean} [options.dashedEdges] - default dashed state for edges.
 * @param {number} [options.pageWidth]
 * @param {number} [options.pageHeight]
 * @returns {{ xml: string, idMap: Map<string, string>, warnings: string[] }}
 */
export function buildDiagram(input, options = {}) {
  const warnings = []
  const palette = PALETTES[options.palette] ?? PALETTES.default
  const title = typeof options.title === 'string' && options.title.length > 0 ? options.title : 'Page-1'
  const used = new Set(['0', '1'])
  const idMap = new Map()
  const nodes = []
  for (const [index, node] of (input.nodes ?? []).entries()) {
    const sourceKey = node.id ?? node.label ?? `n${index + 1}`
    const id = normalizeId(node.id ?? `n${index + 1}`, index, used)
    if (idMap.has(String(sourceKey))) {
      warnings.push(`duplicate node id "${sourceKey}" in the request; kept the first occurrence`)
      continue
    }
    idMap.set(String(sourceKey), id)
    nodes.push({
      ...node,
      id,
      sourceKey: String(sourceKey),
      label: typeof node.label === 'string' ? node.label : '',
      width: Number.isFinite(node.width) ? Math.max(20, Number(node.width)) : DEFAULT_WIDTH,
      height: Number.isFinite(node.height) ? Math.max(20, Number(node.height)) : DEFAULT_HEIGHT,
      style: nodeStyle(node, palette),
    })
  }
  // Auto-fit labels: the leading cause of "text all squeezed together" is a
  // 140x56 default box holding a 60-character label. Measure each label with
  // the same character-width table the SVG renderer uses and grow the box
  // (widen first, then add wrapped lines) before layout runs.
  for (const node of nodes) {
    const label = node.label
    if (label.length === 0) continue
    let width = node.width
    let fontSize = 13
    let lines = []
    const measure = (text) => {
      let w = 0
      for (const char of text) w += /[\u3000-\u9fff\uff00-\uffef\u2014\u2026]/u.test(char) ? fontSize : fontSize * 0.56
      return w
    }
    const wrap = (w) => {
      const usable = Math.max(w - 16, 24)
      const out = []
      for (const paragraph of label.split(/\r?\n/u)) {
        let current = ''
        let currentWidth = 0
        for (const char of paragraph) {
          const cw = measure(char)
          if (currentWidth + cw > usable && current.length > 0) {
            out.push(current)
            current = char
            currentWidth = cw
            continue
          }
          current += char
          currentWidth += cw
        }
        out.push(current)
      }
      return out
    }
    for (let pass = 0; pass < 6; pass += 1) {
      lines = wrap(width)
      const lineHeight = fontSize * 1.35
      const needed = lines.length * lineHeight + 14
      if (needed <= node.height) break
      if (width < 320 && lines.length > 1) {
        // Try widening before growing taller: wide boxes read better.
        width = Math.min(320, Math.ceil(width * 1.5))
        continue
      }
      node.height = Math.ceil(Math.min(needed, node.height + 200))
      break
    }
    node.width = width
  }
  const linkInput = []
  for (const edge of input.edges ?? []) {
    const from = idMap.get(String(edge.from))
    const to = idMap.get(String(edge.to))
    if (from === undefined || to === undefined) {
      warnings.push(`edge ${String(edge.from)} -> ${String(edge.to)} references an unknown node and was skipped`)
      continue
    }
    linkInput.push({ from, to, edge })
  }
  const explicitLevels = new Map()
  for (const node of nodes) {
    if (Number.isFinite(node.level)) explicitLevels.set(node.id, Number(node.level))
  }
  const levels = assignLevels(
    nodes.map((node) => node.id),
    linkInput,
    explicitLevels,
  )
  // Pin any node that another node skips past, so a simple chain keeps N rows.
  const rows = new Map()
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0
    const row = rows.get(level) ?? []
    row.push(node)
    rows.set(level, row)
  }
  // Compact empty rows: the depth cap leaves gaps when a cycle inflates some
  // nodes past the cap while their neighbours stay shallow, and empty levels
  // would render as huge blank bands between occupied ones.
  const usedLevels = [...rows.keys()].sort((a, b) => a - b)
  const remap = new Map(usedLevels.map((level, index) => [level, index]))
  const compactRows = new Map()
  for (const [level, row] of rows) compactRows.set(remap.get(level), row)
  rows.clear()
  for (const [level, row] of compactRows) rows.set(level, row)
  const maxLevel = usedLevels.length - 1
  const rowCount = usedLevels.length
  const rowWidths = [...rows.values()].map((row) => row.reduce((sum, node) => sum + node.width, 0) + COLUMN_GAP * Math.max(0, row.length - 1))
  const widestRow = Math.max(...rowWidths, 0)
  const geometry = new Map()
  for (let level = 0; level <= maxLevel; level += 1) {
    const row = rows.get(level) ?? []
    const totalWidth = row.reduce((sum, node) => sum + node.width, 0) + COLUMN_GAP * Math.max(0, row.length - 1)
    let x = ORIGIN_X + (widestRow - totalWidth) / 2
    for (const node of row) {
      geometry.set(node.id, { x: Math.round(x), y: Math.round(ORIGIN_Y + level * (DEFAULT_HEIGHT + ROW_GAP)) })
      x += node.width + COLUMN_GAP
    }
  }
  const cells = []
  for (const node of nodes) {
    const box = geometry.get(node.id) ?? { x: ORIGIN_X, y: ORIGIN_Y }
    cells.push(
      [
        `        <mxCell id="${escapeXml(node.id)}" value="${escapeXml(node.label)}" style="${escapeXml(node.style)}" vertex="1" parent="1">`,
        `          <mxGeometry x="${box.x}" y="${box.y}" width="${Math.round(node.width)}" height="${Math.round(node.height)}" as="geometry"/>`,
        '        </mxCell>',
      ].join('\n'),
    )
  }
  let edgeIndex = 0
  for (const { from, to, edge } of linkInput) {
    edgeIndex += 1
    const id = `e${edgeIndex}`
    const label = typeof edge.label === 'string' ? edge.label : ''
    cells.push(
      [
        `        <mxCell id="${id}" value="${escapeXml(label)}" style="${escapeXml(edgeStyle(edge, options.dashedEdges === true))}" edge="1" parent="1" source="${escapeXml(from)}" target="${escapeXml(to)}">`,
        '          <mxGeometry relative="1" as="geometry"/>',
        '        </mxCell>',
      ].join('\n'),
    )
  }
  const pageWidth = Math.round(Number.isFinite(options.pageWidth) ? Number(options.pageWidth) : Math.max(850, widestRow + ORIGIN_X * 2))
  const pageHeight = Math.round(
    Number.isFinite(options.pageHeight) ? Number(options.pageHeight) : Math.max(400, ORIGIN_Y * 2 + rowCount * (DEFAULT_HEIGHT + ROW_GAP)),
  )
  const modelAttributes = Object.entries({ ...GRAPH_MODEL_DEFAULTS, pageWidth, pageHeight })
    .map(([name, value]) => `${name}="${value}"`)
    .join(' ')
  const model = [
    `    <mxGraphModel ${modelAttributes}>`,
    '      <root>',
    '        <mxCell id="0"/>',
    '        <mxCell id="1" parent="0"/>',
    ...cells,
    '      </root>',
    '    </mxGraphModel>',
  ].join('\n')
  const xml = [
    '<mxfile host="sorarisu/dsh-drawio">',
    `  <diagram id="page-1" name="${escapeXml(title)}">`,
    model,
    '  </diagram>',
    '</mxfile>',
  ].join('\n')
  return { xml, idMap, warnings }
}
