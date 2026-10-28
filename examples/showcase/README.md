# showcase 示例

覆盖 wxa-runner 主要功能的小程序，`tests/e2e/showcase.test.ts` 和 `tests/integration/devserver.test.ts` 都用它。

- 首页、详情、我的：基础渲染、自定义组件、路由、tabBar，由 e2e 测试逐项断言
- less：`project.config.json` 开启了 less 编译插件（`useCompilerPlugins: ["less"]`）。全局样式写在 `app.less`，
  「我的」页只有 `mine.less`，用到 `app.less` 的变量和 `styles/mixins.less` 的 mixin
- 「能力」tab：原生组件和 API 的演示页，用来在开发者工具和浏览器里人工对照。每个页面底部有事件日志，
  记下事件名和参数（带毫秒时间，新的在上），完整内容同时打到控制台

## 对照方法

在仓库根目录运行：

```bash
pnpm build
node packages/cli/bin/wxa-runner.js dev examples/showcase --open
```

另外用微信开发者工具导入 `examples/showcase`，然后两边打开同一个页面，做同样的操作，对比画面和事件日志。

对照之前先统一两边的环境：

- **基础库版本**：wxa-runner 启动时会打印它用的基础库版本，开发者工具在「详情 → 本地设置 → 调试基础库」里选同一个；
  或者反过来，用 `--baselib <版本>` 让 wxa-runner 用开发者工具的版本
- **域名校验**：在开发者工具的「详情 → 本地设置」里勾选「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」，
  否则网络音视频、downloadFile、web-view 在开发者工具里会被拦下
- **网络**：网络音视频、网络图片、地图、web-view 要联网；音视频和图片都有包内版本（`assets/`），不联网也能对照

## 「能力」里的页面

| 页面 | 内容 |
| --- | --- |
| video 视频 | 包内与网络视频、VideoContext、弹幕、全屏、cover-view。包内视频画面里的数字是秒数 |
| 音频 | InnerAudioContext（包内 / 网络 / 不存在的地址）、audio 组件、BackgroundAudioManager。包内音频是四个各 1 秒的音 |
| camera 相机 | 拍照、录像、切换摄像头和闪光灯 |
| 图片与文件 | chooseImage / chooseMedia、previewImage、getImageInfo、saveImageToPhotosAlbum、downloadFile 与 saveFile、image 的 mode |
| canvas 画布 | type="2d"（可以手指画线）、旧版 canvas-id、webgl、canvasToTempFilePath |
| map 地图 | 标记点、气泡、label、折线、圆、MapContext、地图事件 |
| 表单组件 | input 的各种 type、textarea、switch、slider、checkbox、radio、form 提交、editor |
| picker 选择器 | 普通、range-key、多列联动、时间、日期、省市区（三种 level）、picker-view |
| 滚动与手势 | 点击与长按、事件冒泡、scroll-view（含自定义下拉刷新）、swiper、movable-view、页面滚动 |
| 界面 API | toast、loading、modal、actionSheet、导航栏、下拉刷新 |
| 设备与开放接口 | 设备与窗口信息、剪贴板、定位、扫码、登录与授权、服务市场 invokeService 等 |
| 路由与生命周期 | 各种路由方法和应该失败的跳转、页面栈、各实例的生命周期顺序 |
| 插件 | 快递100「快递跟踪」插件（kdPlugin）：用 wx.navigateTo 和 navigator 组件打开 plugin:// 插件页面。appid 要已添加该插件；wxa-runner 里要加 `--devtools-login` 才能下载插件代码 |
| web-view | 允许嵌入和禁止嵌入的两个网页，事件显示在导航栏标题上 |

「能力」页本身是 tab 页，底部有 tabBar API（badge、红点、显示隐藏、样式）。
