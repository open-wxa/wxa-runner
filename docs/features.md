---
description: wxa-runner 和微信开发者工具的区别，支持的项目类型、组件和 API，已验证的基础库版本，以及 Worker、蓝牙等已知限制。
---

# 功能与限制

## 和微信开发者工具的区别

wxa-runner 用的是和开发者工具同一套官方基础库，渲染、组件、生命周期的行为一致。区别在运行的地方和用途：

| | wxa-runner | 微信开发者工具 |
| --- | --- | --- |
| 运行在 | 普通的 Chrome，可以无头运行 | 开发者工具的模拟器 |
| 调试 | Chrome DevTools | 开发者工具的调试器 |
| 自动化测试 | Playwright 直接操作页面，Linux、CI 上也能跑 | 要远程控制开发者工具，只能在 Windows、macOS 上运行 |
| 需要安装开发者工具 | 不需要，没装时用内置的基础库和编译器 | — |
| 预览、上传、真机调试 | 不支持 | 支持 |
| 插件 | 支持插件页面，要加 [`--devtools-login`](./devtools-login.md#插件) | 支持 |

适合本地开发调试、跑自动化测试；发布相关的事情仍然在开发者工具里做。

## 支持的项目

| 项目 | 说明 |
| --- | --- |
| 原生小程序 | 直接运行 `project.config.json` 所在目录 |
| uni-app | 运行编译产物目录（如 `dist/dev/mp-weixin`），已在 Vue 3 的真实项目上验证 |
| Taro 等其他框架 | 运行编译产物目录。编译产物是标准的小程序代码，目前在真实项目上验证过的只有 uni-app |

## 支持的能力

| 能力 | 支持 |
| --- | --- |
| 渲染 | WXML、WXSS、WXS、自定义组件，App / Page / Component 生命周期 |
| 样式预处理 | 开发者工具的 less / sass 编译插件（`project.config.json` 的 `setting.useCompilerPlugins`），规则见下文 |
| 路由 | navigateTo、redirectTo 等页面路由，10 层页面栈，tabBar |
| 分包 | 普通分包、独立分包，分包预下载（preloadRule），分包异步化：跨分包引用组件（componentPlaceholder）和 JS（require.async）。代码启动时全部加载，没有下载过程 |
| Worker | wx.createWorker：和 Worker 互发消息（包括 ArrayBuffer）、terminate，workers 配置为分包。Worker 里能用异步的文件接口 |
| 界面 | 导航栏、tabBar（包括自定义 tabBar）、toast / modal / actionSheet，默认模拟 iPhone X |
| 组件 | picker、canvas、camera、video、map（需要联网）、web-view |
| 媒体 | chooseImage、chooseMedia（图片和视频）、chooseVideo 由浏览器选文件，previewImage、getImageInfo，保存到相册即下载；InnerAudioContext 播放音频 |
| 网络 | request、上传、下载由开发服务器转发（没有跨域限制），WebSocket |
| 存储 | Storage、FileSystemManager 基本操作 |
| 登录、用户信息等开放接口 | 返回固定的假数据，支付、扫码默认失败，[默认返回什么](./setup.md#mock)。可以用 setup mock，或用[借用开发者工具登录态](./devtools-login.md)拿真实的 code。服务市场 `wx.serviceMarket` 要加 `--devtools-login` 才能调用，见[服务市场](./devtools-login.md#服务市场) |

基础库已验证 2.32.3、3.3.4、3.5.8、3.7.0；3.7.1 和 3.8.8 上全部测试也通过，但默认不会选用，见下文。

## less / sass

`project.config.json` 里开启了编译插件时（如 `"useCompilerPlugins": ["less"]`），按开发者工具的规则把 `.less` / `.scss` / `.sass` 编译成同名的 WXSS：

- 开箱即用，和开发者工具一样不用另装编译器：项目里安装了 `less` / `sass` 时用项目里的版本，没装时用 wxa-runner 自带的（less 4、sass 1.99）
- 同一路径既有 `.less`（或 `.scss` / `.sass`）又有 `.wxss` 时用预处理文件的编译结果，`.wxss` 不生效
- 每个 `.less` 自动引用小程序根目录的 `app.less`，能直接用里面的变量和 mixin（可以用 `setting.lessSetting.commonUseFilePath` 换成别的文件）；
  `.scss` / `.sass` 自动 `@use` 根目录的 `global.scss` 或 `global.sass`，通过 `global.$变量` 使用
- `["less", { "globalVars": { ... } }]` 给出的全局变量在每个 `.less` 里都能用
- `@import "x.wxss";` 原样保留，交给 WXSS 编译器处理
- 开发中修改 `useCompilerPlugins` 等设置后重新编译，不用重启

没有开启编译插件时，`.less` / `.scss` 文件不会生效（开发者工具也一样），启动时会在终端提示。

## 已知限制

- **基础库版本**：3.7.1 起的基础库不会自动选用，要用 `--baselib` 或 `WXA_BASELIB` 指定，启动时提示超出已验证的范围。
  内置基础库只有 3.7.0，更新的版本要先在开发者工具里下载
- **未实现的 API**：还没有实现的原生 API 调用后返回成功，以免打断业务代码。测试里会被发现，见[检查运行时错误](./testing.md#检查运行时错误)
- **设备能力**：不支持蓝牙等设备能力
- **TypeScript 编译插件**：`useCompilerPlugins` 里的 `typescript` 不支持，`.ts` 文件不会被加载，要先编译成 `.js`
- **地图**：MapContext 的 toScreenLocation、fromScreenLocation、地面覆盖物等方法在基础库的网页实现里没有，调用后不会回调
  （详见[设计文档](https://github.com/open-wxa/wxa-runner/blob/main/PROJECT_DESIGN.md#原生组件)）
- **插件**：只支持插件页面，要加 `--devtools-login`；插件的自定义组件和 `requirePlugin` 暂不支持（[#56](https://github.com/open-wxa/wxa-runner/issues/56)）
- **Worker 里的接口**：只能用异步接口，如 FileSystemManager 的 readFile、writeFile。同步接口（readFileSync 等）调用时报错；
  request、downloadFile、uploadFile、connectSocket 也不能用，基础库要同步拿到它们的任务编号。Worker 和页面之间只能异步通信，
  同步等结果要求整个页面跨源隔离，跨域的图片等资源会因此加载不了
- **没有开发者工具时**（如 Linux、CI）：只支持 x86-64；编译器版本较旧，模板运行时有少量差异（如单页最多 16000 个节点）；地区选择器不可用
