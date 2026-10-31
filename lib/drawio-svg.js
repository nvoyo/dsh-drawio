/**
 * Render one draw.io page as a standalone SVG string.
 *
 * This is a deliberately small renderer: it draws the shapes the builder emits,
 * plus the rectangles, rounded rectangles, ellipses, rhombi, and edges that make
 * up most draw.io flowcharts. It exists so a diagram is visible in the Harness
 * UI, in a README, and to `read_image`, without asking draw.io's servers to
 * render anything. A diagram using exotic styles still previews as its boxes
 * and edges, and the embedded editor remains the exact view.
 *
 * @module @sorarisu/dsh-drawio/lib/drawio-svg
 */
import { diagramBounds, readDiagram, shapeOf } from './drawio-model.js'
import { escapeXml } from './drawio-xml.js'

/** Font stack that renders CJK and Latin labels consistently on this machine. */
const FONT_STACK =
  "'Noto Sans CJK SC','Source Han Sans SC','Noto Sans',-apple-system,'Segoe UI',Helvetica,Arial,sans-serif"

/** Split a label into lines that fit a width, roughly 1em per Latin char / 1em per CJK char. */
function wrapLabel(label, width, fontSize) {
  const text = String(label ?? '')
  if (text.length === 0) return ['']
  const usable = Math.max(width - 12, fontSize * 2)
  const perLine = Math.max(1, Math.floor(usable / fontSize))
  const lines = []
  for (const paragraph of text.split(/\r?\n/u)) {
    let current = ''
    let currentWidth = 0
    for (const char of paragraph) {
      const charWidth = /[\u3000-\u9fff\uff00-\uffef]/u.test(char) ? fontSize : fontSize * 0.56
      if (currentWidth + charWidth > usable && current.length > 0) {
        lines.push(current)
        current = char
        currentWidth = charWidth
        continue
      }
      current += char
      currentWidth += charWidth
    }
    lines.push(current.slice(0, perLine * 4))
  }
  return lines.length === 0 ? [''] : lines
}

/** The `<text>` lines centred inside a box. */
function labelSvg(lines, cx, cy, fontSize, color, bold) {
  const lineHeight = fontSize * 1.25
  const startY = cy - ((lines.length - 1) * lineHeight) / 2
  return lines
    .map(
      (line, index) =>
        `<text x="${cx}" y="${startY + index * lineHeight}" font-family="${FONT_STACK}" font-size="${fontSize}"${
          bold ? ' font-weight="600"' : ''
        } fill="${escapeXml(color)}" text-anchor="middle" dominant-baseline="middle">${escapeXml(line)}</text>`,
    )
    .join('')
}

/** Point on one node's border along the direction of `target`, for edge endpoints. */
function borderPoint(node, target) {
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  const dx = target.x - cx
  const dy = target.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const halfW = node.width / 2
  const halfH = node.height / 2
  const scale = Math.min(
    dx === 0 ? Infinity : Math.abs(halfW / dx),
    dy === 0 ? Infinity : Math.abs(halfH / dy),
  )
  return { x: cx + dx * scale, y: cy + dy * scale }
}

/** Trim points that are effectively duplicated, which orthogonal routes produce. */
function dedupe(points) {
  const out = []
  for (const point of points) {
    const last = out.at(-1)
    if (last !== undefined && Math.abs(last.x - point.x) < 0.01 && Math.abs(last.y - point.y) < 0.01) continue
    out.push(point)
  }
  return out
}

