import zlib from 'node:zlib'

/**
 * draw.io XML helpers shared by the editor host route, the SVG previewer, and
 * the model tool.
 *
 * Two shapes travel through this module:
 * - `<mxfile><diagram>…</diagram></mxfile>` — the document a `.drawio` file
 *   holds, which the browser editor and the model both read and write.
 * - `<mxGraphModel>…</mxGraphModel>` — the content of one `<diagram>` page.
 *
 * Nothing here renders; it only moves between those shapes and the two
 * encodings the embed protocol accepts (plain XML, and deflate+URI+base64).
 *
 * @module @sorarisu/dsh-drawio/lib/drawio-xml
 */

/** Page-local defaults applied to a generated or repaired graph model. */
export const GRAPH_MODEL_DEFAULTS = {
  dx: 0,
  dy: 0,
  grid: 1,
  gridSize: 10,
  guides: 1,
  tooltips: 1,
  connect: 1,
  arrows: 1,
  fold: 1,
  page: 0,
  pageScale: 1,
  pageWidth: 850,
  pageHeight: 1100,
  math: 0,
  shadow: 0,
}

/** XML text escape for values placed inside an attribute or text node. */
export function escapeXml(value) {
  return String(value)
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;')
    .replace(/'/gu, '&apos;')
}

/** XML text unescape for values read back out of an attribute or text node. */
export function unescapeXml(value) {
  return String(value).replace(
    /&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/gu,
    (entity) => {
      switch (entity) {
        case '&amp;':
          return '&'
        case '&lt;':
          return '<'
        case '&gt;':
          return '>'
        case '&quot;':
          return '"'
        case '&apos;':
          return "'"
        default: {
          const numeric = entity.slice(2, -1)
          const code = numeric.startsWith('x')
            ? Number.parseInt(numeric.slice(1), 16)
            : Number.parseInt(numeric, 10)
          return Number.isFinite(code) ? String.fromCodePoint(code) : entity
        }
      }
    },
  )
}

/** Read one attribute from a start-tag body, unescaped, or undefined. */
export function readAttribute(tagBody, name) {
  const pattern = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`, 'u')
  const match = pattern.exec(tagBody)
  return match === null ? undefined : unescapeXml(match[1])
}

/** Read every `name="value"` pair of one start tag into an object. */
export function readAttributes(tagBody) {
  const attributes = {}
  const pattern = /([\w:-]+)\s*=\s*"([^"]*)"/gu
  let match
  while ((match = pattern.exec(tagBody)) !== null) {
    attributes[match[1]] = unescapeXml(match[2])
  }
  return attributes
}

/** Whether `text` is one XML start tag for `name`; its body excludes `<` and `>`. */
function isStartTag(text, name, index) {
  const open = `<${name}`
  if (!text.startsWith(open, index)) return false
  const next = text[index + open.length]
  return next === '>' || next === '/' || next === ' ' || next === '\n' || next === '\t' || next === '\r'
}

/** Offsets of one element's tags in `xml`, depth-aware for same-name nesting. */
export function findElement(xml, name, from = 0) {
  let cursor = from
  while (cursor < xml.length) {
    const startTagStart = xml.indexOf(`<${name}`, cursor)
    if (startTagStart === -1) return undefined
    if (!isStartTag(xml, name, startTagStart)) {
      cursor = startTagStart + 1
      continue
    }
    const startTagEnd = xml.indexOf('>', startTagStart)
    if (startTagEnd === -1) return undefined
    if (xml[startTagEnd - 1] === '/') {
      return {
        startTagStart,
        startTagEnd,
        innerStart: startTagEnd + 1,
        innerEnd: startTagEnd + 1,
        closeTagStart: startTagEnd + 1,
        closeTagEnd: startTagEnd + 1,
      }
    }
    let depth = 1
    let scan = startTagEnd + 1
    while (depth > 0) {
      const nextOpen = xml.indexOf(`<${name}`, scan)
      const nextClose = xml.indexOf(`</${name}>`, scan)
      if (nextClose === -1) return undefined
      if (nextOpen !== -1 && nextOpen < nextClose && isStartTag(xml, name, nextOpen)) {
        const nestedEnd = xml.indexOf('>', nextOpen)
        if (nestedEnd === -1) return undefined
        if (xml[nestedEnd - 1] !== '/') depth += 1
        scan = nestedEnd + 1
        continue
      }
      depth -= 1
      if (depth === 0) {
        return {
          startTagStart,
          startTagEnd,
          innerStart: startTagEnd + 1,
          innerEnd: nextClose,
          closeTagStart: nextClose,
          closeTagEnd: nextClose + `</${name}>`.length,
        }
      }
      scan = nextClose + `</${name}>`.length
    }
    return undefined
  }
  return undefined
}

/** Base64 of deflate(URI-encoded text), the encoding draw.io's own files use. */
function encodeCompressed(xml) {
  return zlib.deflateRawSync(Buffer.from(encodeURIComponent(xml), 'utf8')).toString('base64')
}

/** Decode a compressed `<diagram>` body; undefined when it is not one. */
function decodeCompressedDiagram(body) {
  try {
    const inflated = zlib.inflateRawSync(Buffer.from(body, 'base64')).toString('utf8')
    const text = decodeURIComponent(inflated)
    return text.trim().startsWith('<') ? text : undefined
  } catch {
    return undefined
  }
}

/** A bare empty `<mxGraphModel>` with draw.io's two root cells. */
export function emptyGraphModel() {
  const attributes = Object.entries(GRAPH_MODEL_DEFAULTS)
    .map(([name, value]) => `${name}="${value}"`)
    .join(' ')
  return `<mxGraphModel ${attributes}><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>`
}

/** The complete `<mxfile>` document for one empty page. */
export function emptyDiagramXml(title = 'Page-1') {
  return [
    '<mxfile host="sorarisu/dsh-drawio">',
    `  <diagram id="page-1" name="${escapeXml(title)}">`,
    `    ${emptyGraphModel()}`,
    '  </diagram>',
    '</mxfile>',
  ].join('\n')
}

/**
 * Ensure a page body keeps draw.io's `0` root and `1` default layer, which every
 * other cell descends from; without them the page cannot be edited.
 */
export function normalizeGraphModel(body) {
  const trimmed = String(body ?? '').trim()
  if (trimmed.startsWith('<mxGraphModel')) {
    const root = findElement(trimmed, 'root')
    if (root === undefined) {
      const openEnd = trimmed.indexOf('>')
      if (openEnd === -1) return emptyGraphModel()
      return `${trimmed.slice(0, openEnd + 1)}<root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>`
    }
    const rootBody = trimmed.slice(root.startTagStart, root.closeTagEnd)
    const hasRootCell = /<mxCell[^>]*\sid="0"/u.test(rootBody)
    const hasLayer = /<mxCell[^>]*\sid="1"[^>]*\bparent="0"/u.test(rootBody)
    if (hasRootCell && hasLayer) return trimmed
    const repaired = rootBody.replace(
      /<\/root>$/u,
      `${hasRootCell ? '' : '<mxCell id="0"/>'}${hasLayer ? '' : '<mxCell id="1" parent="0"/>'}</root>`,
    )
    return `${trimmed.slice(0, root.startTagStart)}${repaired}${trimmed.slice(root.closeTagEnd)}`
  }
  const attributes = Object.entries(GRAPH_MODEL_DEFAULTS)
    .map(([name, value]) => `${name}="${value}"`)
    .join(' ')
  const rootInner = /<mxCell/u.test(trimmed)
    ? trimmed
    : '<mxCell id="0"/><mxCell id="1" parent="0"/>'
  return `<mxGraphModel ${attributes}><root>${rootInner}</root></mxGraphModel>`
}

/** First page body of a document body, decompressed when draw.io stored it compressed. */
function firstPageBody(mxfileBody) {
  const diagram = findElement(mxfileBody, 'diagram')
  if (diagram === undefined) return undefined
  const raw = mxfileBody.slice(diagram.innerStart, diagram.innerEnd).trim()
  // A page body is either nested raw XML (already correctly escaped once) or a
  // compressed payload. Only the compressed form needs entity unescaping, and
  // unescaping raw nested XML would corrupt every `&amp;` a cell label carries.
  if (raw.startsWith('<')) return raw
  return decodeCompressedDiagram(unescapeXml(raw)) ?? decodeCompressedDiagram(raw) ?? raw
}

/** Every page after the first, serialized back into `mxfile` form, or ''. */
function remainingPages(mxfileBody, firstPage) {
  const rest = mxfileBody.slice(firstPage.closeTagEnd)
  return findElement(rest, 'diagram') === undefined ? '' : rest.trim()
}

/**
 * Normalize any accepted input into the one-page `<mxfile>` both the editor and
 * the tool read.
 *
 * @param {string} input - full `<mxfile>`, bare `<mxGraphModel>`, or a page body.
 * @param {string} [fallbackTitle] - page name used when the input carries none.
 * @returns {string} a well-formed one-page `<mxfile>`.
 */
export function toMxfile(input, fallbackTitle = 'Page-1') {
  const text = String(input ?? '').trim()
  if (text.length === 0) return emptyDiagramXml(fallbackTitle)
  const mxfile = findElement(text, 'mxfile')
  if (mxfile !== undefined) {
    const outer = text.slice(mxfile.innerStart, mxfile.innerEnd)
    const firstPage = findElement(outer, 'diagram')
    if (firstPage === undefined) {
      return `<mxfile>${outer.trim()}<diagram id="page-1" name="${escapeXml(fallbackTitle)}">${emptyGraphModel()}</diagram></mxfile>`
    }
    const pageTag = outer.slice(firstPage.startTagStart, firstPage.startTagEnd + 1)
    const id = readAttribute(pageTag, 'id') ?? 'page-1'
    const name = readAttribute(pageTag, 'name') ?? fallbackTitle
    const model = firstPageBody(outer) ?? emptyGraphModel()
    const rest = remainingPages(outer, firstPage)
    const body = [
      `<diagram id="${escapeXml(id)}" name="${escapeXml(name)}">`,
      normalizeGraphModel(model),
      ...(rest.length > 0 ? [rest] : []),
      '</diagram>',
    ].join('\n')
    return `${'<mxfile>'}${body}</mxfile>`
  }
  return [
    '<mxfile>',
    `<diagram id="page-1" name="${escapeXml(fallbackTitle)}">`,
    normalizeGraphModel(text),
    '</diagram>',
    '</mxfile>',
  ].join('\n')
}

/**
 * The first page's `<mxGraphModel>` body of any accepted input.
 * @param {string} xml - any accepted document input.
 * @returns {string} the editable page body.
 */
export function firstPageModel(xml) {
  const document = toMxfile(xml)
  const page = findElement(document, 'diagram')
  if (page === undefined) return normalizeGraphModel(document)
  return normalizeGraphModel(document.slice(page.innerStart, page.innerEnd))
}

/**
 * Cells and page metadata used for progress messages and tool results.
 * @param {string} xml - any accepted document input.
 */
export function summarizeDiagram(xml) {
  const document = toMxfile(xml)
  const model = firstPageModel(document)
  const root = findElement(model, 'root')
  const inner = root === undefined ? '' : model.slice(root.innerStart, root.innerEnd)
  const ids = [...inner.matchAll(/<mxCell[^>]*\sid="([^"]*)"/gu)].map((match) => match[1])
  const startTag = model.slice(0, model.indexOf('>') + 1)
  const pageTag = findElement(document, 'diagram')
  const pageStart = pageTag === undefined ? '' : document.slice(pageTag.startTagStart, pageTag.startTagEnd + 1)
  const width = Number(readAttribute(startTag, 'pageWidth') ?? 850)
  const height = Number(readAttribute(startTag, 'pageHeight') ?? 1100)
  return {
    cells: ids.filter((id) => id !== '0' && id !== '1').length,
    pageWidth: Number.isFinite(width) && width > 0 ? width : 850,
    pageHeight: Number.isFinite(height) && height > 0 ? height : 1100,
    pageId: readAttribute(pageStart, 'id') ?? 'page-1',
    pageName: readAttribute(pageStart, 'name') ?? 'Page-1',
  }
}

/**
 * Encode a document for one embed-protocol `load` action.
 * @param {string} xml - `<mxfile>` text.
 * @param {boolean} compressed - true for deflate+URI+base64.
 * @returns {string} a `load`-ready payload.
 */
export function encodeForLoad(xml, compressed = false) {
  return compressed ? encodeCompressed(xml) : xml
}

/**
 * Accept what a `save`/`autosave`/`export` message carries back and normalize it.
 * @param {string} payload - `xml` field of an editor event.
 * @returns {string} normalized `<mxfile>` text.
 */
export function decodeFromEditor(payload) {
  const text = String(payload ?? '').trim()
  if (text.length === 0) return emptyDiagramXml()
  if (text.startsWith('<')) return toMxfile(text)
  return toMxfile(decodeCompressedDiagram(text) ?? text)
}
