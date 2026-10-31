/**
 * Workspace path policy for every file the panel and the tool touch.
 *
 * The panel is a browser surface and the tool is model-driven, so neither is a
 * trusted source of paths. Both funnel through this module: a request names a
 * `.drawio` file, it resolves against one of the registered workspace roots, and
 * anything outside those roots — or anything that is not a diagram file — is
 * refused with a reason instead of being silently clamped.
 *
 * @module @sorarisu/dsh-drawio/lib/paths
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'

/** The extension every editable diagram carries. */
export const DIAGRAM_EXTENSION = '.drawio'

/** Whether `candidate` is inside `root`, using segment-aware comparison. */
export function isInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Whether a filename is a diagram this plugin manages. */
export function isDiagramFile(name) {
  return String(name ?? '').toLowerCase().endsWith(DIAGRAM_EXTENSION)
}

/** A user-facing refusal with a stable reason, thrown for both callers. */
export class PathPolicyError extends Error {
  /**
   * @param {string} message - what was refused, in the user's language.
   * @param {'outside-workspace' | 'not-a-diagram' | 'unresolvable' | 'too-large'} code
   */
  constructor(message, code) {
    super(message)
    this.name = 'PathPolicyError'
    this.code = code
  }
}

/**
 * Resolve a requested path against the allowed roots.
 *
 * @param {string} requested - absolute, or relative to `baseDir`.
 * @param {object} options
 * @param {string[]} options.roots - workspace roots that may be written.
 * @param {string} [options.baseDir] - directory a relative request resolves against.
 * @param {boolean} [options.mustBeDiagram] - require the diagram extension.
 * @returns {string} the absolute path.
 * @throws {PathPolicyError} when the request escapes every root or names another kind of file.
 */
export function resolveDiagramPath(requested, options) {
  const raw = String(requested ?? '').trim()
  if (raw.length === 0) throw new PathPolicyError('路径为空：请给出一个 .drawio 文件路径。', 'unresolvable')
  const base = options.baseDir === undefined ? process.cwd() : options.baseDir
  const target = resolve(base, raw)
  const roots = Array.isArray(options.roots) ? options.roots.filter((root) => typeof root === 'string' && root.length > 0) : []
  if (roots.length > 0 && !roots.some((root) => isInside(root, target))) {
    throw new PathPolicyError(`路径 "${raw}" 不在任何已注册的工作区内，已拒绝。`, 'outside-workspace')
  }
  if (options.mustBeDiagram !== false && !isDiagramFile(target)) {
    throw new PathPolicyError(`只能读写 ${DIAGRAM_EXTENSION} 文件，收到的是 "${raw}"。`, 'not-a-diagram')
  }
  return target
}

/**
 * The workspace roots this profile exposes, tolerating a composition without a
 * workspace registry by falling back to the given default.
 *
 * @param {{ get?: (name: string) => unknown }} ctx - a Cordis context or any object with `get`.
 * @param {string} fallback - directory used when no workspace is registered.
 * @returns {string[]} absolute roots.
 */
export function workspaceRoots(ctx, fallback) {
  const registry = typeof ctx?.get === 'function' ? ctx.get('workspaceRegistry') : undefined
  const roots = []
  if (registry !== undefined && typeof registry.list === 'function') {
    for (const workspace of registry.list()) {
      const path = workspace?.path
      if (typeof path === 'string' && path.length > 0) roots.push(resolve(path))
    }
  }
  if (roots.length === 0 && typeof fallback === 'string' && fallback.length > 0) roots.push(resolve(fallback))
  return [...new Set(roots)]
}

/** A path shown to the model and the panel: workspace-relative when possible. */
export function displayPath(absolute, roots) {
  for (const root of roots) {
    if (isInside(root, absolute)) {
      const rel = relative(root, absolute)
      return rel.length === 0 ? root : rel.split(sep).join('/')
    }
  }
  return absolute
}
