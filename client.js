/**
 * @sorarisu/dsh-drawio — Client half.
 *
 * Registers two things in the Harness Web UI:
 * - a `sidebar.panellist` entry, so the 图表 panel appears among the sidebar icons;
 * - a `main` panel keyed `drawio`, which lists the workspace's `.drawio` files,
 *   previews the selected one, and embeds draw.io's own editor for it.
 *
 * The editor is draw.io's official embed mode (`embed=1&proto=json`): the panel
 * posts the diagram in, draws nothing itself, and receives the document back on
 * every save. Nothing is uploaded — in embed mode the editor has no storage and
 * the data stays between this page and the Host's own routes.
 *
 * @module @sorarisu/dsh-drawio/client
 */
window.__ModuleLoader__.load({
  id: '@sorarisu/dsh-drawio',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** Locale namespace owned by this plugin. */
    const NS = '@sorarisu/dsh-drawio'

    /** The Host routes this panel calls. */
    const API = '/api/sorarisu/dsh-drawio'

    /** The id of the main panel and of its sidebar entry; they must match. */
    const PANEL_ID = 'drawio'

    /** Sidebar position: after the shipped plugin/schedule icons. */
    const PANEL_ORDER = 40

    /** Copy, registered as one namespace so both locales stay in step. */
    const ZH = {
      'panel.title': '图表',
      'list.title': '图表文件',
      'list.empty': '工作区里还没有 .drawio 文件。让 DeepSeek 画一个，或点「新建」。',
      'list.loading': '正在读取…',
      'list.error': '读取文件列表失败',
      'list.retry': '重试',
      'action.new': '新建',
      'action.refresh': '刷新',
      'action.save': '保存',
      'action.saved': '已保存',
      'action.saving': '保存中…',
      'action.open': '在 draw.io 中打开',
      'action.export': '导出 SVG',
      'action.close': '关闭编辑器',
      'editor.loading': '正在载入 draw.io 编辑器…',
      'editor.failed': '编辑器没能载入（可能是网络问题）。可以先看下面的预览图，或在新窗口打开。',
      'empty.headline': '选一个文件开始',
      'empty.body': '左边列表里挑一个 .drawio 文件，这里会显示预览和编辑器。',
      'new.prompt': '新文件名（不含扩展名）',
      'new.default': '未命名图表',
      'unsaved': '有未保存的修改',
    }

    const EN = {
      'panel.title': 'Diagrams',
      'list.title': 'Diagram files',
      'list.empty': 'No .drawio file in this workspace yet. Ask DeepSeek for one, or press New.',
      'list.loading': 'Loading…',
      'list.error': 'Could not read the file list',
      'list.retry': 'Retry',
      'action.new': 'New',
      'action.refresh': 'Refresh',
      'action.save': 'Save',
      'action.saved': 'Saved',
      'action.saving': 'Saving…',
      'action.open': 'Open in draw.io',
      'action.export': 'Export SVG',
      'action.close': 'Close editor',
      'editor.loading': 'Loading the draw.io editor…',
      'editor.failed': 'The editor could not load (likely a network issue). Use the preview below or open it in a new window.',
      'empty.headline': 'Pick a file to start',
      'empty.body': 'Choose a .drawio file on the left; its preview and editor appear here.',
      'new.prompt': 'New file name (without extension)',
      'new.default': 'untitled-diagram',
      'unsaved': 'Unsaved changes',
    }

    /** Stylesheet, token-only so it follows the host theme. */
    const CSS = `
.dshdrawio_main{box-sizing:border-box;height:100%;min-height:0;display:flex;flex-direction:column;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.dshdrawio_head{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:0.5px solid var(--dsw-alias-border-l1);flex:none}
.dshdrawio_headTitle{font-size:13px;font-weight:600;margin-right:auto;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdrawio_body{flex:1;min-height:0;display:flex}
.dshdrawio_list{width:236px;flex:none;border-right:0.5px solid var(--dsw-alias-border-l1);overflow-y:auto;padding:6px}
.dshdrawio_listHead{font-size:11px;color:var(--dsw-alias-label-secondary);padding:6px 8px 4px}
.dshdrawio_row{display:flex;flex-direction:column;gap:2px;width:100%;text-align:left;padding:7px 8px;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:inherit}
.dshdrawio_row:hover{background:var(--dsw-alias-bg-layer-2)}
.dshdrawio_row[data-active="true"]{background:var(--dsw-alias-bg-layer-2);box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.dshdrawio_rowName{font-size:12.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdrawio_rowMeta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdrawio_stage{flex:1;min-width:0;min-height:0;display:flex;flex-direction:column;position:relative;background:var(--dsw-alias-bg-layer-1)}
.dshdrawio_toolbar{display:flex;align-items:center;gap:6px;padding:6px 10px;border-bottom:0.5px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap}
.dshdrawio_btn{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;font:inherit;font-size:12px;border-radius:6px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer}
.dshdrawio_btn:hover{background:var(--dsw-alias-bg-overlay)}
.dshdrawio_btn:disabled{opacity:.5;cursor:default}
.dshdrawio_btnPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff}
.dshdrawio_btnPrimary:hover{background:var(--dsw-alias-brand-primary);opacity:.92}
.dshdrawio_hint{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:auto}
.dshdrawio_dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);display:inline-block;margin-right:4px}
.dshdrawio_frameWrap{flex:1;min-height:0;position:relative;background:var(--dsw-alias-bg-base)}
.dshdrawio_frame{width:100%;height:100%;border:0;display:block;background:#fff}
.dshdrawio_overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-base)}
.dshdrawio_preview{position:absolute;inset:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:16px;background:var(--dsw-alias-bg-base)}
.dshdrawio_preview img{max-width:100%;height:auto;border:0.5px solid var(--dsw-alias-border-l1);border-radius:6px;background:#fff}
.dshdrawio_empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--dsw-alias-label-secondary);padding:32px;text-align:center}
.dshdrawio_emptyTitle{font-size:14px;color:var(--dsw-alias-label-primary)}
.dshdrawio_error{color:var(--dsw-alias-state-error-primary);font-size:12px;padding:6px 10px}
.dshdrawio_small{font-size:11px;color:var(--dsw-alias-label-secondary)}
`

    /** The panel's icon in the sidebar rail. */
    function PanelIcon(props) {
      const size = props && typeof props.size === 'number' ? props.size : 16
      return h(
        'svg',
        {
          viewBox: '0 0 16 16',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.3,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          focusable: false,
        },
        h('rect', { x: 1.5, y: 2.5, width: 5, height: 4, rx: 1 }),
        h('rect', { x: 9.5, y: 2.5, width: 5, height: 4, rx: 1 }),
        h('rect', { x: 5.5, y: 9.5, width: 5, height: 4, rx: 1 }),
        h('path', { d: 'M4 6.5v1.5h8V6.5' }),
        h('path', { d: 'M8 8v1.5' }),
      )
    }

    /** JSON fetch with the plugin's own error shape. */
    async function callApi(path, init) {
      const response = await fetch(`${API}${path}`, {
        ...init,
        headers: { ...(init && init.headers ? init.headers : {}) },
      })
      const text = await response.text()
      let payload
      try {
        payload = text.length > 0 ? JSON.parse(text) : {}
      } catch {
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`)
      }
      if (!response.ok || payload.ok === false) throw new Error(payload.error ?? `HTTP ${response.status}`)
      return payload
    }

    /** Format a byte size for the file list. */
    function formatBytes(bytes) {
      if (!Number.isFinite(bytes)) return ''
      if (bytes < 1024) return `${bytes} B`
      if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
      return `${(bytes / 1024 / 1024).toFixed(1)} MB`
    }

    /** The draw.io embed URL for one editor mount. */
    function editorUrl(embedOrigin, dark) {
      const params = new URLSearchParams({
        embed: '1',
        proto: 'json',
        spin: '1',
        libraries: '1',
        ui: 'atlas',
        configure: '1',
        noSaveBtn: '0',
        saveAndExit: '0',
        modified: '1',
      })
      if (dark) params.set('dark', '1')
      return `${embedOrigin}/?${params.toString()}`
    }

    /**
     * The embedded draw.io editor for one document.
     *
     * The iframe protocol is draw.io's: it emits `init`, this component answers
     * with `load`; it emits `autosave`/`save` with the new XML, which is handed
     * to `onChange`. The message origin and source are both checked, so no other
     * frame or page can push a document into this editor.
     */
    function DrawioEditor(props) {
      const { embedOrigin, xml, title, dark, onDirty, onError } = props
      const frameRef = React.useRef(null)
      const [status, setStatus] = React.useState('loading')
      // Bumped by the retry button so the effect below subscribes again.
      const [attempt, setAttempt] = React.useState(0)
      const xmlRef = React.useRef(xml)
      xmlRef.current = xml

      React.useEffect(() => {
        // Defensive only: React attaches this ref before passive effects run, so
        // a mounted editor always has its frame here.
        const frame = frameRef.current
        if (frame === null || frame === undefined) return undefined
        const expectedOrigin = embedOrigin
        const onMessage = (event) => {
          if (event.origin !== expectedOrigin) return
          if (frame.contentWindow === null || event.source !== frame.contentWindow) return
          if (typeof event.data !== 'string' || event.data.length === 0) return
          let message
          try {
            message = JSON.parse(event.data)
          } catch {
            return
          }
          if (message.event === 'init') {
            setStatus('ready')
            frame.contentWindow.postMessage(
              JSON.stringify({ action: 'load', xml: xmlRef.current, autosave: 1, title: title ?? 'diagram.drawio' }),
              expectedOrigin,
            )
            return
          }
          if (message.event === 'load') {
            setStatus('ready')
            return
          }
          if (message.event === 'autosave' || message.event === 'save') {
            if (typeof message.xml === 'string' && message.xml.length > 0) onDirty(message.xml)
            return
          }
          if (message.event === 'error') {
            onError(typeof message.message === 'string' ? message.message : 'draw.io reported an error')
          }
        }
        window.addEventListener('message', onMessage)
        const timeout = window.setTimeout(() => {
          setStatus((current) => (current === 'ready' ? current : 'failed'))
        }, 15000)
        return () => {
          window.clearTimeout(timeout)
          window.removeEventListener('message', onMessage)
        }
      }, [embedOrigin, onDirty, onError, title, attempt])

      return h(
        React.Fragment,
        null,
        h('iframe', {
          ref: frameRef,
          className: 'dshdrawio_frame',
          src: editorUrl(embedOrigin, dark),
          title: title ?? 'draw.io',
          allow: 'clipboard-write',
          referrerPolicy: 'no-referrer',
        }),
        status === 'loading' &&
          h('div', { className: 'dshdrawio_overlay' }, h('span', null, props.t('editor.loading'))),
        status === 'failed' &&
          h(
            'div',
            { className: 'dshdrawio_overlay' },
            h('span', null, props.t('editor.failed')),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdrawio_btn',
                onClick: () => {
                  setStatus('loading')
                  setAttempt((value) => value + 1)
                },
              },
              props.t('list.retry'),
            ),
          ),
      )
    }

    /**
     * One panel instance: file list, toolbar, editor, and preview.
     *
     * State lives here rather than in a store because the panel is a single
     * workspace surface; the files themselves are the source of truth, and the
     * list is re-read from the Host whenever it could have changed.
     */
    function DrawioPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [files, setFiles] = React.useState([])
      const [listError, setListError] = React.useState(null)
      const [listLoading, setListLoading] = React.useState(true)
      const [config, setConfig] = React.useState(null)
      const [active, setActive] = React.useState(null)
      // Named `xmlDoc`, never `document`: a state variable called `document`
      // shadows the DOM global inside this component and silently breaks it.
      const [xmlDoc, setXmlDoc] = React.useState(null)
      const [draft, setDraft] = React.useState(null)
      const [dirty, setDirty] = React.useState(false)
      const [saveState, setSaveState] = React.useState('idle')
      const [docError, setDocError] = React.useState(null)
      const [editorOpen, setEditorOpen] = React.useState(false)
      const [previewKey, setPreviewKey] = React.useState(0)
      const [dark, setDark] = React.useState(false)

      const refreshList = React.useCallback(async () => {
        setListLoading(true)
        setListError(null)
        try {
          const payload = await callApi('/list?recursive=1')
          setFiles(Array.isArray(payload.files) ? payload.files : [])
        } catch (error) {
          setListError(error instanceof Error ? error.message : String(error))
        } finally {
          setListLoading(false)
        }
      }, [])

      const openFile = React.useCallback(async (path) => {
        setDocError(null)
        setXmlDoc(null)
        setDraft(null)
        setDirty(false)
        setEditorOpen(false)
        try {
          const payload = await callApi(`/document?path=${encodeURIComponent(path)}`)
          setActive({ path: payload.path, absolutePath: payload.absolutePath, ...payload.summary })
          setXmlDoc(payload.xml)
          setPreviewKey((key) => key + 1)
        } catch (error) {
          setDocError(error instanceof Error ? error.message : String(error))
        }
      }, [])

      React.useEffect(() => {
        let cancelled = false
        void callApi('/config')
          .then((payload) => {
            if (cancelled) return
            setConfig(payload)
          })
          .catch(() => {
            if (cancelled) return
            setConfig({ embedOrigin: 'https://embed.diagrams.net' })
          })
        void refreshList()
        return () => {
          cancelled = true
        }
      }, [refreshList])

      // Follow the host's light/dark preference by reading the token the theme
      // plugin sets; the editor iframe paints its own canvas, so it needs the flag.
      React.useEffect(() => {
        if (typeof globalThis.document === 'undefined' || typeof MutationObserver === 'undefined') return undefined
        const read = () => {
          const root = globalThis.document.documentElement
          if (root === null || root === undefined) return
          const scheme = typeof getComputedStyle === 'function' ? getComputedStyle(root).colorScheme : ''
          setDark(scheme === 'dark' || root.getAttribute('data-theme') === 'dark' || globalThis.document.body?.dataset.theme === 'dark')
        }
        read()
        const observer = new MutationObserver(read)
        observer.observe(globalThis.document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme', 'style'] })
        return () => observer.disconnect()
      }, [])

      const save = React.useCallback(async () => {
        if (draft === null || active === null) return
        setSaveState('saving')
        try {
          await callApi('/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ path: active.path, xml: draft }),
          })
          setXmlDoc(draft)
          setDirty(false)
          setSaveState('saved')
          setPreviewKey((key) => key + 1)
          window.setTimeout(() => setSaveState('idle'), 1800)
        } catch (error) {
          setSaveState('idle')
          setDocError(error instanceof Error ? error.message : String(error))
        }
      }, [draft, active])

      const createFile = React.useCallback(async () => {
        const name = window.prompt(t('new.prompt'), t('new.default'))
        if (name === null) return
        const trimmed = name.trim()
        if (trimmed.length === 0) return
        const path = trimmed.toLowerCase().endsWith('.drawio') ? trimmed : `${trimmed}.drawio`
        try {
          await callApi('/save', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              path,
              xml: [
                '<mxfile host="sorarisu/dsh-drawio">',
                `  <diagram id="page-1" name="${trimmed.replace(/[<>&"]/gu, '')}">`,
                '    <mxGraphModel dx="0" dy="0" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="0" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0"><root><mxCell id="0"/><mxCell id="1" parent="0"/></root></mxGraphModel>',
                '  </diagram>',
                '</mxfile>',
              ].join('\n'),
            }),
          })
          await refreshList()
          await openFile(path)
        } catch (error) {
          setDocError(error instanceof Error ? error.message : String(error))
        }
      }, [openFile, refreshList, t])

      const markDirty = React.useCallback((nextXml) => {
        setDraft(nextXml)
        setDirty(true)
      }, [])

      const onEditorError = React.useCallback((message) => {
        setDocError(message)
      }, [])

      const rows = files.map((file) => {
        const name = file.name ?? file.path
        const isActive = active !== null && active.path === file.path
        return h(
          'button',
          {
            key: file.path,
            type: 'button',
            className: 'dshdrawio_row',
            'data-active': isActive ? 'true' : 'false',
            onClick: () => {
              if (isActive) return
              void openFile(file.path)
            },
            title: file.path,
          },
          h('span', { className: 'dshdrawio_rowName' }, name),
          h('span', { className: 'dshdrawio_rowMeta' }, `${formatBytes(file.bytes)} · ${String(file.path).includes('/') ? String(file.path) : ''}`),
        )
      })

      const stage = (() => {
        if (docError !== null) {
          return h(
            'div',
            { className: 'dshdrawio_empty' },
            h('span', { className: 'dshdrawio_error' }, docError),
            h(
              'button',
              { type: 'button', className: 'dshdrawio_btn', onClick: () => (active === null ? refreshList() : openFile(active.path)) },
              t('list.retry'),
            ),
          )
        }
        if (active === null) {
          return h(
            'div',
            { className: 'dshdrawio_empty' },
            h('span', { className: 'dshdrawio_emptyTitle' }, t('empty.headline')),
            h('span', null, t('empty.body')),
          )
        }
        if (xmlDoc === null) {
          return h('div', { className: 'dshdrawio_empty' }, h('span', null, t('list.loading')))
        }
        return h(
          React.Fragment,
          null,
          h(
            'div',
            { className: 'dshdrawio_toolbar' },
            h(
              'button',
              {
                type: 'button',
                className: 'dshdrawio_btn',
                onClick: () => setEditorOpen((open) => !open),
              },
              editorOpen ? t('action.close') : t('action.open'),
            ),
            h(
              'button',
              {
                type: 'button',
                className: 'dshdrawio_btn dshdrawio_btnPrimary',
                disabled: !dirty || saveState === 'saving',
                onClick: () => void save(),
              },
              saveState === 'saving' ? t('action.saving') : saveState === 'saved' ? t('action.saved') : t('action.save'),
            ),
            h(
              'a',
              {
                className: 'dshdrawio_btn',
                href: `${API}/preview?path=${encodeURIComponent(active.path)}&v=${previewKey}`,
                download: `${String(active.path).split('/').pop().replace(/\.drawio$/iu, '')}.svg`,
                target: '_blank',
                rel: 'noreferrer',
              },
              t('action.export'),
            ),
            h(
              'button',
              { type: 'button', className: 'dshdrawio_btn', onClick: () => openFile(active.path) },
              t('action.refresh'),
            ),
            h(
              'span',
              { className: 'dshdrawio_hint' },
              dirty ? h('span', { className: 'dshdrawio_dot' }) : null,
              dirty ? t('unsaved') : `${active.path}`,
            ),
          ),
          h(
            'div',
            { className: 'dshdrawio_frameWrap' },
            editorOpen
              ? h(DrawioEditor, {
                  embedOrigin: config?.embedOrigin ?? 'https://embed.diagrams.net',
                  xml: xmlDoc,
                  title: `${active.path}`,
                  dark,
                  t,
                  onDirty: markDirty,
                  onError: onEditorError,
                })
              : h(
                  'div',
                  { className: 'dshdrawio_preview' },
                  h('img', {
                    key: previewKey,
                    src: `${API}/preview?path=${encodeURIComponent(active.path)}&v=${previewKey}`,
                    alt: `${active.path}`,
                  }),
                ),
          ),
        )
      })()

      return h(
        'div',
        { className: 'dshdrawio_main' },
        h(
          'div',
          { className: 'dshdrawio_head' },
          h('span', { className: 'dshdrawio_headTitle' }, t('panel.title')),
          h(
            'button',
            { type: 'button', className: 'dshdrawio_btn', onClick: () => void refreshList() },
            t('action.refresh'),
          ),
          h('button', { type: 'button', className: 'dshdrawio_btn dshdrawio_btnPrimary', onClick: () => void createFile() }, t('action.new')),
        ),
        h(
          'div',
          { className: 'dshdrawio_body' },
          h(
            'div',
            { className: 'dshdrawio_list' },
            h('div', { className: 'dshdrawio_listHead' }, t('list.title')),
            listLoading && files.length === 0 ? h('div', { className: 'dshdrawio_small', style: { padding: '6px 8px' } }, t('list.loading')) : null,
            listError !== null
              ? h(
                  'div',
                  { style: { padding: '6px 8px' } },
                  h('div', { className: 'dshdrawio_error' }, t('list.error')),
                  h('div', { className: 'dshdrawio_small' }, listError),
                  h('button', { type: 'button', className: 'dshdrawio_btn', onClick: () => void refreshList() }, t('list.retry')),
                )
              : null,
            !listLoading && listError === null && rows.length === 0
              ? h('div', { className: 'dshdrawio_small', style: { padding: '6px 8px' } }, t('list.empty'))
              : null,
            rows,
          ),
          h('div', { className: 'dshdrawio_stage' }, stage),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'sorarisu-dsh-drawio: dictionaries')
        // `bind` returns the same function per namespace, so `t` can ride the
        // inject face without breaking the slot registry's memoization.
        const t = ctx.locale.bind(NS)

        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            {
              name: 'sidebar.panellist',
              id: PANEL_ID,
              order: PANEL_ORDER,
              label: () => t('panel.title'),
              locale: NS,
              inject: () => ({ t }),
            },
            PanelIcon,
          ),
        )

        // `inject` runs when the declaration appears and is disposed when it
        // collapses, so one registration follows the panel's lifetime.
        ctx.slots.inject('main', () => {
          return ctx.slots.register(
            {
              name: 'main',
              key: PANEL_ID,
              locale: NS,
              inject: () => ({ t }),
            },
            DrawioPanel,
          )
        })
      },
    }
  },
})