/** One node as SVG. */
function nodeSvg(node) {
  const stroke = typeof node.style.strokeColor === 'string' ? node.style.strokeColor : '#6c8ebf'
  const fill = typeof node.style.fillColor === 'string' ? node.style.fillColor : '#dae8fc'
  const font = typeof node.style.fontColor === 'string' ? node.style.fontColor : '#1a1a1a'
  const fontSize = Number(node.style.fontSize ?? 12)
  const bold = String(node.style.fontStyle ?? '').split('').includes('1')
  const dash = String(node.style.dashed ?? '') === '1' ? ' stroke-dasharray="4 3"' : ''
  const shape = shapeOf(node.style)
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  const geometry = `fill="${escapeXml(fill)}" stroke="${escapeXml(stroke)}" stroke-width="1.4"${dash}`
  const lines = wrapLabel(node.label, node.width, fontSize)
  // draw.io puts an actor's label under the glyph, not inside it.
  const text =
    shape === 'actor'
      ? labelSvg(lines, cx, node.y + node.height + fontSize * 0.9, fontSize, font, bold)
      : labelSvg(lines, cx, cy, fontSize, font, bold)
  switch (shape) {
    case 'ellipse':
      return `<ellipse cx="${cx}" cy="${cy}" rx="${node.width / 2}" ry="${node.height / 2}" ${geometry}/>${text}`
    case 'rhombus':
      return `<polygon points="${cx},${node.y} ${node.x + node.width},${cy} ${cx},${node.y + node.height} ${node.x},${cy}" ${geometry}/>${text}`
    case 'hexagon': {
      const inset = node.height / 2
      return `<polygon points="${node.x + inset},${node.y} ${node.x + node.width - inset},${node.y} ${node.x + node.width},${cy} ${node.x + node.width - inset},${node.y + node.height} ${node.x + inset},${node.y + node.height} ${node.x},${cy}" ${geometry}/>${text}`
    }
    case 'parallelogram': {
      const inset = Math.min(node.width / 4, node.height / 2)
      return `<polygon points="${node.x + inset},${node.y} ${node.x + node.width},${node.y} ${node.x + node.width - inset},${node.y + node.height} ${node.x},${node.y + node.height}" ${geometry}/>${text}`
    }
    case 'text':
      return text
    case 'rounded': {
      const radius = Math.min(12, node.height / 3)
      return `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" rx="${radius}" ${geometry}/>${text}`
    }
    case 'actor': {
      const head = Math.min(node.width, node.height) * 0.22
      const cxLocal = cx
      const top = node.y + head
      const body = `M${cxLocal - node.width * 0.18} ${top + head * 1.6} L${cxLocal + node.width * 0.18} ${top + head * 1.6}`
      const arms = `M${node.x + node.width * 0.14} ${top + head * 0.55} L${node.x + node.width * 0.86} ${top + head * 0.55}`
      const legs = `M${cxLocal} ${top + head * 1.6} L${node.x + node.width * 0.2} ${node.y + node.height - head * 0.4} M${cxLocal} ${top + head * 1.6} L${node.x + node.width * 0.8} ${node.y + node.height - head * 0.4}`
      return `<g stroke="${escapeXml(stroke)}" stroke-width="1.6" fill="none"><circle cx="${cxLocal}" cy="${node.y + head}" r="${head * 0.8}" fill="${escapeXml(fill)}"/><path d="${body}"/><path d="${arms}"/><path d="${legs}"/></g>${text}`
    }
    case 'note': {
      const fold = Math.min(16, node.width / 5, node.height / 3)
      const path = `M${node.x} ${node.y} L${node.x + node.width - fold} ${node.y} L${node.x + node.width} ${node.y + fold} L${node.x + node.width} ${node.y + node.height} L${node.x} ${node.y + node.height} Z`
      const corner = `M${node.x + node.width - fold} ${node.y} L${node.x + node.width - fold} ${node.y + fold} L${node.x + node.width} ${node.y + fold}`
      return `<path d="${path}" ${geometry}/><path d="${corner}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="1.2"/>${text}`
    }
    case 'document': {
      const wave = Math.min(12, node.height / 5)
      const path = `M${node.x} ${node.y} L${node.x + node.width} ${node.y} L${node.x + node.width} ${node.y + node.height - wave} Q${cx} ${node.y + node.height + wave * 0.6} ${node.x} ${node.y + node.height - wave} Z`
      return `<path d="${path}" ${geometry}/>${text}`
    }
    case 'cloud': {
      const rx = node.width / 2
      const ry = node.height / 2
      const path = `M${node.x + rx * 0.5} ${node.y + ry * 1.5} a${rx * 0.32} ${ry * 0.4} 0 0 1 ${rx * 0.2} -${ry * 0.7} a${rx * 0.35} ${ry * 0.42} 0 0 1 ${rx * 0.7} -${ry * 0.2} a${rx * 0.3} ${ry * 0.38} 0 0 1 ${rx * 0.45} ${ry * 0.55} a${rx * 0.3} ${ry * 0.35} 0 0 1 -${rx * 0.2} ${ry * 0.6} Z`
      return `<path d="${path}" ${geometry}/>${text}`
    }
    case 'cylinder':
    case 'database': {
      const cap = Math.min(12, node.height / 4)
      const path = `M${node.x} ${node.y + cap} A${node.width / 2} ${cap} 0 0 1 ${node.x + node.width} ${node.y + cap} L${node.x + node.width} ${node.y + node.height - cap} A${node.width / 2} ${cap} 0 0 1 ${node.x} ${node.y + node.height - cap} Z`
      return `<path d="${path}" ${geometry}/>${text}`
    }
    default:
      return `<rect x="${node.x}" y="${node.y}" width="${node.width}" height="${node.height}" ${geometry}/>${text}`
  }
}

