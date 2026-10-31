/**
 * Surgical edits on an existing draw.io page.
 *
 * The model is not the only writer: the user edits the same file in the
 * embedded draw.io editor, and that editor owns geometry, waypoints, and style
 * strings this plugin does not model. So an edit never re-renders the page. It
 * locates the exact `<mxCell>` tags it was asked about, changes only those, and
 * appends new cells before `</root>`.
 *
 * Every operation returns the new document plus what it actually changed, so the
 * tool can report facts instead of claiming success.
 *
 * @module @sorarisu/dsh-drawio/lib/edit
 */
import { escapeXml, findElement, firstPageModel, readAttribute, toMxfile } from './drawio-xml.js'
import { PALETTES, SHAPES, formatStyleOf } from './drawio-build.js'

/** Cells of the first page with offsets absolute in `document`, ready to splice. */
function locateCells(document) {
  const model = firstPageModel(document)
  const root = findElement(model, 'root')
  const modelStart = document.indexOf(model)
  if (root === undefined || modelStart === -1) return { model, cells: [], modelStart: -1 }
  // Offsets must be document-absolute: callers splice into `document`, not `model`.
  const base = modelStart + root.innerStart
  const inner = model.slice(root.innerStart, root.innerEnd)
  const cells = []
  const pattern = /<mxCell\b/gu
  let match
  while ((match = pattern.exec(inner)) !== null) {
    const localStart = match.index
    const tagEnd = inner.indexOf('>', localStart)
    if (tagEnd === -1) break
    const startTag = inner.slice(localStart, tagEnd + 1)
    const selfClosing = startTag.endsWith('/>')
    const localEnd = selfClosing ? tagEnd + 1 : localClose(inner, tagEnd)
    if (localEnd === -1) break
    cells.push({
      id: readAttribute(startTag, 'id'),
      start: base + localStart,
      end: base + localEnd,
      startTag,
      tag: inner.slice(localStart, localEnd),
    })
    pattern.lastIndex = localEnd
  }
  return { model, cells, modelStart }
}

/** Offset just past `</mxCell>` for the cell whose start tag ends at `tagEnd`. */
function localClose(inner, tagEnd) {
  const close = inner.indexOf('</mxCell>', tagEnd)
  return close === -1 ? -1 : close + '</mxCell>'.length
}

/** Replace one attribute inside a start tag, inserting it when absent. */
function setAttribute(startTag, name, value) {
  const pattern = new RegExp(`(\\s${name}\\s*=\\s*")[^"]*(")`, 'u')
  if (pattern.test(startTag)) return startTag.replace(pattern, `$1${escapeXml(value)}$2`)
  return startTag.replace(/\s*\/?>$/u, (tail) => ` ${name}="${escapeXml(value)}"${tail.trim()}`)
}

/** Remove one attribute from a start tag. */
function dropAttribute(startTag, name) {
  return startTag.replace(new RegExp(`\\s${name}\\s*=\\s*"[^"]*"`, 'u'), '')
}

/** Lowest and right-most extent of existing vertex geometry in one model. */
function existingExtent(model) {
  let maxY = 0
  let maxX = 0
  const pattern = /<mxGeometry\b[^>]*>/gu
  let match
  while ((match = pattern.exec(model)) !== null) {
    const tag = match[0]
    if (readAttribute(tag, 'as') !== 'geometry') continue
    const x = Number(readAttribute(tag, 'x') ?? 0)
    const y = Number(readAttribute(tag, 'y') ?? 0)
    const width = Number(readAttribute(tag, 'width') ?? 0)
    const height = Number(readAttribute(tag, 'height') ?? 0)
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue
    maxX = Math.max(maxX, x + (Number.isFinite(width) ? width : 0))
    maxY = Math.max(maxY, y + (Number.isFinite(height) ? height : 0))
  }
  return { maxX, maxY }
}

/** Every id the page already uses, including the two roots. */
function usedIds(cells) {
  const used = new Set(['0', '1'])
  for (const cell of cells) if (typeof cell.id === 'string') used.add(cell.id)
  return used
}

/** Rewrite the page model inside the surrounding document. */
function replaceModel(document, previousModel, nextModel) {
  const at = document.indexOf(previousModel)
  if (at === -1) return null
  return `${document.slice(0, at)}${nextModel}${document.slice(at + previousModel.length)}`
}


/** Insert cell XML just before `</root>`. */
function insertCells(model, cellsXml) {
  const root = findElement(model, 'root')
  if (root === undefined) return null
  return `${model.slice(0, root.innerEnd)}${cellsXml}${model.slice(root.innerEnd)}`
}

