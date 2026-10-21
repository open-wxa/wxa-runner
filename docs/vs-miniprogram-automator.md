---
title: wxa-runner 与 miniprogram-automator 对比
titleTemplate: 微信小程序自动化测试方案怎么选
description: 微信小程序自动化测试的两种方案：官方的 miniprogram-automator 控制开发者工具和真机，wxa-runner 在浏览器里用 Playwright 无头运行。运行环境、Linux / CI、真机、mock、插件的区别，怎么选，以及常用写法对照。
---

# wxa-runner 与 miniprogram-automator 对比

[miniprogram-automator](https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/) 是微信官方的小程序自动化 SDK：用 Node.js 脚本控制微信开发者工具，
也能通过真机调试控制手机，跳转页面、读取页面 data、点击元素、mock `wx` 上的方法。

wxa-runner 不控制开发者工具，而是在普通的 Chrome 里用官方基础库运行小程序，测试直接用 Playwright 写。

两者都能写小程序的 E2E 测试，适用的场景不同，也可以一起用。

- **miniprogram-automator**：在开发者工具的模拟器或真机上运行，要有装了开发者工具的 Windows 或 macOS 机器
- **wxa-runner**：在浏览器里运行，可以无头运行，Linux CI 上不需要开发者工具；不支持真机

## 对比

| | miniprogram-automator | wxa-runner |
| --- | --- | --- |
| 维护方 | 微信官方 | 社区开源项目，还在 0.x 阶段 |
| 运行在 | 开发者工具的模拟器；也能通过真机调试控制手机 | 普通的 Chrome，可以无头运行 |
| 开发者工具 | 需要 1.02.1907232 及以上，并在安全设置里打开「CLI/HTTP 调用」 | 不需要，没装时用内置的基础库和编译器；装了就用它的 |
| 操作系统 | 开发者工具只有 Windows、macOS 版 | Windows、macOS、Linux。没有开发者工具时只支持 x86-64 |
| 真机 | 支持，`miniProgram.remote()` | 不支持 |
| 基础库 | 2.7.3 及以上 | 默认 3.7.0 及以下，更新的版本要用 `--baselib` 指定 |
| 渲染、组件、生命周期 | 官方基础库 | 官方基础库 |
| 导航栏、tabBar、弹窗、原生 API | 开发者工具或微信客户端提供 | wxa-runner 自己实现，没实现的 API 调用后返回成功，测试里会[报出来](./testing.md#检查运行时错误) |
| 写测试 | 自己的 API（`miniProgram`、`Page`、`Element`），搭配任意 Node.js 测试框架；Python 有官方的 Minium | Playwright 的 locator 和断言，加上 `miniProgram` fixture；不用 Playwright 时调用[测试 API](./test-api.md) |
| mock 原生 API | `mockWxMethod` | [`mock`](./testing.md#mock-原生-api、拦截请求)，可以写在 setup 里，也可以写在用例里 |
| 网络请求 | 用 `mockWxMethod` 替换 `wx.request` 的结果 | 按 URL 规则拦截 `wx.request`，记录发出的请求，可以断言请求体 |
| 插件 | 支持，有 `callPluginWxMethod`、`mockPluginWxMethod` | 不支持 |
| 截图 | `screenshot()`，只在开发者工具的模拟器里可用 | Playwright 的截图、录屏、trace |
| 调试 | 开发者工具的调试器 | Chrome DevTools |

miniprogram-automator 一列取自[官方文档](https://developers.weixin.qq.com/miniprogram/dev/devtools/auto/quick-start.html)。

## 怎么选

**用 miniprogram-automator 更合适：**

- 要在真机上跑自动化
- 小程序用了插件，或者要测 wxa-runner 不支持的能力，如 Worker、蓝牙，见[已知限制](./features.md#已知限制)
- 要用开发者工具才有的功能，如多账号调试、体验评分
- 已经有装好开发者工具的 Windows、macOS 测试机，用例也已经用 automator 写好

**用 wxa-runner 更合适：**

- 要在 Linux CI 上无头跑 E2E，不想维护装了开发者工具的机器
- 想用 Playwright 的工具：UI 模式、trace、并行运行、自动重试的断言
- 测试里要跳过登录、mock 大量接口：在 [setup](./setup.md) 里预置登录态，按 URL 拦截请求并断言请求体
- 开发时用 Chrome DevTools 调试，改代码后[热更新](./hot-reload.md)

**一起用**：日常提交在 Linux CI 上用 wxa-runner 跑，发版前用 automator 在开发者工具或真机上回归。预览、上传始终在开发者工具里做。

## 选 wxa-runner 前要确认的限制

- 不替代开发者工具：预览、上传、真机调试仍然要用开发者工具
- 默认使用 3.7.0 及以下的基础库。更新的版本要用 `--baselib` 或 `WXA_BASELIB` 指定，超出已验证的范围
- 导航栏、tabBar、原生 API 由 wxa-runner 实现，和真机可能有差异；发布前仍然要在真机上验证
- 没有开发者工具时（如 Linux CI）只支持 x86-64，编译器版本较旧，模板运行时有少量差异
- 真实项目上只验证过 uni-app（Vue 3）。Taro 等框架的编译产物也是标准的小程序代码，但还没在真实项目上验证

完整的列表见[功能与限制](./features.md)。

## 和编译成 H5 再测试的区别

uni-app、Taro 都能把项目编译成 H5，再用 Playwright 测 H5 页面。这时运行的是框架为 H5 重新实现的组件和 API，
和小程序里运行的不是同一套代码，`setData`、WXSS、自定义组件相关的问题可能测不出来。原生小程序也没有 H5 版本。

wxa-runner 运行的是 `mp-weixin` 编译产物，由官方基础库渲染，和小程序里运行的是同一份代码。

## 常用写法对照

已经用 miniprogram-automator 写过用例时，可以参照下表改写。右边是 [Playwright fixture](./testing.md) 的写法：

| miniprogram-automator | wxa-runner |
| --- | --- |
| `automator.launch({ projectPath })` | `playwright.config.ts` 里的 `wxaProject`，fixture 自动启动 |
| `miniProgram.reLaunch('/pages/index/index')` | `miniProgram.open('pages/index/index')` |
| `(await page.$('#submit')).tap()` | `miniProgram.current.locator('#submit').click()` |
| `page.data()` | `miniProgram.pageData()` |
| `miniProgram.currentPage()`、`miniProgram.pageStack()` | 同名方法，返回每页的 `path`、`query` |
| `miniProgram.navigateTo(url)` 等跳转 | 同名方法 |
| `miniProgram.mockWxMethod('getLocation', result)` | `miniProgram.mock('getLocation', result)` |
| `miniProgram.restoreWxMethod('getLocation')` | `miniProgram.unmock('getLocation')` |
| `miniProgram.mockWxMethod('request', result)` | `miniProgram.route('GET **/api/feed', { body: { list: [] } })`，只拦截匹配的请求 |
| `miniProgram.close()` | 不用写，用例结束时 fixture 自动清理 |
