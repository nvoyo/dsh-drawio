/**
 * @sorarisu/dsh-drawio — Host half.
 *
 * Two capabilities over one storage layer:
 * - a `drawio` model tool, so the agent writes and edits `.drawio` diagrams as
 *   ordinary workspace files;
 * - HTTP routes behind the sidebar panel, whose embedded draw.io editor saves
 *   back into the same files.
 *
 * Everything local: the editor is the only remote part, it is the document
 * component draw.io publishes for embedding, and the diagram data never leaves
 * the browser and this Host.
 *
 * @module @sorarisu/dsh-drawio
 */
import { DiagramStore } from './lib/store.js'
import { registerRoutes } from './lib/routes.js'
import { registerDrawioTool } from './lib/tool.js'
import { workspaceRoots } from './lib/paths.js'

/** Stable Loader identity. */
export const name = '@sorarisu/dsh-drawio'

/** Services this plugin needs before it can serve anything. */
export const inject = ['tools', 'webServer']

/** The draw.io embed origin the panel's iframe is allowed to load. */
const DEFAULT_EMBED_ORIGIN = 'https://embed.diagrams.net'

/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/api/sorarisu/dsh-drawio'

/**
 * Minimal validated configuration.
 *
 * Kept as a plain validator rather than a schema library so the plugin loads in
 * any composition that provides `tools` and `webServer`, without depending on a
 * package the profile may not resolve.
 *
 * @param {Record<string, unknown>} raw - the Loader row's `config`.
 */
export function normalizeConfig(raw) {
  const config = raw !== null && typeof raw === 'object' ? raw : {}
  const rootDir = typeof config.rootDir === 'string' && config.rootDir.length > 0 ? config.rootDir : process.cwd()
  const maxDocumentBytes = Number.isFinite(config.maxDocumentBytes) ? Number(config.maxDocumentBytes) : 8 * 1024 * 1024
  const embedOrigin = typeof config.embedOrigin === 'string' && config.embedOrigin.length > 0 ? config.embedOrigin : DEFAULT_EMBED_ORIGIN
  return { rootDir, maxDocumentBytes, embedOrigin }
}

/**
 * Mount the tool, the routes, and the workspace-root sync.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} rawConfig
 * @returns {() => void} teardown for everything registered here.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const roots = workspaceRoots(ctx, config.rootDir)
  const store = new DiagramStore({ roots, maxBytes: config.maxDocumentBytes })
  const logger = { warn: (message) => ctx.logger?.warn?.(message) }

  // The workspace registry can gain a workspace while the Host runs; the store
  // must follow it, or the panel would refuse a folder the user just added.
  const syncRoots = () => {
    store.setRoots(workspaceRoots(ctx, config.rootDir))
  }
  const registry = ctx.get('workspaceRegistry')
  const offRegistry =
    registry !== undefined && typeof registry.on === 'function'
      ? registry.on('change', syncRoots)
      : typeof registry !== 'undefined' && typeof registry.subscribe === 'function'
        ? registry.subscribe(syncRoots)
        : () => {}
  ctx.effect(() => () => offRegistry(), 'sorarisu-dsh-drawio: workspace roots')

  registerDrawioTool(ctx, { store, logger })

  const disposers = registerRoutes(ctx, {
    store,
    prefix: ROUTE_PREFIX,
    embedOrigin: config.embedOrigin,
    logger,
  })
  ctx.effect(
    () => () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose()
        } catch (error) {
          logger.warn(`route disposal failed: ${String(error)}`)
        }
      }
    },
    'sorarisu-dsh-drawio: routes',
  )

  // Tell the model the convention once, so it opens a diagram instead of
  // inventing an ad-hoc text format for box-and-arrow pictures.
  //
  // `systemPrompt` is optional: it must be read through `ctx.get()`, because a
  // Cordis context is a Proxy that THROWS on an un-injected service rather than
  // returning undefined — so `ctx.systemPrompt?.section?.()` would crash the
  // whole plugin instead of skipping the section.
  const systemPrompt = ctx.get('systemPrompt')
  systemPrompt?.section?.({
    name: '@sorarisu/dsh-drawio',
    order: 40,
    text: [
      'Diagrams: when the user asks for a flowchart, process diagram, org chart, or any box-and-arrow picture,',
      'write a `.drawio` file with the `drawio` tool instead of ASCII art or Mermaid-only text — the user can then',
      'open it in the 图表 panel and move boxes around. Describe nodes and edges; the tool owns ids and layout.',
    ].join(' '),
  })

  return () => {
    syncRoots()
  }
}
