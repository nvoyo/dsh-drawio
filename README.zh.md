# dsh-drawio —— 让 DeepSeek 用 draw.io 画图

一个 DeepSeek Harness 插件包（npm 包名 `dsh-drawio`）。装上之后，模型可以自己写 `.drawio` 文件（流程图 / 时序图 / 组织架构图），人可以在侧栏面板里用真正的 draw.io 编辑器继续改。

本目录是**源码**，没有安装进 profile。要装上见文末「安装」。

---

## 一、整体思路：为什么是这两个半边

DSH 插件是「一个包，两个半边」：

| 半边 | 文件 | 跑在哪 | 负责 |
|---|---|---|---|
| Host | `index.js` + `lib/` | Node 进程（harness 本体） | 注册模型工具 `drawio`、读写文件、提供 HTTP 路由、把 XML 渲染成 SVG |
| Client | `client.js` | 浏览器（Web GUI） | 侧栏入口 + 主面板，内嵌 draw.io `<iframe>` |

关键分离点：

- **模型只碰文件**。`drawio` 工具收「节点 + 连线」的描述，产出 `.drawio` 文件。模型不需要写 XML，也不会碰网络。
- **编辑器只碰 HTTP**。面板通过 `/api/dsh-drawio/*` 读写，路径策略和工具是同一份代码（`lib/paths.js`）。
- **两边共用一套 XML 层**。所以模型刚写的图，面板能立刻打开；人在 draw.io 里拖过的框，模型下次 `edit` 时也不会被覆盖。

```
模型 ──drawio 工具──┐
                    ├── lib/store.js ── lib/drawio-xml.js（唯一的 XML 真相）
浏览器面板 ─HTTP────┘                        │
                                        lib/drawio-svg.js（预览）
                                        lib/edit.js（外科式改写）
```

---

## 二、目录结构

```
dsh-drawio/
├── package.json          # 包清单：dsh.bundle.patch + dsh.client
├── cordis.patch.yml      # Loader 补丁：插入一行插件
├── index.js              # Host 入口：apply(ctx, config)
├── client.js             # Client 入口：window.__ModuleLoader__.load({...})
├── icon.svg              # 插件图标
├── locale/{zh,en}.json   # 插件市场的标题/描述
├── lib/
│   ├── drawio-xml.js     # XML 解析/规范化/压缩编码
│   ├── drawio-model.js   # XML → { nodes, edges } 结构化
│   ├── drawio-build.js   # { nodes, edges } → XML（自动布局）
│   ├── drawio-svg.js     # XML → SVG 预览
│   ├── edit.js           # 增量修改（不动别的单元格）
│   ├── paths.js          # 路径安全策略
│   ├── store.js          # 文件读写（原子写）
│   ├── routes.js         # HTTP 路由
│   └── tool.js           # drawio 工具定义
└── test/                 # 三套测试 + 样例图
```

---

## 三、Host 半边怎么写

### 3.1 包清单

```json
{
  "name": "dsh-drawio",
  "type": "module",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./locale/*.json": "./locale/*.json",
    "./icon": "./icon.svg"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-client-locale", "@deepseek-ai/dsh-client-ui-sidebar"]
    }
  }
}
```

`dsh.bundle.patch` 让根入口成为 Host 插件；`dsh.client` 让 `./client` 成为浏览器模块。两者可以共存——这就是「双面插件」。

> **一个坑**：profile 里的插件**不能** `import '@deepseek-ai/dsh-tools'` 这类包。实测 ESM 裸导入解析不到（CJS 能解析，ESM 不行）。所以本插件**零 Harness 依赖**，工具定义直接手写 JSON Schema，参数校验也自己做了（`lib/tool.js` 的 `validateValue`）。

### 3.2 Loader 补丁

```yaml
- insert:
    - id: dsh-drawio
      name: dsh-drawio
      config:
        rootDir: .
        maxDocumentBytes: 8388608
```

### 3.3 入口 `index.js`