/** Node style string for one appended node, matching {@link buildDiagram}'s rules. */
function styleForNode(node, palette) {
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
  return formatStyleOf({
    base,
    fill: typeof node.fill === 'string' ? node.fill : fill,
    stroke: typeof node.stroke === 'string' ? node.stroke : stroke,
    font: typeof node.color === 'string' ? node.color : palette.font,
    fontSize: typeof node.fontSize === 'number' ? node.fontSize : undefined,
    bold: node.bold === true,
    dashed: node.dashed === true,
  })
}

/** Edge style string for one appended edge. */
function styleForEdge(edge) {
  const parts = ['edgeStyle=orthogonalEdgeStyle;', 'rounded=0;', 'html=1;', 'endArrow=classic;', 'endFill=1;']
  if (edge.dashed === true) parts.push('dashed=1;')
  if (typeof edge.color === 'string') parts.push(`strokeColor=${edge.color};`)
  if (edge.dotted === true) parts.push('dashed=1;dashPattern=1 2;')
  if (typeof edge.label === 'string' && edge.label.length > 0) parts.push('labelBackgroundColor=default;')
  return parts.join('')
}

/** Stable, XML-safe cell id from a caller key. */
function uniqueId(raw, used) {
  const base = String(raw ?? '')
    .trim()
    .replace(/[^\w\u4e00-\u9fff-]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
  const candidate = base.length > 0 ? base : 'n'
  if (!used.has(candidate)) {
    used.add(candidate)
    return candidate
  }
  let suffix = 2
  while (used.has(`${candidate}-${suffix}`)) suffix += 1
  used.add(`${candidate}-${suffix}`)
  return `${candidate}-${suffix}`
}

/**
 * Append nodes and edges to an existing page.
 *
 * New nodes are laid out left-to-right in a single row below everything already
 * drawn. An edge may connect a new node to an existing cell, so `from`/`to`
 * accept either a key declared in this call or an id already on the page.
 *
 * @param {string} xml - the current document.
 * @param {{ nodes?: Array<Record<string, any>>, edges?: Array<Record<string, any>> }} addition
 * @param {object} [options]
 * @param {string} [options.palette] - named palette from {@link PALETTES}.
 * @returns {{ xml: string, addedNodes: Array<{ ref: string, id: string }>, addedEdges: string[], warnings: string[] }}
 */
export function addCells(xml, addition, options = {}) {
  const document = toMxfile(xml)
  const located = locateCells(document)
  const used = usedIds(located.cells)
  const extent = existingExtent(located.model)
  const palette = PALETTES[options.palette] ?? PALETTES.default
  const warnings = []
  const refToId = new Map()
  const placed = []
  const originX = 60
  const baseY = Math.round(extent.maxY + 80)
  let cursorX = Math.max(originX, Math.min(originX, 60))
  for (const [index, node] of (addition.nodes ?? []).entries()) {
    const ref = String(node.id ?? node.label ?? `n${index + 1}`)
    if (refToId.has(ref)) {
      warnings.push(`节点 "${ref}" 重复出现，保留第一次`)
      continue
    }
    const id = uniqueId(node.id ?? `n${index + 1}`, used)
    refToId.set(ref, id)
    const width = Number.isFinite(node.width) ? Math.max(20, Number(node.width)) : 140
    const height = Number.isFinite(node.height) ? Math.max(20, Number(node.height)) : 56
    placed.push({ id, ref, node, x: Math.round(cursorX), y: baseY, width, height })
    cursorX += width + 48
  }
  const cellsXml = []
  const addedNodes = []
  for (const item of placed) {
    addedNodes.push({ ref: item.ref, id: item.id })
    cellsXml.push(
      [
        '',
        `        <mxCell id="${escapeXml(item.id)}" value="${escapeXml(typeof item.node.label === 'string' ? item.node.label : '')}" style="${escapeXml(
          styleForNode(item.node, palette),
        )}" vertex="1" parent="1">`,
        `          <mxGeometry x="${item.x}" y="${item.y}" width="${Math.round(item.width)}" height="${Math.round(item.height)}" as="geometry"/>`,
        '        </mxCell>',
      ].join('\n'),
    )
  }
  const existingIds = new Set(located.cells.map((cell) => cell.id).filter((id) => typeof id === 'string'))
  const addedEdges = []
  let edgeIndex = 0
  for (const edge of addition.edges ?? []) {
    const from = refToId.get(String(edge.from)) ?? (existingIds.has(String(edge.from)) ? String(edge.from) : undefined)
    const to = refToId.get(String(edge.to)) ?? (existingIds.has(String(edge.to)) ? String(edge.to) : undefined)
    if (from === undefined || to === undefined) {
      warnings.push(`连线 ${String(edge.from)} -> ${String(edge.to)} 引用了不存在的节点，已跳过`)
      continue
    }
    edgeIndex += 1
    const id = uniqueId(`e${edgeIndex}`, used)
    addedEdges.push(id)
    cellsXml.push(
      [
        '',
        `        <mxCell id="${id}" value="${escapeXml(typeof edge.label === 'string' ? edge.label : '')}" style="${escapeXml(styleForEdge(edge))}" edge="1" parent="1" source="${escapeXml(
          from,
        )}" target="${escapeXml(to)}">`,
        '          <mxGeometry relative="1" as="geometry"/>',
        '        </mxCell>',
      ].join('\n'),
    )
  }
  if (cellsXml.length === 0) return { xml: document, addedNodes: [], addedEdges: [], warnings }
  const model = insertCells(located.model, cellsXml.join(''))
  if (model === null) return { xml: document, addedNodes: [], addedEdges: [], warnings: [...warnings, '页面结构无法识别，未做修改'] }
  const next = replaceModel(document, located.model, model)
  if (next === null) return { xml: document, addedNodes: [], addedEdges: [], warnings: [...warnings, '页面结构无法识别，未做修改'] }
  return { xml: next, addedNodes, addedEdges, warnings }
}

/**
 * Change the label, style, or geometry of existing cells.
 *
 * @param {string} xml - the current document.
 * @param {Array<{ id: string, label?: string, style?: Record<string, string | true | undefined>, geometry?: { x?: number, y?: number, width?: number, height?: number } }>} changes
 * @returns {{ xml: string, updated: string[], missing: string[] }}
 */
export function updateCells(xml, changes) {
  let document = toMxfile(xml)
  const updated = []
  const missing = []
  for (const change of changes) {
    const id = String(change.id)
    const fresh = locateCells(document)
    const cell = fresh.cells.find((candidate) => candidate.id === id)
    if (cell === undefined) {
      missing.push(id)
      continue
    }
    let startTag = cell.startTag
    if (typeof change.label === 'string') startTag = setAttribute(startTag, 'value', change.label)
    if (change.style !== undefined && typeof change.style === 'object') {
      const merged = mergeStyle(readAttribute(startTag, 'style') ?? '', change.style)
      startTag =
        merged.length === 0 ? dropAttribute(startTag, 'style') : setAttribute(startTag, 'style', merged)
    }
    let tag = cell.tag
    if (change.geometry !== undefined && typeof change.geometry === 'object') {
      tag = tag.replace(/<mxGeometry\b[^>]*>/u, (geometryTag) => {
        let next = geometryTag
        for (const key of ['x', 'y', 'width', 'height']) {
          const value = change.geometry[key]
          if (Number.isFinite(value)) next = setAttribute(next, key, String(Number(value)))
        }
        return next
      })
    }
    tag = tag.replace(cell.startTag, startTag)
    // Splice into the document, then re-locate: byte offsets after this cell moved.
    const nextDocument = `${document.slice(0, cell.start)}${tag}${document.slice(cell.end)}`
    if (nextDocument === document) continue
    updated.push(id)
    document = nextDocument
  }
  return { xml: document, updated, missing }
}

/** Merge style overrides onto an existing `key=value;` string; '' removes a key. */
function mergeStyle(current, overrides) {
  const parts = new Map()
  for (const part of current.split(';')) {
    if (part.trim().length === 0) continue
    const equals = part.indexOf('=')
    if (equals === -1) parts.set(part.trim(), true)
    else parts.set(part.slice(0, equals).trim(), part.slice(equals + 1).trim())
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined || value === null || value === '') parts.delete(key)
    else parts.set(key, value)
  }
  return [...parts.entries()].map(([key, value]) => (value === true ? `${key};` : `${key}=${value};`)).join('')
}

