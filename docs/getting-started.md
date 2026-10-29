---
description: 一行命令在浏览器里运行微信小程序：原生小程序、uni-app、Taro 编译产物的启动方式，以及怎么用 Chrome DevTools 打断点、看请求、看页面结构。
---

# 快速开始

wxa-runner 在 Chrome 里用微信官方基础库运行小程序。需要 Node.js ≥ 18，基础库和编译器不用另外装。

## 启动

### 原生小程序

在 `project.config.json` 所在目录运行：

```bash
npx wxa-runner dev . --open
```

### uni-app

装上 Vite 插件，`npm run dev:mp-weixin` 时自动启动 wxa-runner：

```bash
pnpm add -D @open-wxa/unplugin-wxa-runner @open-wxa/wxa-runner-core
```

```ts
// vite.config.ts
import uni from '@dcloudio/vite-plugin-uni';
import wxaRunner from '@open-wxa/unplugin-wxa-runner/vite';

export default defineConfig({
  plugins: [uni(), wxaRunner()]
});
```

首轮编译完成后终端打印 wxa-runner 的地址，改了源码页面会自动[热更新](./hot-reload.md)。
插件要求 Node.js 20.19 / 22.12 及以上，端口、setup 等选项见[插件文档](https://github.com/open-wxa/wxa-extensions/tree/main/packages/unplugin#readme)。

<details class="details custom-block">
<summary>不用插件：两个终端分别启动</summary>

```bash
npm run dev:mp-weixin                            # 终端 1
npx wxa-runner dev ./dist/dev/mp-weixin --open   # 终端 2
```

HBuilderX 创建的项目，产物在 `unpackage/dist/dev/mp-weixin`。

</details>

Taro 等其他框架：先跑框架的监听构建，再用 `npx wxa-runner dev <编译产物目录>` 启动。

---

浏览器里会出现一台模拟手机，可以像模拟器一样点击、滚动。接下来常用的：

- 直接打开某一页：`http://localhost:3000/?path=pages/detail/detail&id=1`
- 跳过登录：见[启动前准备（setup）](./setup.md)
- 长期使用或在 CI 里跑：装成开发依赖 `pnpm add -D wxa-runner`

## 调试

打开 Chrome DevTools（macOS `Cmd+Option+I`，Windows `F12`）：

| 想做什么 | 怎么做 |
| --- | --- |
| 打断点 | Sources 面板按 `Cmd+P`（Windows `Ctrl+P`），输入文件名，如 `pages/index/index` |
| 在控制台调用 `getCurrentPages()`、`wx.xxx` | 先把控制台左上角的上下文从 `top` 切到 `wxa-appservice` |
| 看 `wx.request` | Network 面板，地址形如 `/__wxa__/proxy/https/api.example.com/user/info` |
| 看页面结构 | Elements 面板，每个页面是一个 iframe |

报错和单步调试停在业务代码上，不会跳进基础库。

<details class="details custom-block">
<summary>被 setup 拦下的请求在 Network 里是什么样</summary>

显示为 `/__wxa__/mock/https/…`，控制台同时打印 `[wxa-runner] 拦截请求`。
它们靠 Service Worker 显示：第一次打开页面时，它装好之前的请求不显示；强制刷新（`Shift+Reload`）后、用局域网 IP 访问时不显示。请求本身不受影响。

</details>

## 下一步

- [启动前准备（setup）](./setup.md)：跳过登录、mock 原生 API、拦截 `wx.request`
- [在 Playwright 中测试](./testing.md)：写自动化测试
- [功能与限制](./features.md)：支持哪些组件和 API，和开发者工具的区别
