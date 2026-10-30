---
description: wxa-runner 和微信开发者工具的区别，支持的项目类型、组件和 API，已验证的基础库版本，以及 Worker、蓝牙等已知限制。
---

# 功能与限制

## 和微信开发者工具的区别

两者用同一套官方基础库，渲染、组件、生命周期的行为一致，区别在运行的地方和用途：

| | wxa-runner | 微信开发者工具 |
| --- | --- | --- |
| 运行在 | 普通的 Chrome，可以无头运行 | 开发者工具的模拟器 |
| 调试 | Chrome DevTools | 开发者工具的调试器 |
| 自动化测试 | Playwright 直接操作页面，Linux、CI 上也能跑 | 要远程控制开发者工具，只能在 Windows、macOS 上运行 |
| 需要安装开发者工具 | 不需要，没装时用内置的基础库和编译器 | — |
| 预览、上传、真机调试 | 不支持 | 支持 |
| 插件 | 支持插件页面，要加 [`--devtools-login`](./devtools-login.md#插件) | 支持 |

wxa-runner 用来本地调试和跑自动化测试，发布相关的事仍然在开发者工具里做。

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

`project.config.json` 开启编译插件时（如 `"useCompilerPlugins": ["less"]`），按开发者工具的规则把 `.less` / `.scss` / `.sass` 编译成同名的 WXSS：

- 不用另装编译器：项目里装了 `less` / `sass` 时用项目里的，没装时用 wxa-runner 自带的（less 4、sass 1.99）
- 同一路径同时有 `.less`（或 `.scss` / `.sass`）和 `.wxss` 时，用预处理文件，`.wxss` 不生效
- 每个 `.less` 自动引用根目录的 `app.less`，能直接用里面的变量和 mixin（用 `setting.lessSetting.commonUseFilePath` 换成别的文件）；
  `.scss` / `.sass` 自动 `@use` 根目录的 `global.scss` 或 `global.sass`，用 `global.$变量` 访问
- `["less", { "globalVars": { ... } }]` 给出的全局变量在每个 `.less` 里都能用
- `@import "x.wxss";` 原样保留，交给 WXSS 编译器处理
- 开发中改了 `useCompilerPlugins` 等设置会重新编译，不用重启

没开启编译插件时，`.less` / `.scss` 不生效（开发者工具也一样），启动时终端会提示。

## 已知限制

- **基础库版本**：3.7.1 起不会自动选用，要用 `--baselib` 或 `WXA_BASELIB` 指定，启动时提示超出已验证的范围。内置的只有 3.7.0，更新的版本先在开发者工具里下载
- **未实现的 API**：调用后返回成功，以免打断业务代码；测试里会被发现，见[检查运行时错误](./testing.md#检查运行时错误)
- **设备能力**：不支持蓝牙等设备能力
- **TypeScript 编译插件**：不支持 `useCompilerPlugins` 里的 `typescript`，`.ts` 文件要先编译成 `.js`
- **地图**：MapContext 的 toScreenLocation、fromScreenLocation、地面覆盖物等方法基础库的网页实现里没有，调用后不会回调（[设计文档](https://github.com/open-wxa/wxa-runner/blob/main/PROJECT_DESIGN.md#原生组件)）
- **插件**：只支持插件页面，要加 `--devtools-login`；插件的自定义组件和 `requirePlugin` 暂不支持（[#56](https://github.com/open-wxa/wxa-runner/issues/56)）
- **Worker 里的接口**：只能用异步接口（如 FileSystemManager 的 readFile、writeFile），同步接口调用时报错；request、downloadFile、uploadFile、connectSocket 也不能用。
  因为基础库要同步拿到它们的任务编号，而 Worker 和页面之间只能异步通信：同步等待要求整个页面跨源隔离，跨域的图片等资源会因此加载不了
- **web-view 的 Cookie**：网页和模拟器不是同一个站点时，Cookie 多半不生效，要开新窗口模式，见下文
- **没有开发者工具时**（如 Linux、CI）：只支持 x86-64；编译器版本较旧，模板运行时有少量差异（如单页最多 16000 个节点）；地区选择器不可用

## web-view 的 Cookie

web-view 的网页默认嵌在模拟器页面（`http://localhost:端口`）的 iframe 里。网页不在 localhost 上时（如 `https://h5.example.com`），浏览器把它当成跨站嵌入的第三方页面：
服务端下发的 `SameSite=Lax`、`Strict` 或不写 SameSite 的 Cookie 存不下来，JS 写的 Cookie 也写不进去，登录态因此丢失。微信里的小程序没有这个问题，web-view 里的网页是顶层页面。
协议不同也算跨站：https 的 localhost 网页嵌在 http 的模拟器里同样受影响。遇到这种情况，控制台会提示一次。

需要 Cookie 时开启新窗口模式：命令行加 `--webview-window`，Playwright 用 `test.use({ wxaWebView: 'window' })`（见[测试 web-view 里的网页](./testing.md#web-view-里的网页)）。
网页在一个手机尺寸的新窗口里打开，用真实的域名和协议，Cookie 和在浏览器里直接打开一样。模拟器里 web-view 的位置显示一个占位：

- 窗口跟着 web-view 所在的页面：跳到下一页、切换 tab 时关闭，返回时用当前的 `src` 重新打开；页面关闭、模拟器刷新时一起关闭
- 浏览器拦截了弹出窗口，或者窗口被手动关掉后，点占位里的「在新窗口打开 H5」按钮打开

新窗口模式和微信里的差异：

- `SameSite=Strict` 的 Cookie 在网页第一次加载时不会带上（窗口由模拟器打开，对网页来说是跨站跳转），之后网页自己的请求正常
- 返回 web-view 所在页面时网页重新加载，滚动位置、填了一半的表单等状态会丢失
- 不触发 `bindload`：拿不到跨域窗口的加载完成事件
- 网页设置了 `Cross-Origin-Opener-Policy: same-origin` 时，模拟器拿不到这个窗口：开发时窗口不会跟着页面关闭，`src` 改变或返回页面时会再开一个窗口。
  Playwright 里由 fixture 替模拟器关掉旧窗口，始终只留一个
- 开发时新窗口和浏览器的普通标签页共用 Cookie；微信里 web-view 的 Cookie 是独立的
- 网页里调用 `wx.miniProgram.*` 暂不支持（两种模式都一样）