/**
 * Delete cells, plus every edge that pointed at one of them.
 *
 * @param {string} xml - the current document.
 * @param {string[]} ids - cell ids to remove.
 * @returns {{ xml: string, removed: string[], removedEdges: string[], missing: string[] }}
 */
export function removeCells(xml, ids) {
  const document = toMxfile(xml)
  const wanted = new Set(ids.map(String))
  const present = new Set(locateCells(document).cells.map((cell) => cell.id))
  const missing = [...wanted].filter((id) => !present.has(id))
  const removed = []
  const removedEdges = []
  let current = document
  for (;;) {
    const cells = locateCells(current)
    const target = cells.cells.find((cell) => wanted.has(String(cell.id)))
    if (target === undefined) break
    removed.push(String(target.id))
    current = `${current.slice(0, target.start)}${current.slice(target.end)}`
  }
  for (;;) {
    const cells = locateCells(current)
    const dangling = cells.cells.find((cell) => {
      const source = readAttribute(cell.startTag, 'source')
      const target = readAttribute(cell.startTag, 'target')
      return (source !== undefined && wanted.has(source)) || (target !== undefined && wanted.has(target))
    })
    if (dangling === undefined) break
    removedEdges.push(String(dangling.id))
    current = `${current.slice(0, dangling.start)}${current.slice(dangling.end)}`
  }
  return { xml: current, removed, removedEdges, missing }
}
