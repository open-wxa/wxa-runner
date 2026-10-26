---
description: 一行命令在浏览器里运行微信小程序：原生小程序、uni-app、Taro 编译产物的启动方式，以及怎么用 Chrome DevTools 打断点、看请求、看页面结构。
---

# 快速开始

wxa-runner 在普通的 Chrome 里，用**微信官方基础库**运行小程序：用 Chrome DevTools 调试，用 Playwright 写自动化测试。
它不替代微信开发者工具，预览、上传、真机调试仍然要用开发者工具，区别见[功能与限制](./features.md#和微信开发者工具的区别)。

需要 Node.js ≥ 18。基础库和编译器不用另外准备，见[下文](#基础库和编译器)。

## 启动

### 原生小程序

在 `project.config.json` 所在目录运行：

```bash
npx wxa-runner dev . --open
```

### uni-app

先运行 uni-app 的监听构建，再在另一个终端里启动编译产物目录：

```bash
# 终端 1：uni-app 的监听构建
npm run dev:mp-weixin

# 终端 2
npx wxa-runner dev ./dist/dev/mp-weixin --open
```

HBuilderX 创建的项目，编译产物在 `unpackage/dist/dev/mp-weixin`。改了源码后 uni-app 重新构建，wxa-runner 自动[热更新](./hot-reload.md)。

### Taro 等其他框架

和 uni-app 一样：先运行框架的监听构建，再把编译产物目录传给 `wxa-runner dev`。

### 启动之后

```
[wxa-runner] 编译完成：3 个页面，1 个组件，17ms

  wxa-runner 已启动
  地址      http://localhost:3000
  项目      /path/to/my-app
  基础库    3.7.0
```

- 浏览器里是一台模拟的手机（默认 iPhone X），有导航栏和 tabBar，可以像在模拟器里一样点击、滚动
- 地址加上 `?path=` 直接打开某个页面，其余参数作为页面参数：`http://localhost:3000/?path=pages/detail/detail&id=1`
- 需要登录才能进的页面，用 [setup](./setup.md) 预置登录态

经常用或者要在 CI 里跑，装成开发依赖：`pnpm add -D wxa-runner`（或 `npm i -D wxa-runner`）。

## 调试

打开 Chrome DevTools（macOS 上 `Cmd+Option+I`，Windows 上 `F12`）：

- **打断点**：在 Sources 面板按 `Cmd+P`（Windows 上 `Ctrl+P`），输入文件名（如 `pages/index/index`）找到业务代码。
  每个 JS 文件单独加载，行号和源文件一致；用 `import` / `export` 写的文件带 source map
- **调用栈**：基础库的代码已加入 DevTools 的忽略列表，报错时的调用栈、单步调试都停在业务代码上，不会跳进基础库
- **控制台**：`App`、`Page` 的代码运行在逻辑层的 iframe 里。要在控制台里调用 `getCurrentPages()`、`wx.xxx`，
  先把控制台左上角的上下文从 `top` 切换到 `wxa-appservice`（`appservice.html`）
- **网络**：`wx.request` 由开发服务器转发，在 Network 面板里显示为 `/__wxa__/proxy/https/api.example.com/user/info`，
  Name 列是接口名，在过滤框输入域名或路径就能找到。被拦截规则拦下的请求不发往网络，显示为 `/__wxa__/mock/https/…`，
  响应是规则给出的，控制台同时打印 `[wxa-runner] 拦截请求`。拦下的请求靠 Service Worker 显示：第一次打开页面时它还没装好，
  从下一个请求开始显示；强制刷新（`Shift+Reload`）后、用局域网 IP 访问时不显示，请求本身不受影响
- **页面结构**：每个页面是一个 iframe，在 Elements 面板里能看到渲染出的节点和样式

## 基础库和编译器

本机有微信开发者工具就用它的，没有就用随依赖安装的内置版本，不用另外准备。

- 内置基础库（[wxa-baselib](https://github.com/open-wxa/wxa-baselib)）是可选依赖，安装失败时不会报错，只是在没有开发者工具的机器上启动时会提示找不到基础库
- 默认使用基础库 3.7.0 及以下的版本。3.7.1 起的版本要用 `--baselib` 或 `WXA_BASELIB` 指定，见[命令与环境变量](./cli.md#wxa-runner-baselib)

## 下一步

- [启动前准备（setup）](./setup.md)：跳过登录、mock 原生 API、拦截 `wx.request`
- [热更新](./hot-reload.md)：哪些改动不用刷新页面
- [在 Playwright 中测试](./testing.md)：写自动化测试
- [功能与限制](./features.md)：支持哪些组件和 API，和开发者工具的区别
