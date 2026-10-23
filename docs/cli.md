---
description: wxa-runner 命令行：dev 启动开发服务器的选项（端口、局域网访问、基础库版本、setup、报错转发到终端、借用开发者工具登录态），baselib 管理基础库，以及 WXA_BASELIB 等环境变量。
---

# 命令与环境变量

| 命令 | 作用 |
| --- | --- |
| [`wxa-runner dev <项目目录>`](#wxa-runner-dev) | 启动开发服务器，在浏览器里运行小程序，改动后热更新 |
| [`wxa-runner baselib list`](#wxa-runner-baselib) | 列出可用的基础库及兼容性 |
| [`wxa-runner baselib extract [版本]`](#wxa-runner-baselib) | 解包基础库（`dev` 会自动执行） |

没装成开发依赖时在前面加 `npx`，如 `npx wxa-runner dev .`。

## wxa-runner dev

```bash
wxa-runner dev <项目目录> [选项]
```

`<项目目录>` 是小程序目录：原生项目的 `project.config.json` 所在目录，或 uni-app、Taro 等框架编译出的 `mp-weixin` 目录。

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `-p, --port <端口>` | `3000` | 端口号。默认端口被占用时自动换用后面的端口 |
| `--host [地址]` | `localhost` | 监听地址。只写 `--host` 时开放局域网访问 |
| `-b, --baselib <版本>` | 最新的兼容版本 | 基础库版本，见 [wxa-runner baselib](#wxa-runner-baselib) |
| `--setup <文件>` | 自动查找 | 小程序启动前执行的 [setup 文件](./setup.md)，路径相对当前目录。不指定时使用项目目录下的 `wxa.setup.ts` / `.js` / `.mjs` |
| `--no-setup` | | 不执行 setup 文件 |
| `--no-watch` | | 不监听文件变化、不热更新，运行环境与真机一致。跑测试时用 |
| `-o, --open` | | 启动后打开浏览器 |
| `--forward-console` | 检测到编程助手时开启 | `console.warn` / `console.error` 也转发到终端，见[报错转发到终端](#报错转发到终端) |
| `--no-forward-console` | | 报错不转发到终端 |
| `--devtools-login` | | 借本机开发者工具的登录态访问微信后台：真实的 `wx.login` code 和手机号、服务市场 `wx.serviceMarket`、插件，见[借用开发者工具登录态](./devtools-login.md) |

常见用法：

```bash
# 原生小程序，启动后打开浏览器
wxa-runner dev . --open

# uni-app：先运行 uni-app 的监听构建，再启动编译产物；setup 文件放在源码目录
wxa-runner dev ./dist/dev/mp-weixin --setup ./wxa.setup.ts

# 用指定的基础库版本
wxa-runner dev . --baselib 3.5.8

# 给测试用：不热更新，端口固定
wxa-runner dev . --no-watch --port 3000

# 开放局域网访问
wxa-runner dev . --host
```

地址带上 `?path=` 直接打开指定页面，其余参数作为页面参数：`http://localhost:3000/?path=pages/detail/detail&id=1`。

### 报错转发到终端

页面里的报错默认打印到终端，栈只留业务代码：

```
[wxa-runner] 逻辑层（pages/index/index）报错：Cannot read properties of undefined (reading 'name')
    at bo.loadList (pages/index/index.js:9:23)
```

在编程助手（Claude Code、Codex、Cursor 等）里启动时，`console.warn` / `console.error` 也会转发。

## wxa-runner baselib

| 命令 | 作用 |
| --- | --- |
| `wxa-runner baselib list` | 列出可用的基础库：本机开发者工具下载过的和内置的，标出默认使用的版本 |
| `wxa-runner baselib extract [版本]` | 解包基础库到 `~/.wxa-runner/baselib`，输出所在目录。内置基础库不用解包，直接输出所在目录 |

基础库的来源和版本：

- 本机微信开发者工具下载过的版本优先；没有时用随依赖安装的内置基础库 3.7.0（[wxa-baselib](https://github.com/open-wxa/wxa-baselib)）
- 不指定版本时选最新的兼容版本（≤ 3.7.0）
- 3.7.1 起的版本要用 `--baselib` 或 `WXA_BASELIB` 指定，启动时提示超出已验证的范围；内置基础库只有 3.7.0，新版本要先在开发者工具里下载

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `WXA_BASELIB` | 没有用 `--baselib` 指定时使用的基础库版本 |
| `WXA_DEVTOOLS_PATH` | 开发者工具不在默认位置时，指定安装目录（如 macOS 上的 `.app` 目录），新旧版本都可以 |
| `WXA_VENDOR_DIR` | 指定基础库目录（开发者工具的 `WeappVendor`） |
| `WXA_WCC` / `WXA_WCSC` | 直接指定 WXML / WXSS 编译器，优先于开发者工具和 miniprogram-compiler |
| `WECHAT_DEV_TICKET` | `--devtools-login` 使用的开发者 ticket，优先于开发者工具的登录态 |
| `WECHAT_DEVTOOLS_CLI_TOKEN` | 开发者工具设置了「CLI 访问令牌」时设成它：`--devtools-login` 调用的开发者工具命令行从这里读取令牌 |
| `WXA_*` | 所有 `WXA_` 开头的变量都传给 setup 文件，见 [setup 的环境变量](./setup.md#不把-token-写死在文件里) |