/** Whether a segment crosses a rectangle (used to keep edges off other nodes). */
function segmentHitsRect(a, b, rect, pad = 6) {
  const left = rect.x - pad
  const right = rect.x + rect.width + pad
  const top = rect.y - pad
  const bottom = rect.y + rect.height + pad
  const inside = (p) => p.x >= left && p.x <= right && p.y >= top && p.y <= bottom
  if (inside(a) || inside(b)) return true
  const edges = [
    [{ x: left, y: top }, { x: right, y: top }],
    [{ x: right, y: top }, { x: right, y: bottom }],
    [{ x: right, y: bottom }, { x: left, y: bottom }],
    [{ x: left, y: bottom }, { x: left, y: top }],
  ]
  const orientation = (p, q, r) => Math.sign((q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y))
  for (const [c, d] of edges) {
    const o1 = orientation(a, b, c)
    const o2 = orientation(a, b, d)
    const o3 = orientation(c, d, a)
    const o4 = orientation(c, d, b)
    if (o1 !== o2 && o3 !== o4) return true
  }
  return false
}

/** The point on a node's border facing `from`, for a route that arrives sideways. */
function sidePoint(node, from) {
  const cy = node.y + node.height / 2
  if (from.x < node.x) return { x: node.x, y: cy }
  if (from.x > node.x + node.width) return { x: node.x + node.width, y: cy }
  return from.y < cy ? { x: node.x + node.width / 2, y: node.y } : { x: node.x + node.width / 2, y: node.y + node.height }
}

/**
 * Route one edge. A direct connection is used when the straight line touches no
 * other node; otherwise the edge goes down to a mid row, across a side channel
 * clear of every node, and back in. That is what keeps a long back-edge from
 * running straight through the boxes between its ends.
 *
 * @param {object} edge - the parsed edge.
 * @param {Map<string, object>} byId - every node by id.
 * @param {object[]} others - nodes this edge must not cross.
 * @returns {{ points: Array<{ x: number, y: number }>, orthogonal: boolean }}
 */
function routeEdge(edge, byId, others) {
  const source = edge.source === undefined ? undefined : byId.get(edge.source)
  const target = edge.target === undefined ? undefined : byId.get(edge.target)
  if (source === undefined || target === undefined) {
    const points = []
    if (edge.sourcePoint !== undefined) points.push(edge.sourcePoint)
    points.push(...edge.points)
    if (edge.targetPoint !== undefined) points.push(edge.targetPoint)
    return { points: dedupe(points), orthogonal: false }
  }
  const sourceCenter = { x: source.x + source.width / 2, y: source.y + source.height / 2 }
  const targetCenter = { x: target.x + target.width / 2, y: target.y + target.height / 2 }
  // Waypoints the editor stored win: a human already decided that path.
  if (edge.points.length > 0) {
    return {
      points: dedupe([borderPoint(source, edge.points[0]), ...edge.points, borderPoint(target, edge.points.at(-1))]),
      orthogonal: false,
    }
  }
  const directStart = borderPoint(source, targetCenter)
  const directEnd = borderPoint(target, sourceCenter)
  const blockers = others.filter((node) => node.id !== source.id && node.id !== target.id)
  const blocked = blockers.some((node) => segmentHitsRect(directStart, directEnd, node))
  if (!blocked) return { points: [directStart, directEnd], orthogonal: false }

  // A side channel just outside every node's horizontal extent.
  const minX = Math.min(...others.map((node) => node.x), source.x, target.x)
  const maxX = Math.max(...others.map((node) => node.x + node.width), source.x + source.width, target.x + target.width)
  const midX = (directStart.x + directEnd.x) / 2
  const useLeft = midX - minX <= maxX - midX
  const channelX = useLeft ? minX - 26 : maxX + 26
  const midY = (directStart.y + directEnd.y) / 2
  const exitX = useLeft ? source.x : source.x + source.width
  const entryX = useLeft ? target.x : target.x + target.width
  const points = dedupe([
    { x: exitX, y: sourceCenter.y },
    { x: channelX, y: sourceCenter.y },
    { x: channelX, y: targetCenter.y },
    { x: entryX, y: targetCenter.y },
  ])
  void midY
  return { points, orthogonal: true }
}

