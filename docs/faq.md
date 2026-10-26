---
description: wxa-runner 常见问题：能不能替代微信开发者工具，和 miniprogram-automator 的区别，CI 里不装开发者工具怎么跑小程序 E2E 测试，uni-app、Taro 支持，跳过登录、mock wx.request，基础库版本。
---

# 常见问题

## wxa-runner 是什么？

wxa-runner 是微信小程序的 E2E 测试和调试工具：在普通的 Chrome 里，用微信官方基础库运行小程序。
它不把小程序转成 H5，而是加载官方的基础库和编译器，自己只实现微信客户端的「原生层」：
消息桥、页面栈、原生 API，以及导航栏、tabBar、弹窗等原生界面。

运行起来之后，用 Chrome DevTools 调试，用 Playwright 写 E2E 测试，CI 里可以无头运行。

## 能替代微信开发者工具吗？

不能。预览、上传、真机调试仍然要用开发者工具，插件的自定义组件也暂不支持。
wxa-runner 用在本地开发调试和跑自动化测试上，区别见[功能与限制](./features.md#和微信开发者工具的区别)。

## 和 miniprogram-automator 有什么区别？

miniprogram-automator 是微信官方的自动化 SDK，控制开发者工具的模拟器或真机，要有装了开发者工具的 Windows 或 macOS 机器。
wxa-runner 在浏览器里运行，Linux CI 上不需要开发者工具，但不支持真机，插件也只支持插件页面。

两者适用的场景不同，也可以一起用，见[和 miniprogram-automator 对比](./vs-miniprogram-automator.md)。

## CI 里没装开发者工具，能跑小程序的 E2E 测试吗？

能。没有开发者工具时，wxa-runner 用随依赖安装的内置基础库 3.7.0，和微信官方 npm 包 `miniprogram-compiler` 里的编译器，
在 Linux 上也能无头运行。用 [Playwright fixture](./testing.md) 写好用例后，CI 里运行 `npx playwright test` 即可。

没有开发者工具时有这些限制：

- 只支持 x86-64
- 编译器版本较旧，模板运行时有少量差异（如单页最多 16000 个节点），地区选择器不可用

GitHub Actions 的完整配置见[在 CI 里跑小程序 E2E 测试](./ci.md)。

## 支持 uni-app、Taro 吗？

支持。wxa-runner 运行的是编译产物，把 uni-app、Taro 编译出的 `mp-weixin` 目录传给它：

```bash
npx wxa-runner dev ./dist/dev/mp-weixin
```

开发时先运行框架的监听构建，改了源码后 wxa-runner 自动热更新，见[快速开始](./getting-started.md#uni-app)。
真实项目上目前验证过的是 uni-app（Vue 3）；Taro 等框架的编译产物也是标准的小程序代码，但还没在真实项目上验证。
uni-app 项目怎么配置测试、断言时要注意什么，见 [uni-app 项目的 E2E 测试](./uni-app.md)。

## 需要登录才能进的页面怎么测？

在 [setup 文件](./setup.md)里跳过登录，不用改业务代码。按小程序判断「已登录」的方式选写法：

- 只检查本地有没有 token：用 `storage` 预置 token
- 调 `wx.login` 拿 code 换 token：用 `network.routes` 拦截换 token 的接口，直接返回 token
- 后端一定要真实的 code，或者要真实手机号：启动时加 `--devtools-login`，借本机开发者工具的登录态，见[借用开发者工具登录态](./devtools-login.md)。
  开发者 ticket 很快过期，CI 里用前两种

写法见 setup 的[跳过登录](./setup.md#跳过登录)。

## 怎么 mock wx.request、wx.getLocation 这类原生 API？

两个地方都能写，写法一样：

- 对所有页面、整个开发过程生效的，写在 setup 文件的 [`mock`](./setup.md#mock) 和 [`network.routes`](./setup.md#network) 里
- 只对某个用例生效的，在用例里调用 `miniProgram.mock()`、`miniProgram.route()`，会覆盖 setup 里的同名配置

```ts
await miniProgram.mock('getLocation', { latitude: 31.23, longitude: 121.47 });
await miniProgram.route('GET **/api/feed', { body: { list: [] } });
```

`wx.request` 发出的请求都会记录下来，可以断言请求体，见[检查发出的请求](./testing.md#检查发出的请求)。

## 支持哪些基础库版本？

默认使用 3.7.0 及以下的基础库：本机开发者工具下载过的版本优先，没有时用内置的 3.7.0。
已验证 2.32.3、3.3.4、3.5.8、3.7.0。

3.7.1 起的版本不会自动选用，要用 `--baselib` 或环境变量 `WXA_BASELIB` 指定，启动时提示超出已验证的范围。
内置基础库只有 3.7.0，更新的版本要先在开发者工具里下载，见[命令与环境变量](./cli.md#wxa-runner-baselib)。

## 和真机上的表现一致吗？

渲染、组件、`setData`、生命周期都是微信官方基础库的代码，和真机一致。
导航栏、tabBar、弹窗和原生 API 由 wxa-runner 实现，和真机可能有差异；还没实现的 API 调用后返回成功，
用 Playwright fixture 时用例会因此失败，见[检查运行时错误](./testing.md#检查运行时错误)。

自动化测试能发现大部分问题，发布前仍然要在真机上验证。

## 不用 Playwright 可以吗？

可以。页面上的 `window.__wxa_test_api__` 能读取页面 data、mock 原生 API、拦截请求、跳转页面，
任何能操作浏览器的工具都能调用，见[测试 API](./test-api.md)。Playwright fixture 也是基于它实现的。

## 支持插件、Worker、蓝牙吗？

Worker 支持，但 Worker 里不能用同步接口和网络请求。插件页面支持，要加 `--devtools-login`，见[插件](./devtools-login.md#插件)；
插件的自定义组件和 `requirePlugin` 暂不支持（[#56](https://github.com/open-wxa/wxa-runner/issues/56)）。蓝牙不支持，其他不支持的能力见[已知限制](./features.md#已知限制)。
用到这些能力的页面，可以在开发者工具里用 miniprogram-automator 测试。