```js
export const name = 'dsh-drawio'
export const inject = ['tools', 'webServer']   // 缺任一个就不激活，而不是崩掉

export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const store = new DiagramStore({
    roots: workspaceRoots(ctx, config.rootDir),
    maxBytes: config.maxDocumentBytes,
  })

  registerDrawioTool(ctx, { store, logger })          // 模型工具
  const disposers = registerRoutes(ctx, { ... })       // 面板路由
  ctx.effect(() => () => disposers.reverse().forEach((d) => d()), 'routes')

  ctx.systemPrompt?.section({                          // 告诉模型有这回事
    name: 'dsh-drawio', order: 40,
    text: '画流程图/组织架构图时用 drawio 工具写 .drawio 文件……',
  })
}
```

三个要点：

1. **`inject` 声明硬依赖**，不要 `require` 之后才发现服务不在。
2. **一切登记都挂在 `ctx.effect` 下**。插件卸载 / 热重载时自动清理，否则路由会重复注册（`webServer.register` 遇到重复路径直接抛）。
3. **systemPrompt 只写一句**。工具描述已经很长了，这里只补「什么时候该用」，不重复工具怎么用。

### 3.4 工具定义（不用 `defineTool` 的写法）

Harness 原生工具用 `defineTool()` + `zod/schemastery`。本插件不依赖那些包，所以直接给 `ctx.tools.register()` 一个符合 `ToolDefinition` 形状的对象：

```js
ctx.tools.register({
  name: 'drawio',
  description: 'Create and edit draw.io (.drawio) diagrams...',
  parameters: PARAMETERS,           // 标准 JSON Schema，对象根
  output: {
    schema: OUTPUT_VALUE_SCHEMA,     // 返回值必须校验通过
    render: (_args, value) => [{ type: 'text', text: renderToolResult(value) }],
  },
  async execute(args, exec) {
    assertArguments(args, PARAMETERS)   // 注册表不会帮你校验，得自己来
    ...
  },
})
```

**JSON Schema 子集只能这样写**（这是实测踩出来的）：

```js
// ✅ 对象级 required 数组
{ type: 'object', additionalProperties: false, required: ['action'], properties: { ... } }

// ❌ 属性级的 required: true —— 注册表的校验器会直接拒绝
{ type: 'object', properties: { action: { type: 'string', required: true } } }
```

同理，`additionalProperties` 必须是布尔值，`oneOf` 不能和 `type` 并存，不支持 `type: ['string','null']`。

### 3.5 一个工具，多个动作

模型不该记四个工具名。用 `action` 分派：

| action | 作用 | 主要参数 |
|---|---|---|
| `create` | 从节点/连线生成新文件 | `path`, `nodes`, `edges`, `title`, `palette` |
| `edit` | 增量改已有文件 | `path`, `add` / `update` / `remove` |
| `read` | 读成结构化数据 | `path` |
| `export` | 导出 SVG | `path`, `outputPath` |
| `delete` | 删文件 | `path` |
| `list` | 找工作区里的图 | `directory`, `recursive` |

模型实际这么用：

```jsonc
{
  "action": "create",
  "path": "docs/登录流程.drawio",
  "title": "登录流程",
  "nodes": [
    { "id": "start", "label": "开始", "role": "start", "shape": "ellipse" },
    { "id": "check", "label": "密码正确？", "shape": "diamond" },
    { "id": "ok",    "label": "进入首页" },
    { "id": "bad",   "label": "提示错误" },
    { "id": "end",   "label": "结束", "role": "end", "shape": "ellipse" }
  ],
  "edges": [
    { "from": "start", "to": "check" },
    { "from": "check", "to": "ok",  "label": "是" },
    { "from": "check", "to": "bad", "label": "否" },
    { "from": "ok",  "to": "end" },
    { "from": "bad", "to": "end" }
  ]
}
```

