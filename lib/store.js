/**
 * Diagram files on disk, owned by one small service.
 *
 * Both callers — the embedded editor's save route and the model tool — go
 * through here, so a file is read, validated, and written one way only. Writes
 * are atomic (temp file + rename) because the editor autosaves on every change
 * and a half-written `.drawio` file is not recoverable by draw.io.
 *
 * @module @sorarisu/dsh-drawio/lib/store
 */
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { summarizeDiagram, toMxfile, emptyDiagramXml } from './drawio-xml.js'
import { renderSvg } from './drawio-svg.js'
import { DIAGRAM_EXTENSION, PathPolicyError, displayPath, isDiagramFile, resolveDiagramPath } from './paths.js'

/** Maximum accepted document size, guarding the parser and the editor. */
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024

/** One diagram file's directory listing row. */
function listingRow(absolute, roots, info) {
  return {
    path: displayPath(absolute, roots),
    absolutePath: absolute,
    name: basename(absolute),
    bytes: info.size,
    modifiedAt: info.mtime.toISOString(),
  }
}

/**
 * Diagram storage over a set of workspace roots.
 *
 * Every method takes the roots it may touch, because the roots follow the live
 * workspace registry rather than the plugin's construction time.
 */
export class DiagramStore {
  /**
   * @param {object} options
   * @param {string[]} options.roots - absolute workspace roots that may be read or written.
   * @param {number} [options.maxBytes] - largest accepted document.
   */
  constructor(options) {
    this.roots = Array.isArray(options.roots) ? options.roots : []
    this.maxBytes = Number.isFinite(options.maxBytes) ? Number(options.maxBytes) : DEFAULT_MAX_BYTES
  }

  /** Replace the writable roots; called when the workspace registry changes. */
  setRoots(roots) {
    this.roots = Array.isArray(roots) ? roots : []
  }

  /** The directory a relative request resolves against. */
  get baseDir() {
    return this.roots[0] ?? process.cwd()
  }

  /** Resolve and validate a requested path. */
  resolve(requested, options = {}) {
    return resolveDiagramPath(requested, {
      roots: this.roots,
      baseDir: options.baseDir ?? this.baseDir,
      mustBeDiagram: options.mustBeDiagram !== false,
    })
  }

  /** Display form of an absolute path. */
  display(absolute) {
    return displayPath(absolute, this.roots)
  }

  /**
   * Every diagram file under one directory, newest first.
   *
   * @param {string} [directory] - absolute, or relative to the first root.
   * @param {object} [options]
   * @param {boolean} [options.recursive] - descend into subdirectories.
   * @param {number} [options.limit] - rows to return.
   */
  async list(directory, options = {}) {
    const target = this.resolve(directory ?? this.baseDir, { mustBeDiagram: false })
    const limit = Number.isFinite(options.limit) ? Math.min(500, Math.max(1, Number(options.limit))) : 200
    const rows = []
    const walk = async (dir, depth) => {
      let entries
      try {
        entries = await readdir(dir, { withFileTypes: true })
      } catch {
        return
      }
      for (const entry of entries) {
        if (rows.length >= limit) return
        if (entry.name.startsWith('.')) continue
        const absolute = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (options.recursive === true && depth < 3) await walk(absolute, depth + 1)
          continue
        }
        if (!entry.isFile() || !isDiagramFile(entry.name)) continue
        try {
          const info = await stat(absolute)
          rows.push({ ...listingRow(absolute, this.roots, info), modified: info.mtimeMs })
        } catch {
          // A file that vanished between readdir and stat is simply absent.
        }
      }
    }
    await walk(target, 0)
    rows.sort((left, right) => right.modified - left.modified)
    return rows.slice(0, limit).map(({ modified, ...row }) => row)
  }

  /**
   * Read one diagram document, normalized.
   *
   * @param {string} requested - diagram path.
   * @returns {Promise<{ absolutePath: string, path: string, xml: string, summary: ReturnType<typeof summarizeDiagram> }>}
   * @throws {PathPolicyError} for an unwritable path, a missing file, or an oversized document.
   */
  async read(requested) {
    const absolute = this.resolve(requested)
    let text
    try {
      const info = await stat(absolute)
      if (info.size > this.maxBytes) {
        throw new PathPolicyError(`文件过大（${info.size} 字节，上限 ${this.maxBytes}）。`, 'too-large')
      }
      text = await readFile(absolute, 'utf8')
    } catch (error) {
      if (error instanceof PathPolicyError) throw error
      throw new PathPolicyError(`读不到 "${this.display(absolute)}"：文件不存在或不可读。`, 'unresolvable')
    }
    const xml = toMxfile(text, basename(absolute).replace(/\.drawio$/iu, ''))
    return { absolutePath: absolute, path: this.display(absolute), xml, summary: summarizeDiagram(xml) }
  }

  /**
   * Write one diagram document atomically, creating parent directories.
   *
   * @param {string} requested - diagram path.
   * @param {string} xml - document text.
   * @returns {Promise<{ absolutePath: string, path: string, created: boolean, bytes: number, summary: ReturnType<typeof summarizeDiagram> }>}
   */
  async write(requested, xml) {
    const absolute = this.resolve(requested)
    const text = String(xml ?? '')
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > this.maxBytes) {
      throw new PathPolicyError(`文档过大（${bytes} 字节，上限 ${this.maxBytes}）。`, 'too-large')
    }
    const normalized = toMxfile(text, basename(absolute).replace(/\.drawio$/iu, ''))
    let created = false
    try {
      await stat(absolute)
    } catch {
      created = true
    }
    await mkdir(dirname(absolute), { recursive: true })
    const temporary = `${absolute}.${process.pid}.${Date.now()}.tmp`
    await writeFile(temporary, normalized, 'utf8')
    await rename(temporary, absolute)
    return {
      absolutePath: absolute,
      path: this.display(absolute),
      created,
      bytes: Buffer.byteLength(normalized, 'utf8'),
      summary: summarizeDiagram(normalized),
    }
  }

  /**
   * Read-only existence probe used by the panel before it opens an editor.
   * @param {string} requested - diagram path.
   */
  async exists(requested) {
    try {
      const absolute = this.resolve(requested)
      const info = await stat(absolute)
      return info.isFile()
    } catch {
      return false
    }
  }

  /** Delete one diagram file. */
  async remove(requested) {
    const absolute = this.resolve(requested)
    try {
      await stat(absolute)
    } catch {
      throw new PathPolicyError(`删除失败："${this.display(absolute)}" 不存在。`, 'unresolvable')
    }
    await unlink(absolute)
    return { path: this.display(absolute), absolutePath: absolute }
  }

  /** An empty page for a path that does not exist yet. */
  blank(pageTitle) {
    return emptyDiagramXml(pageTitle ?? 'Page-1')
  }

  /**
   * SVG preview of a document, optionally written next to it.
   * @param {string} xml - document text.
   * @param {{ maxWidth?: number, background?: string, title?: string }} [options]
   */
  preview(xml, options = {}) {
    return renderSvg(xml, options)
  }
}

/** The default title for a new page, derived from its filename. */
export function pageTitleFor(absolutePath) {
  const name = basename(absolutePath)
  const stripped = name.toLowerCase().endsWith(DIAGRAM_EXTENSION) ? name.slice(0, -DIAGRAM_EXTENSION.length) : name
  return stripped.length > 0 ? stripped : 'Page-1'
}

/** A workspace-relative directory string with forward slashes. */
export function relativeDirectory(root, absolute) {
  const rel = relative(root, absolute)
  return rel.split(sep).join('/')
}