/** One edge as a polyline plus an arrow head, with its label beside the route. */
function edgeSvg(edge, byId, others) {
  const route = routeEdge(edge, byId, others)
  if (route.points.length < 2) return ''
  const stroke = typeof edge.style.strokeColor === 'string' ? edge.style.strokeColor : '#666666'
  const dash = String(edge.style.dashed ?? '') === '1' ? ' stroke-dasharray="5 4"' : ''
  const path = route.points.map((point) => `${point.x},${point.y}`).join(' ')
  const last = route.points.at(-1)
  const before = route.points.at(-2)
  const angle = Math.atan2(last.y - before.y, last.x - before.x)
  const head = 9
  const left = { x: last.x - head * Math.cos(angle - Math.PI / 7), y: last.y - head * Math.sin(angle - Math.PI / 7) }
  const right = { x: last.x - head * Math.cos(angle + Math.PI / 7), y: last.y - head * Math.sin(angle + Math.PI / 7) }
  const arrow =
    edge.style.endArrow === 'none'
      ? ''
      : `<polygon points="${last.x},${last.y} ${left.x},${left.y} ${right.x},${right.y}" fill="${escapeXml(stroke)}"/>`
  // Put the label on the longest segment: on a routed edge the middle segment is
  // the long side run, and on a direct edge it is the whole line.
  let labelIndex = 1
  let longest = -1
  for (let index = 1; index < route.points.length; index += 1) {
    const a = route.points[index - 1]
    const b = route.points[index]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (length > longest) {
      longest = length
      labelIndex = index
    }
  }
  const labelA = route.points[labelIndex - 1]
  const labelB = route.points[labelIndex]
  const labelPoint = { x: (labelA.x + labelB.x) / 2, y: (labelA.y + labelB.y) / 2 }
  const vertical = Math.abs(labelB.y - labelA.y) >= Math.abs(labelB.x - labelA.x)
  const labelX = vertical ? labelPoint.x + 6 : labelPoint.x
  const labelY = vertical ? labelPoint.y : labelPoint.y - 6
  const label =
    edge.label.length === 0
      ? ''
      : `<text x="${labelX}" y="${labelY}" font-family="${FONT_STACK}" font-size="11" fill="${escapeXml(
          typeof edge.style.fontColor === 'string' ? edge.style.fontColor : '#333333',
        )}" text-anchor="${vertical ? 'start' : 'middle'}" paint-order="stroke" stroke="#ffffff" stroke-width="3" stroke-linejoin="round">${escapeXml(
          edge.label,
        )}</text>`
  return `<polyline points="${path}" fill="none" stroke="${escapeXml(stroke)}" stroke-width="1.3"${dash}/>${arrow}${label}`
}

/**
 * Render one diagram page as a self-contained SVG document.
 *
 * @param {string} xml - any accepted diagram input.
 * @param {object} [options]
 * @param {string} [options.background] - CSS colour for the canvas; omitted leaves it transparent.
 * @param {number} [options.maxWidth] - rendered pixel width; the height follows the aspect ratio.
 * @param {string} [options.title] - accessible title.
 * @returns {string} SVG text.
 */
export function renderSvg(xml, options = {}) {
  const diagram = readDiagram(xml)
  const bounds = diagramBounds(diagram)
  const ratio = bounds.height === 0 ? 1 : bounds.width / bounds.height
  const width = Number.isFinite(options.maxWidth) ? Math.max(120, Number(options.maxWidth)) : 960
  const height = Math.max(80, Math.round(width / (ratio === 0 ? 1 : ratio)))
  const byId = new Map(diagram.nodes.map((node) => [node.id, node]))
  const background =
    typeof options.background === 'string' && options.background.length > 0
      ? `<rect x="${bounds.x}" y="${bounds.y}" width="${bounds.width}" height="${bounds.height}" fill="${escapeXml(options.background)}"/>`
      : ''
  const edges = diagram.edges.map((edge) => edgeSvg(edge, byId, diagram.nodes)).join('')
  const nodes = diagram.nodes.map(nodeSvg).join('')
  const title = escapeXml(options.title ?? 'draw.io diagram')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}" width="${width}" height="${height}" role="img" aria-label="${title}">`,
    `<title>${title}</title>`,
    background,
    `<g>${edges}</g>`,
    `<g>${nodes}</g>`,
    '</svg>',
  ].join('')
}

/** Render a small thumbnail, used for the panel's file list. */
export function renderThumbnail(xml, maxWidth = 240) {
  return renderSvg(xml, { maxWidth, background: 'transparent' })
}