**布局由代码算**，模型不管坐标。`lib/drawio-build.js` 做最长路径分层：每个节点一层，同层横向排开。`level` 参数可以手动钉死某层。

### 3.6 外科式编辑

这是最关键的设计决定。用户在 draw.io 里拖过的位置、改过的颜色、加过的折点，**插件并不理解**。所以 `edit` 绝不重新生成整页：

```js
// lib/edit.js
locateCells(document)        // 找出每个 <mxCell> 的精确字节区间
setAttribute(tag, 'value', label)   // 只改这一个属性
```

`update` 只替换目标 cell 的 start tag；`add` 把新 cell 插到 `</root>` 前面并平移到底部；`remove` 连带删掉指向它的连线。测试里专门验证了「编辑器把框拖到 x=420，工具再编辑时 x=420 还在」。

### 3.7 HTTP 路由

面板是浏览器，不能碰文件系统，所以 Host 提供 5 个路由：

| 路由 | 方法 | 作用 |
|---|---|---|
| `/api/dsh-drawio/config` | GET | 返回 embed origin、工作区根、大小上限 |
| `/api/dsh-drawio/list` | GET | 列 `.drawio` 文件 |
| `/api/dsh-drawio/document` | GET | 读一个文件 |
| `/api/dsh-drawio/save` | POST | 写回（编辑器保存） |
| `/api/dsh-drawio/preview` | GET | 返回 SVG |

安全上做了两件事：

```js
// 1. 只接受本机回环
if (!isLoopback(request.socket?.remoteAddress)) return false

// 2. 写操作要求同源（浏览器自动带的 Sec-Fetch-Site / Origin）
if (request.headers['sec-fetch-site'] !== 'same-origin') return false
if (new URL(request.headers.origin).host !== request.headers.host) return false
```

路径策略统一收敛到 `lib/paths.js`，工具和路由都调它：

```js
resolveDiagramPath('../../etc/passwd', { roots, mustBeDiagram: true })
// → PathPolicyError: code 'outside-workspace'
```

### 3.8 SVG 预览

不用任何外部服务，自己画：

```js
renderSvg(xml, { background: '#ffffff', maxWidth: 960 })
```

支持 `rect / rounded / ellipse / rhombus / hexagon / parallelogram / cylinder / actor / note / document / cloud / text`，连线按 `source → 边界交点 → 折点 → 目标边界交点` 算，带箭头和标签。渲染样例见 `test/sample.png`。

> 预览只是**概览**。要看精确效果，用面板里的真编辑器——它才是 draw.io 本尊。

---

## 四、Client 半边怎么写

### 4.1 模块外壳

浏览器模块不是 ES module，是**注册一个懒加载工厂**：

```js
window.__ModuleLoader__.load({
  id: 'dsh-drawio',       // 必须等于包名
  factory(require) {
    const React = require('react')   // 只有 react 能这样拿
    // ... 定义组件
    return {
      inject: ['slots', 'locale'],
      apply(ctx) { /* 注册 slot */ },
    }
  },
})
```

工厂里**不能有副作用**（不能注入 CSS、不能加监听器）。所有资源都放进 `apply`，用 `ctx.effect` 登记清理函数。原因：工厂可能被调用多次（懒加载 + 热重载），副作用会累积。

### 4.2 两个 slot

```js
// 侧栏图标：id 必须和主面板的 key 一致，侧栏靠这个 id 找面板
ctx.slots.inject('sidebar.panellist', () =>
  ctx.slots.register(
    { name: 'sidebar.panellist', id: 'drawio', order: 40,
      label: () => t('panel.title'), locale: NS, inject: () => ({ t }) },
    PanelIcon,
  ),
)

// 主面板：keyed slot，key 就是上面那个 id
ctx.slots.inject('main', () =>
  ctx.slots.register(
    { name: 'main', key: 'drawio', locale: NS, inject: () => ({ t }) },
    DrawioPanel,
  ),
)
```

