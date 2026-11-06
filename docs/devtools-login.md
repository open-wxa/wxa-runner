---
description: 用 --devtools-login 借本机微信开发者工具的登录态访问微信后台：真实的 wx.login code 和手机号、服务市场 wx.serviceMarket、插件页面，新版开发者工具需要打开的安全设置，以及安全设置里找不到「允许获取工具登录票据」时怎么办。
---

# 借用开发者工具登录态

有些能力要以开发者身份访问微信后台，浏览器里做不到。启动时加上 `--devtools-login`，wxa-runner 借本机微信开发者工具的登录态（开发者 ticket）代为请求，拿到真实结果：

- `wx.login` 的 code 和手机号：不加时也会成功，但 code 是假的，真实后端不认（见 setup 的[默认返回](./setup.md#mock)）
- [服务市场](#服务市场) `wx.serviceMarket`：不加时调用失败
- [插件](#插件)页面：不加时不下载插件代码，打不开插件页面

```bash
wxa-runner dev ./dist/dev/mp-weixin --devtools-login
```

以前叫 `--real-login`（Playwright 的 `wxaServerOptions` 里是 `realLogin`），旧名已移除。

## 开启前的准备

1. 开发者工具里登录的微信账号，要是 `project.config.json` 里这个 appid 的开发者
2. 新版开发者工具（Electron 版，如 2.02.2609231）：在「设置 → 安全设置」里打开 **服务端口** 和 **允许获取工具登录票据**。
   建议也打开「自动化接口打开工具时默认信任项目」，否则开发者工具会弹窗问是否信任项目，点信任后才能继续。
   设置了「CLI 访问令牌」时，把它设成环境变量 `WECHAT_DEVTOOLS_CLI_TOKEN`。旧版开发者工具不需要这一步
3. 安全设置里**找不到**「允许获取工具登录票据」时，见下面的[取不到票据](#取不到票据)

<details class="details custom-block">
<summary>为什么新版要这些设置</summary>

新版不再把登录态明文存在磁盘上，要向正在运行的开发者工具要：启动时 wxa-runner 用开发者工具的命令行为项目开启自动化接口，
开发者工具没在运行时会启动它，项目窗口没开时会打开。旧版照旧读磁盘上保存的登录态。

</details>

- 登录态过期时，在开发者工具里重新登录即可，不用重启。也可以用环境变量 `WECHAT_DEV_TICKET` 直接指定 ticket
- 请求失败时调用返回失败并说明原因，不会退回模拟数据
- 开发者 ticket 很快过期，不适合 CI。CI 里请用 setup 的 [`mock`](./setup.md#mock) 和 [`network.routes`](./setup.md#network)

## 取不到票据

「允许获取工具登录票据」这个开关**不是每个 appid 都有**：开发者工具先问微信后台这个 appid 能不能取票据，不能就根本不显示这个开关，
本机怎么设置都改不出来。

这时 `wx.login` 仍然能拿到真实的 code：wxa-runner 改让开发者工具的模拟器自己调 `wx.login`，这条路不查那个名单。
终端会提示一次，调用方不用改。拿到的 code 和真机一样，能用 appsecret 换到 `session_key`。
唯一的例外是你在开发者工具里 mock 过 `wx.login`——那样拿到的是 mock 值。

手机号、服务市场和插件没有这条路，调用时会失败：

- **最直接的办法：换一个能取到票据的开发者工具版本。** 取不到票据是某些版本的开发者工具（本文测试的是 Nightly `2.02.2611062`）
  新加的限制；换用能正常显示「允许获取工具登录票据」、能取到票据的版本（一般是正式版 Stable），手机号、服务市场、插件就都照常工作。
  **要用 `--devtools-login` 拿真实手机号，就别用会拦票据的这版工具。** 下面几条是换不了版本时的退路：
- **手机号、服务市场**：去掉 `--devtools-login`，用 setup 的 [`mock`](./setup.md#mock) 和 [`network.routes`](./setup.md#network)
  造数据来测业务流程。拿不到真实手机号，但页面和接口的逻辑能跑通
- **插件页面**：没有替代办法。插件代码要用开发者身份向微信下载，浏览器侧造数据补不出插件包，
  没有可用票据时插件页面打不开
- 另有办法拿到票据时（比如在能取票据的机器上取好），可以用环境变量 `WECHAT_DEV_TICKET` 传进来。
  票据很快过期，适合临时验证，不适合长期用

<details class="details custom-block">
<summary>为什么手机号不行</summary>

手机号的开关在微信后台，不在开发者工具这边。模拟器取手机号时，先向后台请求 `jsgetuserwxphone`：**后台放不放手机号包，
在你点授权弹窗之前就已经定了**。取不到票据的这个 appid，后台这一步直接返回失败（`-10000` 一类），于是弹的是报错框，根本不会弹授权框。

那个「允许」按钮不是一道能绕过去的关：按钮只有在后台已经把包给出来之后才出现，点它只是把**已经拿到的包**回传给小程序，
不发任何确认请求、不生成票据。所以没有哪一步是前端能替你点通的——后台不放包，就是没有。
（开发者工具里的「测试号」选项也能弹出手机号，但那是本地造的虚拟号，没有合法 `session_key` 能解密，不是真号。）

自动化协议里只有 `Tool.getTicket` 能取票据，它就是被上面那道检查拦住的那个；
`Tool.refreshTicket` 只刷新不返回，`Tool.setTicket` 是反方向的注入。没有第二个出口——除非换一个能取到票据的开发者工具版本。

</details>

## 服务市场

`wx.serviceMarket.invokeService` 也要借开发者工具的登录态：加了 `--devtools-login` 时，请求经开发服务器发给微信服务市场，拿到真实结果；没加时直接失败，提示加上它。

- 项目的 appid 要在服务市场开通了这项服务，否则 `invokeService` 失败，错误里带着微信返回的错误码（如 `9301010 consumption failure`）和 requestId
- 只转发服务市场的请求，基础库发出的其他 `operateWXData` 不会带上开发者的登录态发给微信
- 需要 3.7.1 及以上的基础库（用 `--baselib` 指定）。3.7.0 及以前的版本在浏览器里加载不了它所在的 SDK，调用时报 `Fatal: unexpected loadSdkSubPackage case`

## 插件

插件代码不在项目里，要用开发者的登录态向微信下载。加了 `--devtools-login` 时，开发服务器下载 `app.json` 里声明的插件，
用 `wx.navigateTo` 或 `navigator` 打开的 `plugin://别名/页面` 和真机一样显示，插件里的网络请求照常发出。

- 项目的 appid 要在小程序管理后台「设置 → 第三方设置 → 插件管理」里添加了插件，并经插件开发者通过，否则终端提示微信返回的原因
- 没加 `--devtools-login` 时不下载插件，终端提示加上它；跳转插件页面时报 `page "…" is not found`，小程序自己的页面照常可用
- 插件代码只放在内存里，同一个插件版本只下载一次，重启开发服务器后重新下载
- 暂不支持插件的自定义组件（`usingComponents` 里的 `plugin://`）和业务代码里的 `requirePlugin`；分包里声明的插件也还没有下载（[#56](https://github.com/open-wxa/wxa-runner/issues/56)）
- 测试 API 的 `navigateTo` 等路由方法不认 `plugin://` 地址，要从页面里点击或调用 `wx.navigateTo` 打开插件页面
