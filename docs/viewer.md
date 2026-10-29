---
description: 用 wxa-runner viewer 把小程序打成 .wxapack 包，不带源码、不开开发服务器，在浏览器里运行；可以导出成静态站点部署，发链接给别人看。
---

# 查看器：不带源码在浏览器里运行

查看器把小程序打成一个 `.wxapack` 包，拿到包的人在浏览器里就能运行，不需要源码和开发服务器，表现和 `wxa-runner dev` 一致。
查看器本身是静态网页，可以在本机打开，也可以部署后发链接给别人，比如这个[在线预览](https://wxa-viewer.picfinder.workers.dev)（接口都由 setup 用 mock 数据应答）。

> **目前只能在仓库里用：**
> 查看器还没有发布到 npm。先在 [wxa-runner 仓库](https://github.com/open-wxa/wxa-runner)里执行 `pnpm install && pnpm build`，
> 再用 `node packages/cli/bin/wxa-runner.js` 代替下文的 `npx wxa-runner`。

## 打包

```bash
# 原生小程序：在 project.config.json 所在目录
npx wxa-runner viewer pack .

# uni-app：先构建，再打包编译产物；setup 文件放在源码目录
npm run build:mp-weixin
npx wxa-runner viewer pack ./dist/build/mp-weixin --setup ./wxa.setup.ts -o my-app.wxapack
```

默认输出到当前目录的 `<appid>.wxapack`，包里是编译好的代码和图片等资源，不含基础库。项目目录下的 `wxa.setup.ts` 会一起打进包里，它 `import` 的文件也一样。

## 在本机打开

```bash
npx wxa-runner viewer preview my-app.wxapack --open
```

打开后自动导入这个包。也可以不带包启动，再把 `.wxapack` 拖进页面。

## 在查看器里配置

- **导入**：把 `.wxapack` 拖到页面上任意位置，或点顶栏的「导入」。导入的项目在顶栏的项目菜单里切换、重命名和删除
- **setup**：把 `wxa.setup.ts`（或 `.js`、`.mjs`）拖进来，或者在右侧面板的「setup」里编辑后点「保存 setup」，会覆盖包里自带的 setup；点「恢复为包里的」撤销。
  在查看器里设置的 setup 只能是单个文件，不能 `import` 其他文件，需要的话在打包时用 `--setup` 打进包里。写法见[启动前准备（setup）](./setup.md)
- **环境变量**：在「环境变量」里填 `WXA_` 开头的变量，setup 从 `env` 里读取，token 就不用写进 setup 文件：

```ts
export default defineSetup(({ env }) => ({
  storage: { token: env.WXA_TOKEN }
}));
```

每次保存后小程序重新启动。导入的包、setup 和环境变量存在浏览器的 IndexedDB 里，刷新、关掉再打开都还在，不会上传到任何服务器。

## 部署

```bash
npx wxa-runner viewer export ./viewer-export
```

导出两样东西：

- `site/`：纯静态站点，交给任意静态托管就行（Nginx、GitHub Pages、对象存储、各家 Pages 服务），不需要配置响应头或改写规则
- `proxy.mjs`：转发 `wx.request` 的处理函数，只用标准 Fetch API（`Request` → `Response`）

接口允许跨域，或者请求全部用 setup 拦截了，只部署 `site/` 就够了。

### 默认打开的小程序

想让别人打开链接就能看到小程序，导出时用 `--pack` 带上默认包（可以写多次）：

```bash
npx wxa-runner viewer export ./viewer-export --pack my-app.wxapack
```

访问者的浏览器里还没有项目时自动导入，之后和自己导入的项目一样；把项目全部删掉再刷新，会重新导入。要指定打开哪个包，链接后面加上 `?pack=/__wxa__/preload/my-app.wxapack`。

### 转发请求

接口不允许跨域时，把路径以 `/__wxa__/proxy/` 开头的请求交给 `proxy.mjs`，其余交给 `site/`。
`allowedHosts` 是允许转发到的域名，`*.example.com` 匹配所有子域名；为空时拒绝转发，免得查看器变成谁都能用的代理。

<details class="details custom-block">
<summary>Cloudflare Workers 示例</summary>

`site/` 作为静态资源，`proxy.mjs` 放在同一目录：

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

</details>

### 部署前注意

- 站点里带着完整的基础库，每个访问者都能下载到；基础库是微信官方代码，版权归腾讯所有。包里有未发布的代码，或小程序会请求真实接口时，用托管平台的访问控制（如 Cloudflare Access、HTTP 基本认证）只让自己或团队打开
- 转发的请求从托管平台的服务器发出。接口在国内、或会拦截数据中心 IP 时可能变慢或失败，先用一个接口试一下

## 限制

- 不支持插件和[借用开发者工具登录态](./devtools-login.md)，它们要用到本机的开发者工具
- 没有热更新：改了代码要重新打包、重新导入
- 包和查看器要用同一个基础库版本。不一致时页面会提示，用对应版本重新打包（`-b`），或导出带这个版本的查看器
- 地区选择器不可用
- `uploadFile`、`downloadFile` 不经过 setup 的拦截规则，会真的发出去
- 小程序写入的文件（`wx.getFileSystemManager()`、临时文件）放在浏览器的内存里，浏览器回收 Service Worker 后会丢失
- 查看器要用 Service Worker，只能通过 `localhost` 或 HTTPS 地址打开

## 命令

| 命令 | 选项 |
| --- | --- |
| `wxa-runner viewer pack <项目目录>` | `-o, --out <文件>` 输出文件（默认 `<appid>.wxapack`）；`-b, --baselib <版本>`；`--setup <文件>` / `--no-setup` |
| `wxa-runner viewer preview [包…]` | `-p, --port <端口>`；`--host [地址]`；`-b, --baselib <版本>`；`-o, --open` |
| `wxa-runner viewer export <输出目录>` | `-b, --baselib <版本>`；`--force`；`--pack <文件>` 默认包，可以写多次 |