**为什么用 `ctx.slots.inject(slotName, cb)`**：它等 slot 被声明出来才跑 `cb`，并且 slot 折叠时自动清理。直接 `register` 在声明顺序不对时会失败。

### 4.3 多语言

```js
ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dictionaries')
const t = ctx.locale.bind(NS)
```

规则：

- `register` 一次给**所有内置语言**，缺一个会在注册时报错（双语必须平衡）。
- `bind` 返回的函数**按命名空间稳定**，所以能塞进 `inject: () => ({ t })` 而不破坏 memo。
- 所有可见文字走 `t()`，不要硬编码。

### 4.4 样式：只用主题 token

```js
const CSS = `
.dshdrawio_main{ background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary) }
.dshdrawio_btn{ border: 0.5px solid var(--dsw-alias-border-l2) }
`
```

可用 token 通过 `cordis_inspect_query({ provider: 'Theme', method: 'listTokens' })` 查。**不要写死颜色**——深色主题下会瞎。注意 `--dsw-alias-border-l1` 这种 token 没有兜底值，`var(x, #fff)` 的 fallback 写法是安全的。

### 4.5 内嵌 draw.io 编辑器

这是整件事的核心。draw.io 官方提供 **embed 模式**，用 `postMessage` 交换数据：

```
面板                                 embed.diagrams.net
  │  <iframe src="...?embed=1&proto=json&spin=1">
  │ ──────────────────────────────────────────────▶
  │  ◀──── {event:'init'} ─────────────────────────  「我准备好了」
  │  ─── {action:'load', xml, autosave:1} ─────────▶
  │  ◀──── {event:'save', xml} ────────────────────  用户点了保存
```

实现（`client.js` 的 `DrawioEditor`）：

```js
const onMessage = (event) => {
  // 1. 必须校验来源，否则任何页面都能往编辑器里塞文档
  if (event.origin !== embedOrigin) return
  if (event.source !== frame.contentWindow) return

  const message = JSON.parse(event.data)
  if (message.event === 'init') {
    frame.contentWindow.postMessage(
      JSON.stringify({ action: 'load', xml: xmlRef.current, autosave: 1 }),
      embedOrigin,        // 发送时也要指定 origin，不要用 '*'
    )
  }
  if (message.event === 'autosave' || message.event === 'save') {
    onDirty(message.xml)   // 变成 draft，等用户按保存才写盘
  }
}
window.addEventListener('message', onMessage)
```

要点：

- **`autosave: 1`** 让编辑器每次改动都发 `autosave`，面板据此标记「未保存」。
- **`event.origin` 和 `event.source` 双重校验**。少一个，别的 iframe 就能注入。（测试里专门验了这两条。）
- **数据不出本机**。embed 模式下编辑器没有存储，图只在你和 Host 之间流动。
- `referrerPolicy="no-referrer"`，别把 panel URL 泄给 draw.io。

`app.diagrams.net` 直连会超时（实测），`embed.diagrams.net` 可以访问（实测 200）。两者都不可达时面板降级到本地 SVG 预览，不白屏。

### 4.6 面板状态机

```
files ──选一个──▶ xmlDoc（原始 XML）+ draft（编辑后的）
                        │
        ┌───────────────┴───────────────┐
        ▼                               ▼
   SVG 预览（默认）               draw.io 编辑器（点「打开」）
                                        │ autosave
                                        ▼
                                    dirty = true
                                        │ 点「保存」
                                        ▼
                                  POST /save → 写盘
```

---

## 五、测试

```bash
node test/host.test.mjs     # 23 项：工具 + 路由 + 路径策略
node test/client.test.mjs   # 11 项：注册 + 渲染 + postMessage 协议
node test/e2e.test.mjs      # 7 项：模型 ↔ 面板 双向编辑
```

Host 测试用一个假 Cordis 上下文（提供 `tools.register` / `webServer.register` / `effect` / `get`），跑真实 `apply()`，再起真 HTTP 服务器打路由。Client 测试伪造 `window.__ModuleLoader__`、`React`、`document`，渲染组件并模拟 draw.io 发消息。

