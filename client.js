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

    /** The tool name whose chat card this client renders; must match lib/tool.js. */
    const TOOL_NAME = 'drawio'

    /** Sidebar position: after the shipped plugin/schedule icons. */
    const PANEL_ORDER = 40

    /** Copy, registered as one namespace so both locales stay in step. */
    const ZH = {
      'panel.title': '图表',
      'panel.description': '用 draw.io 画流程图、时序图、组织架构图——模型与您在同一批 .drawio 文件上协作。',
      'panel.subtitle': '未选择文件',
      'preview.failed': '预览加载失败：文件可能已被移动或删除。',
      'stats.engine': '引擎',
      'stats.engineDetail': 'dsh-drawio 插件运行中',
      'stats.files': '图表文件',
      'stats.filesUnit': '份',
      'stats.filesDetail': '递归扫描工作区',
      'stats.active': '当前打开',
      'stats.noneActive': '从左侧列表选择一个文件',
      'stats.roots': '工作区',
      'stats.rootsDetail': '已注册的可写根目录',
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
      'panel.description': 'Flowcharts, sequence diagrams, and org charts with draw.io — the agent and you share one set of .drawio files.',
      'panel.subtitle': 'No file selected',
      'preview.failed': 'Preview failed to load: the file may have moved or been deleted.',
      'stats.engine': 'Engine',
      'stats.engineDetail': 'dsh-drawio plugin running',
      'stats.files': 'Diagram files',
      'stats.filesUnit': '',
      'stats.filesDetail': 'Recursive workspace scan',
      'stats.active': 'Open now',
      'stats.noneActive': 'Pick a file from the list',
      'stats.roots': 'Workspaces',
      'stats.rootsDetail': 'Registered writable roots',
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
.dshdrawio_main{box-sizing:border-box;width:100%;min-height:100%;margin:0 auto;padding:24px 28px 48px;background:
  radial-gradient(1200px 400px at 85% -10%, color-mix(in srgb, var(--dsw-alias-brand-primary) 7%, transparent), transparent 70%),
  var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-size:13px}
.dshdrawio_pageHeader{display:flex;justify-content:space-between;align-items:flex-start;gap:16px 24px;margin-bottom:20px;flex-wrap:wrap}
.dshdrawio_pageHeaderText h2{margin:0;font-size:22px;font-weight:700;line-height:28px;letter-spacing:-0.2px}
.dshdrawio_pageHeaderText p{margin:6px 0 0;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:20px;max-width:60ch}
.dshdrawio_pageHeaderMeta{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.dshdrawio_pageChip{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11.5px;line-height:20px;padding:3px 10px;border-radius:999px;border:0.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdrawio_pageChip[data-warn="true"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
/* overview strip: one shared-border row of stat tiles */
.dshdrawio_healthStrip{display:flex;flex-wrap:wrap;position:relative;overflow:hidden;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;margin-bottom:22px;background:var(--dsw-alias-bg-layer-1)}
.dshdrawio_healthStrip article{box-sizing:border-box;border-top:0.5px solid var(--dsw-alias-border-l2);border-left:0.5px solid var(--dsw-alias-border-l2);flex:1 160px;display:flex;align-items:flex-start;gap:10px;min-width:0;min-height:84px;margin:-0.5px 0 0 -0.5px;padding:16px 18px;transition:background 150ms ease}
.dshdrawio_healthStrip article:hover{background:var(--dsw-alias-bg-layer-2)}
.dshdrawio_healthDot{border-radius:50%;flex:none;width:7px;height:7px;margin-top:6px;background:var(--dsw-alias-state-success-primary);box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-success-primary) 18%, transparent)}
.dshdrawio_healthBody{min-width:0;display:flex;flex-direction:column;gap:3px}
.dshdrawio_healthLabel{font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.9px;color:var(--dsw-alias-label-secondary)}
.dshdrawio_healthValue{font-size:15px;font-weight:650;line-height:22px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdrawio_healthDetail{margin:0;font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* body: list column + stage */
.dshdrawio_body{display:flex;gap:20px;align-items:stretch}
.dshdrawio_list{width:288px;flex:none;display:flex;flex-direction:column;gap:10px;min-width:0}
.dshdrawio_sectionHeading{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:0 4px}
.dshdrawio_sectionTitle{margin:0;font-size:13.5px;font-weight:600;line-height:20px}
.dshdrawio_sectionMeta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdrawio_fileCard{border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;padding:6px;display:flex;flex-direction:column;gap:2px;box-shadow:0 1px 2px rgba(0,0,0,.04)}
.dshdrawio_row{position:relative;display:flex;flex-direction:column;gap:3px;width:100%;text-align:left;padding:10px 14px;border:0;border-radius:8px;background:transparent;color:inherit;cursor:pointer;font:inherit;transition:background 120ms ease}
.dshdrawio_row:hover{background:var(--dsw-alias-bg-layer-2)}
.dshdrawio_row[data-active="true"]{background:var(--dsw-alias-bg-layer-2)}
.dshdrawio_row[data-active="true"]::before{content:'';position:absolute;left:0;top:9px;bottom:9px;width:3px;border-radius:2px;background:var(--dsw-alias-brand-primary)}
.dshdrawio_rowName{font-size:13px;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dshdrawio_row[data-active="true"] .dshdrawio_rowName{color:var(--dsw-alias-brand-primary)}
.dshdrawio_rowMeta{font-size:11px;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* stage card */
.dshdrawio_stage{flex:1;min-width:0;min-height:460px;display:flex;flex-direction:column;position:relative}
.dshdrawio_stageCard{flex:1;display:flex;flex-direction:column;min-height:420px;border:0.5px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.05),0 8px 24px rgba(0,0,0,.05)}
.dshdrawio_toolbar{display:flex;align-items:center;gap:8px;padding:10px 16px;border-bottom:0.5px solid var(--dsw-alias-border-l1);flex:none;flex-wrap:wrap;background:var(--dsw-alias-bg-layer-1)}
.dshdrawio_btn{display:inline-flex;align-items:center;gap:6px;padding:6px 14px;font:inherit;font-size:12.5px;font-weight:550;border-radius:8px;border:0.5px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);cursor:pointer;transition:background 120ms ease,opacity 120ms ease,transform 80ms ease}
.dshdrawio_btn:hover{background:var(--dsw-alias-bg-overlay)}
.dshdrawio_btn:active{transform:translateY(1px)}
.dshdrawio_btn:disabled{opacity:.45;cursor:default}
.dshdrawio_btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}
.dshdrawio_btnPrimary{border-color:transparent;background:var(--dsw-alias-brand-primary);color:#fff;box-shadow:0 1px 2px color-mix(in srgb, var(--dsw-alias-brand-primary) 35%, transparent)}
.dshdrawio_btnPrimary:hover{background:var(--dsw-alias-brand-primary);opacity:.92}
.dshdrawio_hint{font-size:11.5px;color:var(--dsw-alias-label-secondary);margin-left:auto;display:inline-flex;align-items:center;gap:5px;min-width:0;overflow:hidden}
.dshdrawio_dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-warn-primary);display:inline-block;flex:none;box-shadow:0 0 0 3px color-mix(in srgb, var(--dsw-alias-state-warn-primary) 18%, transparent)}
.dshdrawio_frameWrap{flex:1;min-height:0;position:relative;background:
  linear-gradient(180deg, color-mix(in srgb, var(--dsw-alias-bg-layer-2) 55%, var(--dsw-alias-bg-base)), var(--dsw-alias-bg-base));}
.dshdrawio_frame{width:100%;height:100%;border:0;display:block;background:#fff}
.dshdrawio_overlay{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;padding:24px;text-align:center;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1)}
.dshdrawio_preview{flex:1;min-height:0;overflow:auto;display:flex;align-items:flex-start;justify-content:center;padding:24px;background:var(--dsw-alias-bg-base)}
.dshdrawio_canvas{max-width:100%;border-radius:12px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.08),0 8px 28px rgba(0,0,0,.07);overflow:hidden}
.dshdrawio_canvas img,.dshdrawio_canvas svg{display:block;width:100%;height:auto}
.dshdrawio_empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--dsw-alias-label-secondary);padding:40px;text-align:center}
.dshdrawio_emptyGlyph{font-size:40px;opacity:.4;line-height:1}
.dshdrawio_emptyTitle{font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary)}
.dshdrawio_error{color:var(--dsw-alias-state-error-primary);font-size:12.5px;padding:6px 10px}
.dshdrawio_small{font-size:11.5px;color:var(--dsw-alias-label-secondary)}
/* chat-side inline preview */
.dshdrawio_chat{border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);max-width:640px;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.dshdrawio_chatHead{display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:0.5px solid var(--dsw-alias-border-l1);font-size:12px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dshdrawio_chatHeadTitle{font-weight:600;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdrawio_chatMeta{margin-left:auto;flex:none;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}
.dshdrawio_chatBody{background:#fff;display:flex;justify-content:center}
.dshdrawio_chatBody img,.dshdrawio_chatBody svg{display:block;width:100%;height:auto;max-height:420px;object-fit:contain}
.dshdrawio_chatFoot{display:flex;gap:10px;padding:8px 14px;border-top:0.5px solid var(--dsw-alias-border-l1);font-size:11.5px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-2)}
.dshdrawio_chatLink{color:var(--dsw-alias-brand-primary);text-decoration:none;cursor:pointer;background:none;border:0;font:inherit;padding:0}
.dshdrawio_chatLink:hover{text-decoration:underline}
/* right-sidebar tab body */
.dshdrawio_right{box-sizing:border-box;height:100%;min-height:0;overflow:auto;padding:14px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.dshdrawio_rightTitle{font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dshdrawio_rightCard{border:0.5px solid var(--dsw-alias-border-l1);border-radius:12px;overflow:hidden;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.06)}
.dshdrawio_rightCard img,.dshdrawio_rightCard svg{display:block;width:100%;height:auto}
.dshdrawio_rightEmpty{color:var(--dsw-alias-label-secondary);font-size:12px;padding:16px;text-align:center;border:0.5px dashed var(--dsw-alias-border-l2);border-radius:12px}
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
        // NO `configure=1`: the editor then blocks on a `configure` handshake
        // before even sending `init`, and this host has no custom config to
        // give — the editor would wait forever (this is what stuck the panel).
        // Also no `modified`/`noSaveBtn`/`saveAndExit`: the load action carries
        // its own controls, and URL params there only add stale-state risk.
        saveAndExit: '1',
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
          if (message.event === 'configure') {
            // Only reachable if someone re-enables `configure=1`: never leave
            // the editor waiting, answer with the minimal empty config.
            frame.contentWindow.postMessage(JSON.stringify({ action: 'configure', config: {} }), expectedOrigin)
            return
          }
          if (message.event === 'init') {
            setStatus('ready')
            frame.contentWindow.postMessage(
              JSON.stringify({
                action: 'load',
                xml: xmlRef.current,
                autosave: 1,
                title: title ?? 'diagram.drawio',
                // Fit the diagram into the visible area on open, so large
                // diagrams land readable instead of zoomed into a corner.
                fit: 1,
                maxFitScale: 2,
              }),
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
      const [imgFailed, setImgFailed] = React.useState(false)

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
        setImgFailed(false)
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

      // Overview strip: the same "shared-border stat tiles" pattern the host
      // settings pages use (one bordered row, tiles separated by inner rules).
      const totalBytes = files.reduce((sum, file) => sum + (Number.isFinite(file.bytes) ? file.bytes : 0), 0)
      const diagramsMeta = listLoading && files.length === 0
        ? t('list.loading')
        : `${files.length} ${t('stats.filesUnit')} · ${formatBytes(totalBytes)}`
      const storageMeta = (config?.roots ?? []).length > 0 ? (config?.roots ?? []).map((root) => String(root).split('/').pop() || root).join(', ') : '—'
      const overviewTiles = [
        { key: 'engine', label: 'dsh-drawio', value: '0.1.0', detail: t('stats.engineDetail') },
        { key: 'files', label: t('stats.files'), value: diagramsMeta, detail: t('stats.filesDetail') },
        { key: 'active', label: t('stats.active'), value: active === null ? '—' : String(active.path).split('/').pop(), detail: active === null ? t('stats.noneActive') : active.path },
        { key: 'roots', label: t('stats.roots'), value: String((config?.roots ?? []).length), detail: storageMeta },
      ]

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
                  h(
                    'div',
                    { className: 'dshdrawio_canvas' },
                    imgFailed
                      ? h(
                          'div',
                          { className: 'dshdrawio_empty' },
                          h('span', { className: 'dshdrawio_error' }, t('preview.failed')),
                          h('span', { className: 'dshdrawio_small' }, `${active.path}`),
                        )
                      : h('img', {
                          key: previewKey,
                          src: `${API}/preview?path=${encodeURIComponent(active.path)}&v=${previewKey}`,
                          alt: `${active.path}`,
                          onLoad: () => setImgFailed(false),
                          onError: () => setImgFailed(true),
                        }),
                  ),
                ),
          ),
        )
      })()

      // Canvas meta line mirrors the host pages' `code` chip in the page header.
      const canvasMeta = dirty ? t('unsaved') : active === null ? t('panel.subtitle') : `${active.path}`
      return h(
        'div',
        { className: 'dshdrawio_main' },
        // Page header: title + description on the left, actions on the right.
        h(
          'div',
          { className: 'dshdrawio_pageHeader' },
          h(
            'div',
            { className: 'dshdrawio_pageHeaderText' },
            h('h2', { className: 'dshdrawio_pageTitle' }, t('panel.title')),
            h('p', { className: 'dshdrawio_pageDescription' }, t('panel.description')),
          ),
          h(
            'div',
            { className: 'dshdrawio_pageHeaderMeta' },
            h('code', { className: 'dshdrawio_pageChip', 'data-warn': dirty ? 'true' : 'false' }, canvasMeta),
            h(
              'button',
              { type: 'button', className: 'dshdrawio_btn', onClick: () => void refreshList() },
              t('action.refresh'),
            ),
            h('button', { type: 'button', className: 'dshdrawio_btn dshdrawio_btnPrimary', onClick: () => void createFile() }, t('action.new')),
          ),
        ),
        // Overview strip: shared border, inner rules between tiles.
        h(
          'div',
          { className: 'dshdrawio_healthStrip' },
          overviewTiles.map((tile) =>
            h(
              'article',
              { key: tile.key, title: tile.detail },
              h('span', { className: 'dshdrawio_healthDot' }),
              h(
                'div',
                { className: 'dshdrawio_healthBody' },
                h('small', { className: 'dshdrawio_healthLabel' }, tile.label),
                h('strong', { className: 'dshdrawio_healthValue' }, tile.value),
                h('p', { className: 'dshdrawio_healthDetail' }, tile.detail),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dshdrawio_body' },
          // File list as one rounded card column, mnemon-style.
          h(
            'div',
            { className: 'dshdrawio_list' },
            h(
              'div',
              { className: 'dshdrawio_sectionHeading' },
              h('h3', { className: 'dshdrawio_sectionTitle' }, t('list.title')),
              h('span', { className: 'dshdrawio_sectionMeta' }, t('stats.filesDetail')),
            ),
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
              ? h('div', { className: 'dshdrawio_small', style: { padding: '10px 12px' } }, t('list.empty'))
              : null,
            h('div', { className: 'dshdrawio_fileCard' }, rows),
          ),
          h('div', { className: 'dshdrawio_stage' }, h('div', { className: 'dshdrawio_stageCard' }, stage)),
        ),
      )
    }

    /**
     * The result text of a settled call, when it is exactly one text block —
     * the same rule the host's generic card uses.
     */
    function singleResultText(block) {
      if (block === undefined || !Array.isArray(block.content) || block.content.length !== 1) return undefined
      const only = block.content[0]
      return only !== null && typeof only === 'object' && only.type === 'text' ? only.text : undefined
    }

    /**
     * Which path a `drawio` tool call touched, read out of the result block.
     *
     * The tool renders its own result text; the first line is
     * `<action> → <path>` for mutations and `read → <path>` otherwise. Rather
     * than parse display text, pull `path` straight from the rendered envelope:
     * the tool result content is the rendered text, so parse the envelope tag.
     *
     * @param {object} block - the call's result (or start) block.
     * @returns {{ path: string, action: string } | undefined}
     */
    function drawioCallTarget(block) {
      if (block === undefined || block === null) return undefined
      const parsed = typeof block.call === 'object' && block.call !== null ? block.call : undefined
      const args = parsed !== undefined && typeof parsed.args === 'object' && parsed.args !== null ? parsed.args : undefined
      if (args === undefined || typeof args.path !== 'string' || args.path.length === 0) return undefined
      return { path: args.path, action: typeof args.action === 'string' ? args.action : 'read' }
    }

    /**
     * One draw.io tool call, rendered in the chat as the diagram itself.
     *
     * Replaces the generic tool card for `key: 'drawio'`: while the call runs it
     * shows a placeholder, and once the result settles it shows the SVG preview
     * with a link into the panel.
     */
    function DrawioChatCard(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const block = props.block
      const settled = props.phase === 'result' && block !== undefined && Array.isArray(block.content)
      const target = settled ? drawioCallTarget(block) : undefined
      const resultText = settled ? singleResultText(block) : undefined
      const [previewKey, setPreviewKey] = React.useState(0)
      const [failed, setFailed] = React.useState(false)

      // A settled call whose file exists on disk can be previewed; if the tool
      // errored (isError on the model-facing result), fall back to the text.
      const errored = settled && typeof resultText === 'string' && resultText.length > 0 && !resultText.includes('→')
      const path = target?.path

      React.useEffect(() => {
        if (path === undefined) return undefined
        setFailed(false)
        const controller = new AbortController()
        void fetch(`${API}/preview?path=${encodeURIComponent(path)}`, { signal: controller.signal })
          .then((response) => {
            if (!response.ok) setFailed(true)
          })
          .catch(() => setFailed(true))
        return () => controller.abort()
      }, [path, previewKey])

      if (!settled) {
        return h(
          'div',
          { className: 'dshdrawio_chat' },
          h(
            'div',
            { className: 'dshdrawio_chatHead' },
            h('span', { className: 'dshdrawio_chatHeadTitle' }, t('panel.title')),
            h('span', { className: 'dshdrawio_chatMeta' }, '…'),
          ),
          h('div', { className: 'dshdrawio_chatBody', style: { minHeight: 80, color: '#888', alignItems: 'center', background: 'var(--dsw-alias-bg-layer-1)' } }, h('span', null, '…')),
        )
      }
      if (path === undefined || failed || errored) {
        // Not a file preview we can draw (error, list, delete): show the text.
        return h(
          'div',
          { className: 'dshdrawio_chat' },
          h(
            'div',
            { className: 'dshdrawio_chatHead' },
            h('span', { className: 'dshdrawio_chatHeadTitle' }, `drawio ${target?.action ?? ''}`.trim()),
          ),
          h('div', { className: 'dshdrawio_chatFoot' }, h('span', null, (resultText ?? '').split('\n').slice(0, 6).join('\n'))),
        )
      }
      return h(
        'div',
        { className: 'dshdrawio_chat' },
        h(
          'div',
          { className: 'dshdrawio_chatHead' },
          h(PanelIcon, { size: 14 }),
          h('span', { className: 'dshdrawio_chatHeadTitle' }, path),
          h('span', { className: 'dshdrawio_chatMeta' }, `${target?.action ?? ''}`),
        ),
        h(
          'div',
          { className: 'dshdrawio_chatBody' },
          h('img', {
            key: previewKey,
            src: `${API}/preview?path=${encodeURIComponent(path)}&v=${previewKey}`,
            alt: path,
          }),
        ),
        h(
          'div',
          { className: 'dshdrawio_chatFoot' },
          h(
            'button',
            { type: 'button', className: 'dshdrawio_chatLink', onClick: () => void ctxOpenPanel(PANEL_ID) },
            t('action.open'),
          ),
        ),
      )
    }

    /**
     * Open the central `drawio` panel. `layout` is optional in the composition,
     * so go through `ctx.get()` inside the component's render closure.
     */
    let ctxLayoutRef = null

    function ctxOpenPanel(panelId) {
      const layout = typeof ctxLayoutRef === 'function' ? ctxLayoutRef() : ctxLayoutRef
      if (layout !== null && layout !== undefined && typeof layout.selectPanel === 'function') {
        layout.selectPanel(panelId)
        return
      }
      console.warn('dsh-drawio: layout service unavailable; cannot focus the panel')
    }

    /** The right-sidebar pane: the most recently touched diagram, always mounted. */
    function DrawioRightPane(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const [latest, setLatest] = React.useState(null)
      const [previewKey, setPreviewKey] = React.useState(0)

      const loadLatest = React.useCallback(async () => {
        try {
          const payload = await callApi('/list?recursive=1')
          const files = Array.isArray(payload.files) ? payload.files : []
          setLatest(files.length > 0 ? files[0] : null)
        } catch {
          setLatest(null)
        }
      }, [])

      React.useEffect(() => {
        void loadLatest()
      }, [loadLatest])

      return h(
        'div',
        { className: 'dshdrawio_right' },
        h('div', { className: 'dshdrawio_rightTitle' }, t('panel.title')),
        latest === null
          ? h('div', { className: 'dshdrawio_rightEmpty' }, t('list.empty'))
          : h(
              React.Fragment,
              null,
              h(
                'div',
                { className: 'dshdrawio_rightCard' },
                h('img', {
                  key: previewKey,
                  src: `${API}/preview?path=${encodeURIComponent(latest.path)}&v=${previewKey}`,
                  alt: latest.path,
                }),
              ),
              h(
                'button',
                {
                  type: 'button',
                  className: 'dshdrawio_btn',
                  style: { alignSelf: 'flex-start' },
                  onClick: () => void ctxOpenPanel(PANEL_ID),
                },
                t('action.open'),
              ),
            ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        // The stylesheet: without inserting it, every class below is inert and
        // the panel renders as raw HTML. Mirrors dsh-mnemon's approach — a
        // <style data-plugin-css> tag keyed by id so remounts reuse it —
        // because the `styles` builtin is not reachable from this module scope.
        ctx.effect(() => {
          if (typeof document === 'undefined') return () => {}
          const tagId = 'dsh-drawio/client.css'
          let tag = document.querySelector(`style[data-plugin-css="${tagId}"]`)
          if (tag === null) {
            tag = document.createElement('style')
            tag.dataset.pluginCss = tagId
            document.head.appendChild(tag)
          }
          const previous = tag.textContent
          if (previous !== CSS) tag.textContent = CSS
          return () => {
            // Keep the tag on unload: other registrations may share the page,
            // and remount re-runs this effect anyway.
            if (tag.textContent === CSS) tag.textContent = previous ?? ''
          }
        }, 'sorarisu-dsh-drawio: stylesheet')
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'sorarisu-dsh-drawio: dictionaries')
        // `layout` is optional (a composition without a right sidebar still runs);
        // hold a lazy getter so the cards can focus the panel on click.
        ctxLayoutRef = () => ctx.get('layout')
        // Self-contained translate: read the active locale from the service but
        // always fall back to our own dictionaries. The service's register/
        // lookup path has failed open before (raw keys in the panel); a local
        // dict cannot. Registration above stays for the shared vocabulary.
        const t = (key, params) => {
          const active = ctx.locale?.getLocale?.().active ?? 'zh'
          const template = (active === 'en' ? EN : ZH)[key] ?? ZH[key] ?? EN[key] ?? key
          if (params === undefined) return template
          return String(template).replace(/\{(\w+)\}/gu, (match, name) => (name in params ? String(params[name]) : match))
        }

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

        // Chat-inline preview: whenever the `drawio` tool call appears in the
        // conversation, render the diagram itself instead of the generic card.
        ctx.slots.inject('tool.call.toolview', () => {
          return ctx.slots.register(
            {
              name: 'tool.call.toolview',
              key: TOOL_NAME,
              locale: NS,
              inject: () => ({ t }),
            },
            DrawioChatCard,
          )
        })

        // Right-sidebar tab (dsh-better-sidebar): the latest diagram, always visible.
        ctx.slots.inject('sidebar.right.pane.tab', () => {
          return ctx.slots.register(
            {
              name: 'sidebar.right.pane.tab',
              key: 'drawio-preview',
              order: 30,
              label: () => t('panel.title'),
              locale: NS,
              inject: () => ({ t }),
            },
            DrawioRightPane,
          )
        })
      },
    }
  },
})
