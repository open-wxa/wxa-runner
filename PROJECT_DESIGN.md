# wxa-runner 设计文档

这份文档写给参与开发的人：wxa-runner 怎么在浏览器里运行官方基础库，各部分为什么这样设计。
使用方法见[文档站点](https://open-wxa.github.io/wxa-runner/)，从源码构建、测试和发布见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

这里只讲整体结构和原因，实现细节以代码里的注释为准。

---

## 设计原则

### 复用官方实现，只做「原生层」

- **官方基础库**：直接加载 `WAService.js` / `WAWebview.js`，App / Page / Component、exparser 组件系统、setData 与渲染全部由官方代码完成
- **官方编译器**：调用 `wcc` / `wcsc`，编译结果与开发者工具一致
- **官方协议**：宿主实现的是基础库期望的原生接口 `WeixinJSBridge`（`invoke` / `publish` / `subscribe` / `on`），以及 `onAppRoute` 等原生事件

wxa-runner 只实现微信客户端原生部分在浏览器里的替代品：消息桥、页面栈、原生 API、导航栏 / tabBar / 弹窗等原生 UI。
渲染层上报的平台是 `devtools`，基础库因此对大多数原生组件改用它为开发者工具准备的网页实现。

### 调试友好

- 每个业务 JS 文件单独一个 `<script>`，行号与源文件一致；用 `import` / `export` 的文件经 esbuild 转换，附带 source map
- 基础库脚本经 source map 加入 DevTools 的忽略列表，控制台的来源链接、调用栈和单步调试都落在业务代码上（`server/ignoreList.ts`）
- 编译错误直接显示官方编译器给出的文件和行列号，修复后自动恢复
- 改动样式、模板、页面逻辑时热更新，保留页面状态；其余改动整页刷新并恢复页面栈
- `?path=pages/detail/detail&id=1` 直接打开指定页面

### 快

- 编译器输出直接读自子进程 stdout，不写临时文件（只有参数超长时写一个参数文件）
- 渲染层 wxml、逻辑层 wxml、wxss 三次编译并行执行
- 按类型增量：只改了 JS 时不重新编译模板和样式，只改了 wxss 时不重新编译 wxml
- 并发请求共享同一次构建，结果缓存到下次文件变化

### 可测试

- 每个页面是一个同源 iframe，Playwright 能用标准选择器直接操作
- setup 和测试 API 在小程序启动前预置存储、覆盖原生 API、拦截请求，不用改业务代码
- `@open-wxa/wxa-runner-playwright` 把这些包装成 Playwright fixture

---

## 架构

```
┌──────────────────────────────────────────────────────────┐
│ 应用层   cli                   命令行                      │
│          playwright            Playwright fixture          │
└───────────────┬──────────────────────────────────────────┘
┌───────────────┴──────────────────────────────────────────┐
│ 服务层   core/server  DevServer、网络代理、文件监听、热更新分流 │
└──┬──────────────────────┬────────────────────────────────┘
┌──┴──────────────┐ ┌─────┴──────────────────────────────────┐
│ 构建层           │ │ 浏览器运行时 core/runtime                │
│ core/project    │ │  host：页面栈、路由、原生 API、手机外壳 UI │
│ compiler        │ │  frame：注入 iframe 的 WeixinJSBridge     │
│ extractor       │ │  ── 官方 WAService.js / WAWebview.js ──   │
└─────────────────┘ └────────────────────────────────────────┘
```

模块之间通过构造参数传递依赖，没有依赖注入框架。

## 项目结构

```
wxa-runner/
├── packages/
│   ├── extractor/                     # @open-wxa/wxa-runner-extractor：基础库定位与解包
│   │   └── src/
│   │       ├── devtools.ts            # 定位开发者工具安装目录 / 用户数据目录
│   │       ├── baselib.ts             # 版本列表、兼容性判断、选择来源（开发者工具 / 内置）、解包到 ~/.wxa-runner/baselib
│   │       ├── wxvpkg.ts              # .wxvpkg 格式解析
│   │       └── asar.ts                # 从新版开发者工具的 app.asar 里读文件
│   │
│   ├── compiler/                      # @open-wxa/wxa-runner-compiler：官方编译器封装
│   │   └── src/
│   │       ├── locate.ts              # 定位 wcc / wcsc：开发者工具自带的，没有时用 miniprogram-compiler
│   │       ├── wcc.ts                 # WXML/WXS → $gwx（渲染层完整版 / 逻辑层裁剪版）
│   │       ├── wcsc.ts                # WXSS → setCssToHead 代码，解析 key=value 输出
│   │       └── exec.ts
│   │
│   ├── core/                          # @open-wxa/wxa-runner-core
│   │   └── src/
│   │       ├── setup.ts               # setup 文件的类型和 defineSetup（@open-wxa/wxa-runner-core/setup）
│   │       ├── test-api.ts            # window.__wxa_test_api__ 的全局类型声明
│   │       ├── project/
│   │       │   ├── MiniProgram.ts     # 读取 app.json / 页面与组件 json、收集组件、列文件
│   │       │   ├── AppBuilder.ts      # 生成逻辑层 / 渲染层产物，按类型增量
│   │       │   └── wxConfig.ts        # 生成 __wxConfig
│   │       ├── server/
│   │       │   ├── DevServer.ts       # HTTP 路由、WebSocket、文件变化后重新编译并通知浏览器
│   │       │   ├── watcher.ts         # 文件监听：合并一次保存的改动，内容没变的不算
│   │       │   ├── hmr.ts             # 改动能否热更新
│   │       │   ├── html.ts            # 宿主 / 逻辑层 / 渲染层 HTML，Worker 的入口脚本
│   │       │   ├── ignoreList.ts      # 基础库脚本加入 DevTools 忽略列表的 source map
│   │       │   ├── proxy.ts           # wx.request 等的转发代理
│   │       │   ├── setup.ts           # 查找、打包 setup 文件，收集 WXA_ 环境变量
│   │       │   ├── devtoolsLogin.ts   # --devtools-login 的接口：登录、手机号，服务市场和插件的请求转发
│   │       │   ├── wechatDev.ts       # 借开发者登录态访问微信后台：ticket、超时、错误提示统一处理
│   │       │   ├── plugins.ts         # 插件：借开发者登录态下载插件代码，插件页面并入小程序
│   │       │   └── developerTicket.ts # --devtools-login 的 ticket：新版开发者工具经自动化接口实时获取
│   │       └── runtime/               # 浏览器端（打包为 dist/runtime/host.js、frame.js、worker.js、sw.js）
│   │           ├── frame.ts           # 注入 iframe：全局变量、WeixinJSBridge、设备尺寸、触摸模拟
│   │           ├── networkPanel.ts    # 请求在 Network 面板里的地址（/__wxa__/proxy/…、/__wxa__/mock/…），宿主、Service Worker、开发服务器共用
│   │           ├── sw.ts              # Service Worker：返回被拦截请求的响应，让它们也显示在 Network 面板里
│   │           ├── context.ts         # 3.7.1 起的基础库：模拟原生 WeixinJSContext，在逻辑层里创建子上下文
│   │           ├── sdkStubs.ts        # 伴生 SDK（广告等）的占位
│   │           ├── syncScript.ts      # 同步执行脚本（loadLibFiles）
│   │           ├── workers.ts         # 逻辑层的原生 WeixinWorker：创建 Worker、收发消息
│   │           ├── worker.ts          # Worker 里的原生接口
│   │           └── host/
│   │               ├── index.ts       # 宿主入口：读取构建信息、执行 setup、启动、处理热更新和整页刷新
│   │               ├── Host.ts        # 宿主：消息分发、路由、页面栈
│   │               ├── PageStack.ts   # 页面栈（纯逻辑）
│   │               ├── PageView.ts    # 单个渲染层 iframe
│   │               ├── realm.ts       # 跨 iframe 传值时在目标 realm 里重建
│   │               ├── hmr.ts         # 在浏览器里应用热更新
│   │               ├── pageStackRestore.ts  # 整页刷新前后保留页面栈
│   │               ├── setup.ts       # 执行 setup
│   │               ├── testApi.ts     # window.__wxa_test_api__（每个成员的说明写在 WxaTestApi 的注释里）
│   │               ├── api/           # 原生 API，见下文「原生 API」
│   │               └── ui/            # 手机外壳：状态栏、导航栏、tabBar、toast、modal、actionSheet、选择器、图片预览、文件选择框
│   │
│   ├── cli/bin/wxa-runner.js          # wxa-runner：命令行（npm 包名不带 scope，npx wxa-runner 直接可用）
│   │
│   └── playwright/                    # @open-wxa/wxa-runner-playwright：Playwright fixture
│       └── src/
│           ├── index.ts               # test / expect、配置项；每个 worker 一个 DevServer
│           ├── miniProgram.ts         # miniProgram：转发测试 API；mock / route 等按调用顺序记在 Node 侧，页面加载时重放
│           ├── matchers.ts            # toHavePath / toHavePageData
│           ├── request.ts             # 按 Content-Type 解析请求体
│           └── server.ts              # 开发服务器参数，路径相对 Playwright 配置文件
│
├── docs/                              # 使用文档，同时是 VitePress 文档站点
├── examples/                          # showcase（覆盖主要功能）、hello-world、custom-tabbar、subpackages、worker
└── tests/
    ├── unit/                          # 解包、编译、项目解析、构建、文件监听、运行时纯逻辑、原生 API
    ├── integration/                   # DevServer 路由、网络代理
    ├── e2e/                           # 真实浏览器运行 showcase 和临时小程序（原生组件等）
    └── playwright/                    # 用 Playwright fixture 写的用例（pnpm test:playwright）
```

---

## 基础库与编译器

### 来源

| 资源 | 来源 | 说明 |
| --- | --- | --- |
| 基础库 | 开发者工具下载的 `.wxvpkg`，macOS 上在 `~/Library/Application Support/微信开发者工具/<id>/WeappVendor/<版本>.wxvpkg` | 用时解包到 `~/.wxa-runner/baselib/<版本>/` 并缓存 |
| | 内置基础库 `@open-wxa/wxa-baselib`（3.7.0，已解包） | 给没有开发者工具的机器（Linux、CI）用，见[设计权衡](#为什么内置基础库放在单独的仓库) |
| 编译器 | 开发者工具自带的命令行版本：`<程序目录>/node_modules/wcc-exec/{wcc,wcsc}` | macOS 上是 x86_64 + arm64 通用二进制 |
| | 微信官方 npm 包 `miniprogram-compiler` 自带的编译器 | 没有开发者工具时用，只支持 x86-64。编译内核较旧（20200413，开发者工具为 20211229），页面的编译结果相同，只有模板运行时有少量差异，如单页最多 16000 个节点 |
| 行政区划数据 | `<程序目录>/js/libs/region_sub_strict*`，新版在 `app.asar` 里 | 地区选择器用，见「原生组件」。没有开发者工具时地区选择器不可用 |

- 同一个基础库版本优先用开发者工具的，内置的只在开发者工具没有这个版本时兜底
- 内置基础库和 `miniprogram-compiler` 都是可选依赖：安装失败不影响 wxa-runner 本身
- 程序目录：旧版开发者工具是 `package.nw`；新版（2.02 起，Electron）把大部分文件打包在 `app.asar`，编译器等要直接执行的文件解包在
  `app.asar.unpacked`。两种都支持，行政区划数据直接从 `app.asar` 里读出（`extractor/src/asar.ts`）
- 以上位置都可以用环境变量覆盖：`WXA_DEVTOOLS_PATH`、`WXA_VENDOR_DIR`、`WXA_WCC` / `WXA_WCSC`

`.wxvpkg` 是一个简单的打包格式：`0xBE` 魔数 + 文件索引（名称、偏移、长度，大端序）+ 文件内容。

### 版本

**默认使用的基础库版本：≤ 3.7.0**（`MAX_COMPATIBLE_VERSION`，已验证的范围）。不指定版本时，自动选择可用的最新兼容版本；
更高的版本用 `--baselib` 或 `WXA_BASELIB` 指定，启动时提示超出已验证的范围。

| 版本 | 逻辑层结构 | 状态 |
| --- | --- | --- |
| 2.x – 3.7.0 | `WAService.js` 包含完整框架，在单个 JS 上下文中运行 | 已验证 2.32.3 / 3.3.4 / 3.5.8 / 3.7.0 |
| 3.7.1 起 | 业务代码运行在由原生 `WeixinJSContext` 创建的隔离上下文中（glass-easel 适配） | 全部测试在 3.7.1 / 3.8.8 上通过，需显式指定版本 |
| 3.8 起 | `WAService.js` 只是占位，框架在 `WAServiceMainContext.js` / `WASubContext.js` | 同上 |

3.7.1 起（`ISOLATED_CONTEXT_SINCE`），逻辑层 iframe 加载 `WAServiceMainContext.js`，作为主上下文；
`runtime/context.ts` 在其中提供 `WeixinJSContext`，主上下文用它创建子上下文（逻辑层里的同源 iframe `subcontext.html`，加载 `WASubContext.js`），
业务代码在名为 `app` 的子上下文里执行。主、子上下文之间的消息由基础库直接互相调用，不经过 wxa-runner。
业务代码的启动要经过几步基础库内部行为，任何一步没发生时，超时后报告停在哪一步，小程序照常结束启动。
原生接口的约定由模拟基础库（`tests/fakeBaseLib.ts`）固定，CI 上没有新版基础库也能测到。

### 编译器（wxa-runner-compiler）

**为什么用子进程而不是 `wcc.node` 原生模块**：原生模块在同一 Node 进程中重复调用会随机触发
`std::bad_alloc` 崩溃（与调用顺序、GC 无关，可稳定复现）。命令行版本与原生模块是同一个编译内核，
单次编译只需几毫秒，子进程天然隔离。

**WXML（wcc）**：项目中所有 `.wxml` 和 `.wxs` 一次编译成一个 `$gwx` 函数，`import` / `include` /
wxs 引用由编译器自己解析。需要告诉编译器每个页面/组件中哪些标签是自定义组件（`-cc` / `-xc` 参数），
格式与开发者工具一致：

```
[页面数, "./pages/a/a.wxml", 2, "comp-a", "comp-b", "./components/x/x.wxml", 0, ...]  // 以分隔符连接
```

同一份 wxml 编译两次：
- **渲染层**使用完整版（`-cc`）
- **逻辑层**使用裁剪版（`-xc`）。exparser 在逻辑层也要知道组件的节点结构，缺少它会导致
  「expect FLOW_CREATE_NODE but get another」

**WXSS（wcsc）**：输出是 `key=value=key=value…` 交替的字符串，值为转义过的 JS 源码：
- `comm`：公共运行时（`setCssToHead`、rpx 换算）以及 `app.wxss` 的立即执行代码
- `./pages/a/a.wxss`：每个页面/组件一个 `setCssToHead(...)`，返回的函数在页面创建时调用

rpx 换算由 wcsc 生成的运行时完成，不需要另外处理。

---

## 项目构建（core/project）

**json 预处理**（与开发者工具相同）：
- `app.json` 的全局 `usingComponents` 展开到每个页面和组件（`miniprogram_npm` 和独立分包除外）
- 每个页面/组件 json 都保证有 `usingComponents` 字段

**组件收集**：从所有页面（含分包）出发，递归解析 `usingComponents` 和 `componentGenerics` 默认实现。
开启自定义 tabBar（`tabBar.custom`）时，基础库按固定路径创建的 `custom-tab-bar/index` 也作为入口收集。
引用解析顺序：`/` 开头为根路径；否则先按相对路径，再沿目录向上查找 `miniprogram_npm`。

**`__wxConfig`**：字段与开发者工具一致（`pages`、`page["x.html"].window`、`global.window` 默认值、
`entryPagePath`、tabBar 的 `pagePath` 带 `.html` 后缀、`accountInfo`、`appLaunchInfo` 等）。

**逻辑层产物**：

```js
// 每个 JS 文件单独一个脚本：/__wxa__/module/pages/a/a.js
define("pages/a/a.js", function(require, module, exports, window, document, ...){<原文件内容>
});

// /__wxa__/service-bootstrap.js
<裁剪版 $gwx>
__wxAppCode__["app.json"] = {...};
__wxAppCode__["pages/a/a.json"] = {...};               // 每个组件和页面
__wxAppCode__["pages/a/a.wxml"] = $gwx("./pages/a/a.wxml");
require("app.js");
__wxRoute = "components/x/x"; __wxRouteBegin = true; require("components/x/x.js");   // 先组件
__wxRoute = "pages/a/a";      __wxRouteBegin = true; require("pages/a/a.js");        // 再页面
```

- 包装头和代码第一行在同一行，报错行号与源文件一致
- 使用 `import` / `export` 的文件先用 esbuild 转为 CommonJS（对应开发者工具的「ES6 转 ES5」），内联 source map
- 单个模块执行出错只影响它自己，其余页面照常注册

**渲染层产物**（`/__wxa__/page-frame.js`，所有页面共用）：完整版 `$gwx` + wcsc `comm` + 每个页面/组件的
`__wxAppCode__` json / wxml / wxss。每个页面的 HTML 再执行：

```js
__wxAppCode__["pages/a/a.wxss"]();
document.dispatchEvent(new CustomEvent("generateFuncReady", {
  detail: { generateFunc: $gwx("./pages/a/a.wxml") }
}));
```

**Worker 产物**：`workers` 目录下的 JS 不进逻辑层，同样每个文件一个 `define` 脚本（`workerModules`），由 Worker 的入口加载，见下文「Worker」。

逻辑层的模板（`service-templates.js`）、渲染层的模板（`page-templates.js`）和样式（`page-styles.js`）也能单独取到，热更新时分别下发。
样式和模板里的 `env(safe-area-inset-*)` 改写成 CSS 变量（`rewriteSafeAreaInsets`）。

### 插件（server/plugins.ts）

插件代码不在项目里。同开发者工具：开发服务器带着开发者 ticket 向微信下载 `app.json` 声明的插件（`wxa-dev/getplugincode`，
body 是插件 appid 和版本），只放在内存里，同一个插件版本下载一次。要用开发者的登录态，所以只在 `--devtools-login` 时下载；
下载不了时在终端说明原因，小程序自己的页面照常可用。

下载到的是 `.wxvpkg` 格式（同基础库）的编译产物，wxa-runner 不用再编译：

| 文件 | 内容 | 怎么用 |
| --- | --- | --- |
| `plugin.json` | 插件页面表（如 `__plugin__/<插件 appid>/pages/index/index`）和每个页面的 window 配置 | 并入 app-info 的 `pages` 和 `__wxConfig.page` |
| `appservice.js` | `definePlugin(...)` 包着插件的 `$gwx_<插件 appid>`、`__wxAppCode__`、各模块的 `define`，最后自己 `requirePlugin` 初始化 | 逻辑层在业务代码之前加载 |
| `pageframe.js` | 插件的模板函数和样式（自带 `setCssToHead`） | 插件页面的渲染层加载，不加载小程序的 page-frame.js |
| `pages/x/x.html` | 注入样式、取模板、派发 `generateFuncReady` 的片段 | 原样放进插件页面的 body |
| `static/…` | 图片等 | 基础库把插件里的相对路径和 `/` 开头的路径都改写成站点根下的 `/__plugin__/<插件 appid>/…` |

跳转由基础库完成：`plugin://别名/页面名` 解析成 `__plugin__/<插件 appid>/pages/…` 后调原生路由，宿主当普通页面打开。
基础库启动时还会调原生的 `verifyPlugin`（插件能访问的域名和签名）和 `batchGetContact`（插件信息），插件里的网络请求要等拿到这两样才发出，
开发服务器同开发者工具转发给 `wxa-dev-logic/verifyplugin`、`batchgetcontact`。插件的请求和基础库自己的请求一样带 `__skipDomainCheck__`，
但多一个签名头 `X-WECHAT-HOSTSIGN`，宿主据此当作小程序的请求发出（`api/network.ts`）。

---

## 浏览器运行时（core/runtime）

### iframe 布局

```
宿主页面 /                         host.js：Host、页面栈、原生 API、手机外壳 UI
├── iframe /__wxa__/appservice.html          逻辑层（隐藏，name 为 wxa-appservice）
│     frame.js → WAService.js → 业务模块 → service-bootstrap.js
│     （3.7.1 起：WAServiceMainContext.js，业务代码在子上下文 subcontext.html 里执行）
│     └── Web Worker /__wxa__/worker.js?id=1     wx.createWorker 创建的 Worker
├── iframe /__wxa__/webview/pages/a/a.html?id=1   渲染层（每个页面一个）
│     frame.js → WAWebview.js → page-frame.js → generateFuncReady
└── iframe /__wxa__/webview/pages/b/b.html?id=2
```

渲染层 URL 与页面路径一致，wxml 中的相对资源路径（`../../images/a.png`）因此能按小程序规则解析。

### 注入 iframe 的脚本（frame.ts）

必须在基础库之前执行：

1. **预置全局变量**：`__wxAppCode__`、`__wxRoute`、`__global` 等，基础库依赖它们；`WeixinWorker` 是 Worker 的原生接口，见下文「Worker」
2. **`__passWAServiceGlobal__(globals)`**：部分版本的基础库初始化完成后通过它交出 `App` / `Page` / `Component` /
   `wx` / `define` / `require`（3.7.0 直接写到 `globalThis`）
3. **WeixinJSBridge**：基础库检测到已存在的全局 `WeixinJSBridge` 时直接使用它
4. **渲染层设备模拟**：
   - `screen.width` / `devicePixelRatio` 改为模拟设备的值
   - `screen.orientation` 固定为竖屏。桌面浏览器报告横屏时，基础库会改用 `screen.height` 作为设备宽度，导致 rpx 换算错误
5. **鼠标 → 触摸**：页面只应收到触摸事件。基础库在部分版本/平台上会自己把鼠标或 pointer 事件转换为触摸，
   和我们的转换叠加会触发两次 tap，所以在 window 捕获阶段最先拦下鼠标类事件再统一转换。
   另外基础库在元素滚动后 50ms 内会取消 tap，自动化测试的「滚动到元素 → 立刻点击」会因此失效，
   转换时先等两帧让 scroll 事件派发完，必要时顺延。
   swiper 等组件只看第一个 touchmove 判断手势方向，鼠标刚拖动时的 1px 抖动会让横向拖动被当成竖向，
   所以按下后移出 8px 之前的 mousemove 不转发（小于基础库取消 tap 的 10px）；没移出就松手时补一个 touchmove，小幅拖动不丢
6. **内置组件样式提前注入**：基础库在文档没加载完时把内置组件样式（`wx-view` 的 display、`wx-canvas` 的默认尺寸等）
   推迟到 `window.onload` 注入。开发者工具在文档加载完后才注入基础库，那边是立即注入；这里基础库随页面同步加载，
   首屏渲染早于 onload，canvas 这类挂载时测量尺寸的组件会量错。所以加载完成前赋给 `window.onload` 的回调改为立即执行

### 消息协议

宿主与 iframe 同源，iframe 内的桥直接调用 `window.parent.__wxaHost`，不经过 postMessage。
这让同步 API（`getStorageSync` 等）可以同步返回。

| 方向 | 基础库调用 | 宿主处理 |
| --- | --- | --- |
| 逻辑层 → 渲染层 | `WeixinJSBridge.publish(event, data, webviewIds)` | 克隆到目标 iframe 的 realm 后，在微任务中调用渲染层的 subscribe 回调；`webviewIds` 为空时发给所有页面（旧版 canvas 的绘制指令就这样发，靠 canvasNumber 找到画布） |
| 渲染层 → 逻辑层 | `WeixinJSBridge.publish(event, data)` | 同上，附带来源 webviewId |
| 任一层 → 原生 | `WeixinJSBridge.invoke(api, args, callback)` | 交给 API 注册表；结果能同步得到时**同步回调**（基础库在带 `type` 参数的 `getSystemInfo` 等调用上依赖这一点） |
| 原生 → 逻辑层 | `WeixinJSBridge.on(event, cb)` | `onAppRoute`、`onAppRouteDone`、`on*TaskStateChange`、`onAppEnterForeground` 等 |
| 原生 → 渲染层 | `WeixinJSBridge.on(event, cb)` | 原生组件的事件：`onMultiPickerViewChange`、`onWebviewStartLoad` / `onWebviewFinishLoad` |

数据通过 `目标window.JSON.parse(JSON.stringify(data))` 在目标 iframe 的 realm 中重建（`host/realm.ts`），
避免跨 realm 的 `instanceof Array` 判断失效。原生接口的结果和事件里可能有 ArrayBuffer（`readFile` 读到的文件、下载的音频、
按 `arraybuffer` 请求到的数据、WebSocket 的二进制消息），
JSON 会把它变成 `{}`，所以单独复制成目标 realm 的 ArrayBuffer；`setData` 等消息数据量大，不做这一步。

### 路由与生命周期

宿主不实现任何生命周期，只维护页面栈并派发 `onAppRoute`，生命周期由基础库驱动：

```
navigateTo(url)
  1. 页面栈已满（10 层）→ fail
  2. 创建渲染层 iframe，等待 generateFuncReady 执行完
  3. 压栈、切换显示、更新导航栏 / tabBar / 地址栏
  4. 派发 onAppRoute { path, query, openType: 'navigateTo', webviewId }
     → 基础库执行 onHide / onLoad / onShow，推送初始数据，渲染完成后 onReady
  5. 300ms 后若仍是当前页面，派发 onAppRouteDone
```

- 基础库调用路由 API 时，url 已解析为根路径并带 `.html`（如 `pages/a/a.html?id=1`），宿主只做格式归一
- 路由操作串行执行，避免连续跳转时页面栈错乱
- tabBar 页面实例缓存，`switchTab` 回来时不重新创建；`reLaunch` 清空包括 tabBar 在内的所有页面

### 原生 API

| 模块 | 内容 |
| --- | --- |
| storage | localStorage，按 appid 和 storageId 隔离；原样保存基础库序列化后的数据和 dataType；渲染层用的 GlobalStorage（cookie） |
| system | 以模拟设备（默认 iPhone X，375×812 @3x）为准的 getSystemInfo 及 windowInfo / deviceInfo / appBaseInfo 等 |
| network | `createRequestTask` 同步返回 taskId，结果通过 `onRequestTaskStateChange` 依次推送 `headersReceived`、`success` / `fail`；下载、上传、WebSocket 同理。`success` 的 data 按 `responseType` 是文本或 ArrayBuffer，被拦截的请求也一样；WebSocket 的二进制消息是 ArrayBuffer。基础库把业务传的 ArrayBuffer（请求体、WebSocket 消息）原样交给宿主，不经 `__nativeBuffers__`。每个 `wx.request` 都记录下来，供测试 API 的 `requests()` 读取 |
| routes | 请求拦截规则：setup 的 `network.routes` 和测试 API 的 `route` 共用，在浏览器里匹配，命中的请求不发往代理 |
| ui | toast / loading / modal / actionSheet / 导航栏 |
| media | 选图和视频（chooseImage / chooseMedia / chooseVideo）、previewImage、getImageInfo、saveImageToPhotosAlbum，见下文「原生组件」 |
| audio | 原生音频接口（createAudioInstance、setAudioState、operateAudio 等），3.3.x 及更早版本的 InnerAudioContext 用，见下文「原生组件」 |
| map | map 组件要的定位（`private_geolocation`）和 `moveToMapLocation`，见下文「原生组件」 |
| picker | picker 组件的选择器弹层，见下文「原生组件」 |
| webView | web-view 组件的网页视图，见下文「原生组件」 |
| fs | 用户文件和临时文件都在开发服务器上，按浏览器会话各存一份（会话标识存在 localStorage，刷新后不变，新的浏览器上下文另起一份），`USER_DATA_PATH` 是 `/__wxa__/usr/<会话>`，image 等组件和 uploadFile 能按地址读取。基础库写死的 `http://usr/`（运行日志）落在同一会话里。`Sync` 接口用同步 XHR，其余用 fetch；文件不存在等正常失败返回 200 和 `error`，不在控制台留下请求错误。`readFile` 读不带协议的路径时向开发服务器取代码包里的文件，`readFileSync` 读不到代码包 |
| tempFiles / savedFiles | 临时文件存到开发服务器；保存的文件：saveFile、getSavedFileList / getSavedFileInfo、removeSavedFile，见下文「原生组件」 |
| libFiles | 渲染层按需加载基础库文件（`loadLibFilesSync`），3.3.x、3.5.x 的 video 等组件用，见下文「原生组件」 |
| subpackages | 分包加载任务：`createLoadSubPackageTask` 同步返回 taskId，随后通过 `onLoadSubPackageTaskStateChange` 推送 `progressUpdate`、`success`，未声明的分包失败。所有分包的代码构建时已经注册，不用下载；渲染层的 `injectSubPackages` 直接成功，模板和样式已在 page-frame.js 里。分包预下载和分包异步化（跨分包组件、`require.async`）都走这里 |
| misc | 登录、用户信息等开放接口的固定返回（`--devtools-login` 时登录和手机号换成真实的，服务市场、插件校验经开发服务器转发）、剪贴板等 |
| 路由 | 由 Host 实现 |

未实现的 API 默认返回 `:ok` 并在控制台提示一次；基础库内部的上报类调用静默处理。
其中业务代码调用的（逻辑层发起、名字在 `wx` 上）还会记入测试 API 的 `errors()`，每个 API 一次；
基础库内部调用的原生接口（如 `getAppContact`）不记，因为业务既没调用也 mock 不了。
setup 和测试 API 的 `mock` 都在注册表这一层覆盖原生实现。

### 原生组件

渲染层上报的平台是 `devtools`，基础库对大多数原生组件改用开发者工具里的网页实现，宿主不用参与：

| 组件 | 实现 | 状态 |
| --- | --- | --- |
| canvas（2d / webgl / 旧版 canvas-id）、video、map、camera、audio | 基础库的网页实现：`<canvas>`、`<video>`、腾讯地图网页 SDK、`getUserMedia` | 可用。map 需要联网；camera 需要浏览器授权摄像头；video 的 src 只能是 http(s)，3.3.x、3.5.x 的 video 按需加载（见下） |
| cover-view、cover-image、input、textarea、picker-view、editor | 基础库的网页实现 | 可用 |
| picker | 宿主弹出选择器（`showPickerView` 等） | 可用 |
| web-view | 宿主在页面里嵌入 iframe（`insertHTMLWebView` 等） | 可用，有限制，见下 |
| live-player | 渲染出 `<video>`，播放走的 `operateLivePlayer` 没有实现，浏览器也不能播 RTMP | 不能播放 |
| live-pusher、voip-room | 基础库显示「IDE 暂不支持」，与开发者工具一致 | 不支持 |
| open-data、ad | open-data 渲染为空；ad 走广告失败分支（见「伴生 SDK 子包」） | 不支持 |

几个需要宿主配合的地方：

- **选择器**：基础库把各列的选项文字交给宿主，宿主从底部弹出选择器，按约定格式返回用户的选择。
  日期的天数随年月变化、start/end 限制、省市区逐级联动在 `api/picker.ts` 里实现，弹层（`ui/Picker.ts`）只负责显示列。
  多列选择器打开期间用户换列时，向渲染层派发 `onMultiPickerViewChange`，页面改了 range 后基础库调 `updateMultiPickerView` 换掉那一列。
  地区选择器的行政区划数据取自本机开发者工具（`js/libs/region_sub_strict*`，新版在 `app.asar` 里），和基础库一样不随项目分发
- **web-view**：网页放在所在页面渲染层里的 iframe 中，跟着页面显示、隐藏和关闭。设置了 X-Frame-Options 或
  CSP frame-ancestors 的网站不允许被嵌入，显示不出来；网页里的 `wx.miniProgram` 接口不可用。
  网页内自己跳转时，同源网页报告新地址并触发 load，跨域网页读不到地址就不报；iframe 加载失败没有事件，binderror 不会触发。
  基础库拿到空的业务域名列表时会把 web-view 事件里的网页地址清空，所以拉取业务域名列表（`operateWXData` 的
  `webapi_getwxanetwork`）明确返回失败，基础库因此不做校验，等同开发者工具的「不校验业务域名」
- **2d、webgl 画布**：基础库在 devtools 平台把这两种画布建在逻辑层文档的 body 里，按渲染层报来的位置（`canvasInserted` /
  `canvasUpdated`）绝对定位、随页面滚动，开发者工具把逻辑层透明地叠在页面上显示，所以那里的画布盖住页面里的所有内容。
  真机上画布和页面元素一样参与层级，宿主照真机做：业务第一次取上下文时（`getContext`，还没开始画），把画布元素搬进页面里对应的
  `wx-canvas`，铺满它自己的 canvas。同源 iframe 之间移动元素，画布内容和已经拿到的上下文都不受影响。
  逻辑层的画布元素上没有编号，基础库把「元素 → 编号」记在内部的 WeakMap 里（`WeakMap.prototype.set` 等内置方法被基础库锁住，拦不到），
  宿主就给还没放好的同类型画布逐个发一条 top 带记号的 `canvasUpdated`，记号写到哪个元素上就是哪个编号，再用原来的位置发一次恢复（`Host.placeCanvas`）。
  xr-frame 的画布不搬：基础库收到它的 `canvasUpdated` 会给 xr-frame 派发 resize，xr-frame 在 wxa-runner 里也没有验证过。
  搬进页面后基础库仍会按逻辑层的布局改它的位置和显隐，渲染层用 `!important` 样式压住；删除时基础库还从逻辑层的 body 里删，`frame.ts` 兼容。
  `canvas.createImage` 调开发者工具提供的 `__global.createCustomImage`（`frame.ts`）：代码包里的图片去掉开发者工具的 `/__pageframe__/` 前缀，
  从开发服务器根路径加载；其他域名的图片经代理变成同源，画上去不污染画布，之后照样能读像素、导出
- **临时文件**：canvas 导出、拍照、录像的结果（经 `base64ToTempFilePath`）、选中的图片、`downloadFile` 下载的文件都存到开发服务器，返回 http 地址。
  image、video 组件只原样使用 http(s) 地址，`blob:` 之类的地址会被当成页面相对路径。
  旧版 canvas 的 `drawImage` 正好相反：基础库把 http(s) 地址都当成网络图片直接跳过（只放行开发者工具的 `http://tmp/` 等），
  不报错，画布上什么也没有。所以宿主转发绘制指令（`canvasActionsChanged`）时，把其中的临时文件地址换成根路径 `/__wxa__/tmp/…`，
  页面和组件里都按开发服务器的根目录解析
- **选图和视频**：「从手机相册选择」和「拍摄」都打开浏览器的文件选择框（拍摄带 `capture`，手机浏览器上会打开相机）。
  和真机一样，两种来源都可选时先弹菜单。浏览器只允许在用户点击后的几秒内打开文件选择框（页面里的点击也算，会传到宿主页），
  没有经过点击就调用时也先弹菜单，用户点菜单就是一次点击；否则选择框打不开，回调永远不来。
  选视频时用 `<video>` 读出时长和宽高，截第一帧作缩略图，浏览器解码不了的格式这几项为空。
  这些规则和开发者工具一致：不允许混选（`mediaType` 没有 `mix`）时选了视频就只要视频；允许混选时 `type` 总是 `mix`；
  chooseVideo 也返回 `thumbTempFilePath`；chooseMedia 选的图片不带宽高。
  `previewImage` 是宿主的全屏预览层，`saveImageToPhotosAlbum` 让浏览器下载这张图片
- **音频（InnerAudioContext）**：3.5.8 起平台是 devtools 时基础库用 Web Audio 播放，先把音频读成 ArrayBuffer。
  网络音频经带 `__skipDomainCheck__` 的内部请求下载，宿主按请求的形状（`responseType` 为 `arraybuffer` 且带 `enableCache`，
  2.32.3 到 3.17.4 都是这样）只放行这一种，经代理下载；代码包里的音频经 `readFile` 向开发服务器读取。
  3.3.x 及更早版本默认调原生接口（`createAudioInstance`、`setAudioState`、`operateAudio` 等；业务指定 `useWebAudioImplement` 时同样用 Web Audio），宿主用 `<audio>` 实现：
  时间以毫秒为单位；基础库每次改属性都带上全部状态，其中的进度是旧值，只取 src、音量等能设置的属性；
  timeupdate 由基础库轮询 `getAudioState` 产生。浏览器缓冲、跳转后只派发 playing，所以把 playing 当作 play 推送，
  否则基础库把 waiting 当作暂停、不再更新进度。pause 由宿主在暂停时推送，不转发浏览器的 pause 事件（它在 stop 之后才异步派发，
  播到结尾时也会先派发一次）；stop 把进度归零引起的 seeking、seeked、canplay 也不推送。还没播放过时设置 startTime 立即生效，
  stop 后从头播放，都与基础库的 Web Audio 实现一致
- **地图（map）**：基础库用腾讯地图 GL 网页 SDK 实现，SDK 和瓦片从腾讯的服务器加载，需要联网。MapContext 的方法经 `operateMap`
  消息发给渲染层的 map 组件，结果经 `operateMapCallback` 发回，宿主照常转发。在 3.7.0 上用真实 SDK 逐个验证过：
  getCenterLocation、getRegion、getScale、getRotate、getSkew、moveToLocation、includePoints、addMarkers、removeMarkers、
  translateMarker、moveAlong、setCenterOffset、setBoundary、initMarkerCluster 能用；事件 tap、markertap、callouttap、labeltap、
  regionchange（拖动时 begin / end，includePoints 等引起的 begin 的 causedBy 是基础库拼错的 `udpate`）、updated 能收到。
  点标记点时 SDK 同时派发地图的点击，业务也会收到 tap（点到地名时还有 poitap）。
  宿主要配合两处：map 组件要当前位置时（moveToLocation、show-location）调 `private_geolocation`，期望腾讯位置服务定位接口的 JSON 文本，
  宿主返回 `getLocation` 的结果（能 mock），没有它时带经纬度的 moveToLocation 也失败；3.10.1 起带经纬度的 moveToLocation
  改调原生的 `moveToMapLocation`，宿主照基础库的格式经 `operateMap` 转给当前页的 map 组件，等它的 `operateMapCallback` 再返回。
  网页实现里没有处理、调用后不会回调的：toScreenLocation、fromScreenLocation、地面覆盖物（addGroundOverlay 等）、setLocMarkerIcon、
  eraseLines、室内图、可视化图层；addArc、removeArc 返回 `not support on devtools`；openMapApp 返回成功，但不会打开地图 App。
  e2e 把 SDK 换成替身（`tests/e2e/fixtures/tmap.js`），不依赖外网；`WXA_MAP_SDK=online` 时用真实 SDK 跑同样的用例
- **按需加载的组件**：3.3.x、3.5.x 的 video 等组件放在单独的基础库文件里，渲染层用到时调 `loadLibFilesSync`。
  宿主同步读取文件，脚本在调用返回前于渲染层执行完（基础库在调用前后设置、清理 `window.__Behaviour` 等全局变量），
  各文件的内容按顺序放在 `__codes` 里交回，基础库从中取 CSS 自己插入。逻辑层也会调它加载伴生 SDK，那条路照旧只返回成功（见下文「伴生 SDK 子包」）
- **保存的文件**：`getFileInfo` 向开发服务器查临时文件的大小（不返回 digest）。`saveFile` 和真机一样把临时文件存成新文件、删掉原来的，
  新文件也在开发服务器上，image 能直接显示。保存记录写在 Storage 里，同样按 appid 隔离、整页刷新后还在；开发服务器重启后文件没了，
  记录随之失效，`getSavedFileInfo` 报文件不存在，Painter 等用它做缓存的库会重新下载。FileSystemManager 的 `saveFile`
  指定 `filePath` 时直接失败（还没有实现）；`saveFileSync` 没有实现

### 伴生 SDK 子包

上面的兜底只覆盖走 `WeixinJSBridge.invoke` 的调用。另有一类能力实现在基础库内部，
由一组伴生文件提供，真机和开发者工具由原生层调用 `loadMainContextLibFile` 把它们
同步加载进逻辑层上下文，再把导出挂到约定的全局名上：

| 全局名 | 伴生文件 | 能力 |
| --- | --- | --- |
| `ADSDK` | WAAppAd.js | 广告 |
| `__cloudSDKMain__` / `__sclEngine__` | WACloud.js / WASubAppSclEngine.js | 云开发 |
| `MidasSDK` / `OrderMidasSDK` | WAMidasSDK.js / WAOrderMidasSDK.js | 米大师支付 |
| `__splashAdFloatWindowSDK__` / `__progneSDK__` | WASplashAdFloatWindow.js / WAProgneService.js | 开屏广告浮窗 |

运行时没有这套加载机制。缺失不会直接抛到业务代码——基础库把内部异常包成
`appServiceSDKScriptError` 自己吞掉，于是 `wx.createRewardedVideoAd()` 返回 `undefined`，
崩的是下一行业务代码的 `ad.onError(...)`。所以占位（`runtime/sdkStubs.ts`）放在 `wx` 这一层，
返回接口齐全、`load`/`show` 必定失败的广告对象，业务代码走自己的广告失败分支。

装占位的时机只有一个窗口：基础库初始化完会把这些接口改成返回 `undefined` 的函数，
占位要在业务代码执行前装。做法是在基础库加载前用存取器占住 `globalThis.require`，
bootstrap 每次 require 业务模块时先装一遍（`installApiStubs` 幂等）。

不事后包装 `require`、也不让生成的 bootstrap 去调运行时包里的全局：基础库交出全局的方式
按版本而异（3.7.0 直接写 `globalThis`，并不调 `__passWAServiceGlobal__`），事后包装没有
可靠时机；而让 bootstrap 依赖运行时包的全局，会在 `dist/runtime` 没跟着重新构建时
直接 ReferenceError 崩掉整个小程序。

不给 `SkylineGlobal` / `NativeGlobal` / `xrFrame` / `WeixinJSContext` 这类全局打桩——
基础库对它们做 `typeof` 检测，补上会让它走进依赖更多的分支，比缺失更糟。

### Worker

和开发者工具一样，`wx.createWorker` 创建的 Worker 是浏览器的 Web Worker。基础库两端都通过原生的 `WeixinWorker` 通信，
宿主实现两端的原生接口：逻辑层的在 `runtime/workers.ts`，装在逻辑层 iframe 上（3.8 起创建 Worker 的代码在主上下文，也是这个 iframe）；
Worker 里的在 `runtime/worker.ts`。

```
逻辑层基础库                         宿主                                   Worker 基础库（WAWorker.js）
WeixinWorker.create("workers.js") → new Worker(/__wxa__/worker.js?id=)
WeixinWorker.postMsgToWorker(id, json) → Worker.postMessage            → WeixinWorker.appServiceMsgHandler(msg)
WeixinWorker.workerMsgHandler(id, msg) ← message                       ← WeixinWorker.postMsgToAppService(json)
WeixinJSBridge.invoke 的实现（宿主）     ← invoke / → callback            ← workerInvokeJsApi(api, args, callbackId)
```

- **入口**：`/__wxa__/worker.js` 依次加载 `__wxConfig`、`runtime/worker.js`、`WAWorker.js` 和 `workers` 目录下的每个模块（`importScripts`，DevTools 里保留文件名和行号）。
  `create` 收到的脚本名总是 `workers.js`，业务指定的入口由基础库随后发 `requireScript` 消息让 Worker 去 `require`
- **基础库里没有 `WAWorker.js`**（只放了逻辑层和渲染层文件的旧版内置基础库）时，入口不加载它，直接报告缺少的文件，记入 `errors()`
- **没有配置 `workers`** 时 `create` 返回 -1，基础库报告 Worker 不存在。基础库加载后会从全局的 `__wxConfig` 里删掉 `workers`，所以在基础库之前读
- **console**：Worker 基础库把 console 换成转发给逻辑层的版本，转发时对象被转成文本；和开发者工具一样加载完基础库后换回原来的，日志留在 Worker 里
- **异常**：Worker 里没有被捕获的异常经消息交给宿主，记入测试 API 的 `errors()`；同时以 `workerUncaughtError` 交给逻辑层基础库，业务的 `worker.onError` 收到
- **Worker 里的原生接口**：基础库只在有 `workerInvokeJsApi` 时才创建业务代码用的 `worker` 对象。异步接口转给宿主的 API 注册表，
  只放行基础库在 `create` 时给出的 `APIList`。基础库同步取结果的接口（`*Sync`，以及要同步拿到 taskId 的 `createRequestTask` 等）直接失败：
  Worker 只能和页面异步通信，开发者工具用 SharedArrayBuffer 阻塞等待，那要求整个页面跨源隔离（COOP / COEP），跨域的图片等资源都会加载不了
- **Worker 分包**（`workers.isSubpackage`）：`wx.preDownloadSubpackage({ packageType: 'workers' })` 发的分包加载任务模块名是 `/workers.js`，
  只在配置为分包时成功，与开发者工具一致

---

## 热更新

文件变化后，能热更新的改动不刷新宿主、保留页面状态；其余改动整页刷新，恢复整个页面栈。

**分流**（`server/hmr.ts`）：一次改动里只有样式（所有 `.wxss`），以及页面、组件自己的 `.wxml` / `.js` 时热更新；
只要有一个其他文件（`app.js`、`.json`、普通模块、被引用的模板和 wxs、新增或删除的文件）就整页刷新。
文件监听（`server/watcher.ts`）把一次保存引起的变化合并成一批，内容没变的文件不算：uni-app 等框架的监听构建每次保存都会重写全部产物。

**应用**（`runtime/host/hmr.ts`）：

- 样式：在每个渲染层里原地替换，页面栈里不在前台的页面也一起更新
- 模板和逻辑借助基础库为开发者工具准备的接口 `__virtualDOM__.updateWxAppCode`（只在监听文件变化时开启，见 `server/html.ts`）：
  - 模板：按模板路径更新，基础库用实例当前的 data 重新渲染
  - `Page()` 构造的页面：不走基础库按 `.js` 路径的更新——那会重新挂载页面（onUnload → onLoad），data 回到初始值。
    这里把新方法换到活着的页面实例上，再重新注册 Page，之后新打开的页面用新代码
  - `Component()` 构造的页面和组件（uni-app 的页面也是）：状态常在框架自己的实例里（如 Vue 的 setup），
    换方法保不住，交给基础库按 `.js` 路径重新挂载这些实例；页面栈、globalData、其他页面不受影响
- 应用失败（如新代码执行出错）时退回整页刷新

**整页刷新保留页面栈**（`runtime/host/pageStackRestore.ts`）：wxa-runner 触发的整页刷新前记下每一页的路径和参数，启动后依次重新打开。
开发者手动刷新不经过这里，只按地址栏恢复当前页——手动刷新通常就是想从头来过。

`--no-watch`（如跑测试）时不监听文件、不开启热更新接口，运行环境与真机一致。

---

## setup 与测试 API

**setup 文件**（`server/setup.ts`、`runtime/host/setup.ts`）：

- 用 esbuild 把 setup 文件连同它 import 的文件打成一个浏览器 ES 模块。对 `@open-wxa/wxa-runner-core/setup` 的引用换成运行时自带的实现，
  小程序项目里不用安装本包
- 只把 `WXA_` 开头的环境变量交给 setup：setup 在浏览器里执行，其余环境变量可能是不该外泄的密钥
- 在逻辑层创建之前执行，顺序固定为 storage → mock → network → run。必须早于小程序启动：基础库会把读过的存储缓存在内存里，
  启动后再写入，`wx.getStorageSync` 读不到新值
- 配置写错或执行出错时模拟器显示错误，小程序不启动

**测试 API**（`runtime/host/testApi.ts`）：宿主启动时把 `window.__wxa_test_api__` 挂到宿主页面上，读取页面栈和 data、覆盖原生 API、拦截和记录请求、直接跳转。
`App.onLaunch` 里就调用的 API 等 `ready` 之后再 mock 已经晚了，所以宿主在 setup 之后、小程序启动前调用测试工具定义的 `window.__wxa_before_launch__`。

宿主启动的顺序：读取构建信息 → 安装测试 API → 执行 setup → 执行 `__wxa_before_launch__` → 启动小程序 → 恢复页面栈 → `ready` resolve。

**说明的来源**：测试 API 和 fixture 的说明只写在类型注释里（`WxaTestApi`、`MiniProgram`；fixture 转发的成员经映射类型复用 core 的注释）。
单元测试检查每个成员都有注释，以及测试 API 的每个成员都写进了 `docs/test-api.md` 的表格（`tests/unit/testApiDocs.test.ts`）。

## Playwright fixture

`@open-wxa/wxa-runner-playwright` 解决的是只用 Playwright 自带的 `webServer` 加测试 API 表达不了的问题：

- **服务器生命周期**：多个 worker 并行时，端口和服务器要自己管。fixture 每个 worker 启动一个 DevServer（随机端口，不监听文件），
  每个用例一个新的浏览器上下文
- **版本一致**：浏览器里的运行时和测试代码引用的类型可能不是同一个版本。core 作为 fixture 的普通依赖，由 fixture 启动服务器
- **自动重试**：`page.evaluate` 只读一次，跳转后要手动 `waitForPage`。`toHavePath` / `toHavePageData` 反复读取直到满足或超时
- **请求断言**：`network.routes` 在浏览器里匹配，命中的请求不经过代理，Playwright 拿不到请求体。宿主在匹配之前记录每个 `wx.request`，
  `requests()` / `waitForRequest()` 读取
- **打开页面前声明**：mock / unmock / route / unroute 按调用顺序记在 Node 侧，每次页面加载时在 `__wxa_before_launch__` 里重放。
  打开页面前声明的在 `App.onLaunch` 里就生效，整页重新加载后状态不变
- **Node 侧的处理函数**：函数形式的 mock / route 留在 Node 里执行，浏览器经 `page.exposeFunction` 的通道按编号调用。
  只能异步返回结果，所以基础库同步调用的 API 只能 mock 成对象。这个通道的返回值传到浏览器时，Buffer 等二进制会变成普通对象，
  所以 route 的二进制响应体先转成 base64、到浏览器里再还原；反过来浏览器传给 Node 的 ArrayBuffer 会变成 `{}`
  （`page.evaluate` 的返回值也是），小程序发出的二进制请求体包成 Uint8Array 传过去再换回
- **错误不被吞掉**：处理函数抛错时，浏览器里只是一次失败的调用，写在里面的断言会被忽略。fixture 记下这些错误，用例结束时抛出；
  再检查 `errors()` 为空（`wxaCheckErrors`）。整页重新加载前先取出当前页面上的错误，不会丢

---

## 服务层（core/server）

| 路由 | 内容 |
| --- | --- |
| `/` | 宿主页面 |
| `/__wxa__/app-info.json` | 构建信息（`__wxConfig`、页面列表、设备参数、setup）；构建失败时返回 `buildError`，宿主显示错误 |
| `/__wxa__/setup.js` | 打包后的 setup 文件 |
| `/__wxa__/runtime/*` | 浏览器运行时（`host.js`、`frame.js`、`worker.js`、`sw.js`）；`sw.js` 带 `Service-Worker-Allowed: /`，能接管根路径下的宿主页面 |
| `/__wxa__/appservice.html?path=&query=` | 逻辑层；`path` 写入 `appLaunchInfo` |
| `/__wxa__/subcontext.html?id=` | 3.7.1 起逻辑层里的子上下文 |
| `/__wxa__/webview/<page>.html?id=` | 渲染层 |
| `/__wxa__/module/<file>.js` | 单个业务模块，包括 `workers` 目录下的 |
| `/__wxa__/worker.js?id=` | Worker 的入口 |
| `/__wxa__/service-bootstrap.js`、`/__wxa__/page-frame.js` | 构建产物 |
| `/__wxa__/service-templates.js`、`page-templates.js`、`page-styles.js` | 两层的模板和渲染层的样式，热更新时重新下发 |
| `/__baselib__/*` | 基础库；`*.js.map` 是把它加入 DevTools 忽略列表的 source map |
| `/__wxa__/proxy/<协议>/<域名><路径>` | 网络代理，如 `/__wxa__/proxy/https/api.example.com/a?b=1`：原地址写在路径里，Network 面板的 Name 列显示接口名 |
| `/__wxa__/mock/<协议>/<域名><路径>` | 被拦截请求在 Network 面板里的地址，由 Service Worker 返回拦截规则给出的响应；到达服务器说明 Service Worker 没生效，返回 503 |
| `/__wxa__/tmp` | 临时文件：`POST ?type=png` 保存，返回可直接访问的地址；对该地址 `HEAD` 查大小、`DELETE` 删除；随服务器进程存在 |
| `/__wxa__/region/<districts\|streets>` | 地区选择器用的行政区划数据，取自本机开发者工具 |
| `/__wxa__/api/*` | `--devtools-login`：`wx.login` 的 code、手机号，服务市场、插件校验和插件信息的转发，只允许本机访问 |
| `/__wxa__/ws` | 文件变化通知：热更新（`hot`）、整页刷新（`reload`）、编译错误（`error`） |
| 其他 | 小程序目录下的静态资源 |

**网络代理**：小程序设置的请求头放在 `x-wxa-headers`（JSON）里传给代理，cookie、referer 等浏览器
禁止设置的请求头因此也能带上；响应头和 `set-cookie` 以 URL 编码的 JSON 返回。代理只监听本机地址，
用于开发环境。只转发小程序自己的请求：基础库自己的请求（数据上报、配置拉取等，带 `__skipDomainCheck__` 标记）
直接按失败返回，不发往网络，也不记入 `requests()`。唯一的例外是 InnerAudioContext 下载音频（见「原生组件」），同样不记入 `requests()`。

**Network 面板**（`runtime/networkPanel.ts`）：原地址写在代理的路径里而不是查询参数里，Name 列才显示接口名，按域名、路径过滤也直接可用。
被拦截的请求不经代理，为了也能在面板里看到，宿主照原请求再发一个 `/__wxa__/mock/…` 的同源请求，Service Worker（`runtime/sw.ts`）拦下它，
经 MessagePort 向宿主要拦截规则给出的响应（`host/api/mockMirror.ts`）。这个请求只用于显示，小程序拿到的结果不经过 Service Worker，
所以 Service Worker 没接管页面时（首次打开、强制刷新、局域网地址不是安全上下文）只是不显示，请求照常完成。
显示地址用同源的 `/__wxa__/mock/` 而不是原地址：Service Worker 没拦下时（DevTools 勾选了 Bypass for network）只会打到开发服务器，不会把本该拦截的请求发到真实后端。
Service Worker 用 Static Routing API 让其余请求直接走网络，不经过它。自动化测试（`navigator.webdriver`）里不注册：测试不看面板，
而且经过 Service Worker 的请求 Playwright 的 `page.route` 拦不到。

---

## 数据流

### 启动

```
1. 浏览器打开 /，host.js 读取 /__wxa__/app-info.json（构建失败时显示编译错误）
2. 安装测试 API，执行 setup 和 __wxa_before_launch__
3. 创建逻辑层 iframe：frame.js 准备全局变量和桥 → WAService.js 初始化，交出 App / Page / define / require
   → 加载业务模块（define）→ service-bootstrap.js 注册 json / wxml，require app.js、组件、页面
   → App.onLaunch / onShow
4. 宿主创建首页渲染层 iframe：WAWebview.js → page-frame.js → generateFuncReady
5. 宿主派发 onAppRoute(openType: appLaunch)
6. 基础库执行 Page.onLoad / onShow，通过 publish 把初始数据发给渲染层
7. 渲染层 exparser 创建节点树；逻辑层收到渲染完成后执行 onReady
8. wxa-runner 触发的整页刷新之后，依次重新打开刷新前的页面栈；完成后测试 API 的 ready resolve
```

### 用户点击

```
鼠标按下/抬起 → frame.js 转换为 touchstart/touchend
→ 渲染层 exparser 识别 tap，publish 事件到逻辑层
→ 基础库调用页面方法（如 handleTap），业务代码 setData
→ 逻辑层 publish 数据变更到渲染层 → exparser 更新 DOM
```

### 文件变化

```
chokidar → 合并一次保存引起的变化，跳过内容没变的文件
→ 按文件类型增量编译
→ 编译失败：推送 error，宿主覆盖显示编译器的错误；修复后自动恢复
→ 能热更新：推送 hot，宿主取回新的模板 / 样式 / 模块并应用，保留页面状态
→ 不能热更新、或者热更新失败：推送 reload，整页刷新后恢复整个页面栈
```

---

## 技术选型

| 维度 | 选择 | 理由 |
| --- | --- | --- |
| 语言 | TypeScript | 类型安全 |
| 包管理 | pnpm workspace | Monorepo |
| HTTP 服务器 | Express | 简单、中间件成熟 |
| WebSocket | ws | 轻量 |
| 文件监听 | chokidar | 跨平台 |
| ESM 转换、setup 打包 | esbuild | 快，带 source map |
| 构建 | tsup | Node 端 cjs + esm；浏览器端 iife |
| 测试 | Vitest + Playwright | 单元、集成、真实浏览器 e2e |

---

## 设计权衡

### 为什么不直接使用微信开发者工具？

开发者工具是桌面应用（旧版基于 NW.js，新版基于 Electron），只有 Windows 和 macOS 版本，难以在 CI 和无头浏览器中使用，
也无法被 Playwright 直接驱动。wxa-runner 只复用其中的核心运行时（基础库 + 编译器），抛弃桌面壳。

### 为什么使用 iframe 而不是 Web Worker？

渲染层需要 DOM；逻辑层的基础库也假设运行在有 `window` / `document` 的环境中（开发者工具里同样是网页）。
同源 iframe 还让同步 API 可以直接同步调用宿主。

### 为什么不重新实现基础库？

工作量巨大且难以保证一致。本项目最初的实现自己模拟了 App / Page 和渲染，
无法支持 setData 之外的大部分能力；换成官方基础库后，组件、wxs、事件系统都直接可用。

### 为什么内置基础库放在单独的仓库？

基础库是微信官方代码，版权归腾讯，不适用本项目的 MIT 协议，所以和本项目的代码分开，放在 [wxa-baselib](https://github.com/open-wxa/wxa-baselib) 仓库，
作为可选依赖从 GitHub 安装。安装失败不影响 wxa-runner 本身；有开发者工具的机器优先用开发者工具下载的版本，也能自由切换版本。