**这些测试抓到过真 bug**，不是摆设：

1. 面板里的 `const [document, setDocument]` 把全局 `document` 遮蔽了，导致效果里 `document.documentElement` 报 null。
2. 编辑器 effect 里引用了未定义的 `frame` 变量（改成闭包捕获）。
3. `updateCells` 先按旧偏移改、又按新偏移改，导致 cell 丢失。

---

## 六、安装与发布

### 本地安装（开发时）

```
plugin_manager({ action: 'install_bundle', target: '<本目录绝对路径>' })
```

装完后：侧栏出现「图表」图标、模型能调用 `drawio` 工具、面板能打开工作区里任何 `.drawio` 文件。
卸载用 `plugin_manager({ action: 'remove_bundle', target: 'dsh-drawio' })`。

> 改 `client.js` 后需要**重启 DSH** 才生效（替换已安装包要新加载一代 JS）。只改 Host 侧文件时热重载即可。

### 发布到 npm

包名是 **`@sorarisu/dsh-drawio`**（scope 形式）。三个限制叠加的结果：

- npm 上 `dsh-drawio` 已被 [jean3690/dsh-drawio](https://github.com/jean3690/dsh-drawio) 占用
  （2026-08 发布，功能与本插件重叠）；
- npm 从 2018 年起不允许新包名含大写字母，所以 `Nvoyo` 不能直接当包名；
- **scope 必须等于 npm 账号名或所属 org**——账号是 `sorarisu`，`@nvoyo` 这个 org 不存在。

GitHub 用户名是 `Nvoyo`，npm scope 是 `sorarisu`，两者不同属正常（平台规则不同）。

> ⚠️ 国内镜像 `registry.npmmirror.com` **不能发布**（只读副本，实测 PUT 返回 422）。
> 本包目录内已有 `.npmrc` 指向官方源，**必须在项目目录内执行 npm login**，
> 否则 token 会记到镜像名下、发布时报 ENEEDAUTH。

```bash
cd dsh-drawio      # 先 cd 进来，让项目 .npmrc 生效
npm login          # token 记到 registry.npmjs.org 名下
npm publish        # registry 和 access=public 已配好
```

发布后的安装命令就是一条：

```bash
dsh plugin --profile web add @sorarisu/dsh-drawio
```

### 收录进社区插件市场（dsh-plugin.org）

该市场按下面几条自动扫描，逐条对照：

| 要求 | 本包状态 |
|---|---|
| 公开 GitHub 仓库 | 需你自己建仓并推送 |
| 仓库加 GitHub topic `dsh-plugin` | 需你手动加 |
| README 含安装命令 `dsh plugin --profile web add <包名>` | ✅ 已写 |
| 导出 `apply(ctx)` 模块 | ✅ `index.js` 导出 `apply` |
| 仓库根目录有 `package.json` | ✅ 已有 |
| 有 npm 包（才进 Harness 内「插件中心」） | 需 `npm publish` |
| 开源许可证 | ✅ AGPL-3.0（Copyright (C) 2026 Nvoyo） |

三步：建公开仓库并推送 → 加 `dsh-plugin` topic → 去
[提交页](https://dsh-plugin.org/zh/submit) 按模板开一个 Issue。

> 没有 npm 包也能被收录（用户可用 `github:<owner>/<repo>` 源码安装），但**不会**出现在
> Harness 内的插件中心里。

## 七、可以继续做的

- **多页文档**：目前取第一页，`<mxfile>` 里其余页会原样保留但不操作。
- **导出 PNG**：需要渲染器，现在只做了 SVG（无依赖）。
- **模板库**：`lib/drawio-build.js` 的 `PALETTES` / `SHAPES` 已经是声明式的，加一套「泳道图」「时序图」模板不难。
- **反向同步**：模型改完文件后，面板需要手动刷新才能看到；可以挂 `fs.watch`。
