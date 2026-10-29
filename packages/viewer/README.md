# @open-wxa/wxa-viewer

不带源码、不开开发服务器，在浏览器里运行小程序：

1. 在本机用 `wxa-runner viewer pack` 把小程序编译成一个 `.wxapack` 包
2. 把包拖进查看器页面，就在浏览器里运行。查看器是静态网页，可以用 `wxa-runner viewer preview` 在本机打开，也可以导出后放到任意静态托管

渲染用的是 [wxa-runner](../../README.md) 的宿主运行时和微信官方基础库，表现和 `wxa-runner dev` 一致。

命令挂在 `wxa-runner viewer` 下面，实现在这个包里，执行时才加载：`wxa-runner` 不依赖它，只用 `dev` 的人不会多装 esbuild-wasm 等依赖；没装这个包时，命令会提示怎么装。

> 这个包目前是 `private`，没有发布到 npm，查看器命令只能在仓库里用：先 `pnpm install && pnpm build`，再用 `node packages/cli/bin/wxa-runner.js` 代替下文的 `npx wxa-runner`。

编译只在第一步做一次，查看器里不需要编译器，也不需要小程序源码。导入的包、setup 和环境变量（如 token）存在浏览器的 IndexedDB 里，刷新、关掉再打开都还在，不会上传到任何服务器。

## 打包

```bash
# 原生小程序：在 project.config.json 所在目录
npx wxa-runner viewer pack .

# uni-app：先构建，再打包编译产物；setup 文件放在源码目录
npm run build:mp-weixin
npx wxa-runner viewer pack ./dist/build/mp-weixin --setup ./wxa.setup.ts -o my-app.wxapack
```

默认输出到当前目录的 `<appid>.wxapack`。项目目录下有 `wxa.setup.ts` 时会一起打进包里；setup 可以 `import` 其他文件，打包时一并打进去。
包里是编译好的模板、样式、业务代码和图片等资源，不含基础库。

## 在本机打开

```bash
npx wxa-runner viewer preview my-app.wxapack --open
```

浏览器打开后自动导入这个包。之后也可以不带包启动（`npx wxa-runner viewer preview`），把 `.wxapack` 拖进页面导入。

## 在查看器里配置

- **导入**：把 `.wxapack` 拖到页面上的任意位置，或点「选择文件」。导入的项目都列在左侧，点击切换
- **setup**：把 `wxa.setup.ts`（或 `.js`、`.mjs`）拖进来，或者直接在「启动配置」里编辑后保存，会覆盖包里自带的 setup；「恢复为包里的」撤销覆盖。
  在查看器里设置的 setup 只能是单个文件，不能 `import` 其他文件，需要的话在打包时用 `--setup` 打进包里。写法见 wxa-runner 的[启动前准备（setup）](../../docs/setup.md)
- **环境变量**：在「环境变量」里填 `WXA_` 开头的变量，setup 从 `env` 里读取。token 不用写进 setup 文件：

```ts
export default defineSetup(({ env }) => ({
  storage: { token: env.WXA_TOKEN }
}));
```

每次保存后小程序会重新启动。

## 部署

```bash
npx wxa-runner viewer export ./viewer-export
```

导出两样东西：

- `site/`：纯静态站点，交给任意静态托管就行（Nginx、GitHub Pages、对象存储、各家 Pages 服务），不需要配置响应头或改写规则
- `proxy.mjs`：转发 `wx.request` 的处理函数，只用标准 Fetch API（`Request` → `Response`）

浏览器不允许跨域访问你的接口时才需要转发。接口本身允许跨域，或者请求全部用 setup 拦截了，只部署 `site/` 就够了。

想让别人打开就能看到小程序，导出时用 `--pack` 带上默认包（可以写多次）：

```bash
npx wxa-runner viewer export ./viewer-export --pack my-app.wxapack
```

包会放在 `site/__wxa__/preload/` 下。访问者的浏览器里还没有项目时自动导入，之后就和自己导入的项目一样，能改 setup 和环境变量；
把项目全部删掉再刷新，默认包会重新导入。要指定打开哪个包，链接里带上 `?pack=/__wxa__/preload/my-app.wxapack`。

要转发时，把路径以 `/__wxa__/proxy/` 开头的请求交给 `proxy.mjs`，其余请求交给 `site/`。`allowedHosts` 是能转发到的域名，`*.example.com` 匹配所有子域名；
为空时拒绝转发，免得部署出去的查看器变成谁都能用的代理。接到哪个平台由你决定，下面以 Cloudflare Workers 为例（`site/` 作为静态资源，`proxy.mjs` 放在同一目录）：

```js
// worker.js
import { createProxyHandler, PROXY_PATH } from './proxy.mjs';

export default {
  fetch(request, env) {
    if (!new URL(request.url).pathname.startsWith(PROXY_PATH)) return env.ASSETS.fetch(request);
    return createProxyHandler({ allowedHosts: env.WXA_ALLOWED_HOSTS })(request);
  }
};
```

```jsonc
// wrangler.jsonc
{
  "name": "wxa-viewer",
  "main": "worker.js",
  "compatibility_date": "2026-10-28",
  "assets": { "directory": "./site", "binding": "ASSETS", "run_worker_first": ["/__wxa__/proxy/*"] },
  "vars": { "WXA_ALLOWED_HOSTS": "api.example.com,*.example.com" }
}
```

部署前注意：

- 基础库是微信官方代码，版权归腾讯所有。查看器不要公开访问，用托管平台的访问控制（如 Cloudflare Access、HTTP 基本认证）限制只有自己或团队能打开
- 请求经托管平台的服务器转发到你的接口。接口在国内、或者会拦截数据中心 IP 时可能变慢或失败，先用一个接口试一下

## 限制

- 不支持插件和[借用开发者工具登录态](../../docs/devtools-login.md)，它们要用到本机的开发者工具
- 没有热更新：改了代码要重新打包、重新导入
- 包和查看器要用同一个基础库版本。不一致时页面会提示，用对应版本重新打包（`-b`），或导出带这个版本的查看器
- 地区选择器不可用
- 小程序写入的文件（`wx.getFileSystemManager()`、临时文件）放在浏览器的内存里，浏览器回收 Service Worker 后会丢失
- 查看器要用 Service Worker，只能通过 `localhost` 或 HTTPS 地址打开

## 命令

| 命令 | 选项 |
| --- | --- |
| `wxa-runner viewer pack <项目目录>` | `-o, --out <文件>` 输出文件（默认 `<appid>.wxapack`）；`-b, --baselib <版本>`；`--setup <文件>` / `--no-setup` |
| `wxa-runner viewer preview [包…]` | `-p, --port <端口>`；`--host [地址]`；`-b, --baselib <版本>`；`-o, --open` |
| `wxa-runner viewer export <输出目录>` | `-b, --baselib <版本>`；`--force` |

## 和 wxa-runner 的关系

查看器只通过 `@open-wxa/wxa-runner-core` 的公开导出使用 wxa-runner：Node 端用根入口（`AppBuilder`、`bundleSetup`、`handleProxy` 等），
浏览器、Service Worker、转发处理函数里用不依赖 Node 的 `@open-wxa/wxa-runner-core/web`（`routeApp`、`FileStore`、`proxyFetch` 等）。
`tests/unit/viewer/boundary.test.ts` 检查这条边界：查看器不能用相对路径引用 core 的源码，core 也不引用查看器。
