---
title: 在 CI 里跑微信小程序 E2E 测试
titleTemplate: ':title | wxa-runner'
description: 不装微信开发者工具，在 GitHub Actions 的 Linux 机器上无头运行小程序 E2E 自动化测试：内置基础库和编译器，原生小程序和 uni-app 的完整配置，限制和排查方法。
---

# 在 CI 里跑小程序 E2E 测试

微信开发者工具只有 Windows、macOS 版。靠它跑自动化测试时，CI 要准备一台装好开发者工具的机器。

wxa-runner 在浏览器里运行小程序。没有开发者工具时，它用随依赖安装的内置基础库 3.7.0，和微信官方 npm 包 `miniprogram-compiler` 里的编译器，
在 GitHub Actions 的 Linux 机器上就能无头运行。wxa-runner 自己的测试也是这样在 CI 里跑的。

## 准备

先在本地按[用 Playwright 写微信小程序 E2E 测试](./testing.md)写好用例，确认 `npx playwright test` 能通过。

- `@open-wxa/wxa-runner-playwright` 装在 `devDependencies` 里，CI 安装依赖时会一起装上内置基础库和编译器
- `playwright.config.ts` 里用的是 `channel: 'chrome'`，GitHub Actions 的 Linux 机器自带 Google Chrome

## GitHub Actions

### 原生小程序

```yaml
# .github/workflows/e2e.yml
name: E2E

on:
  push:
    branches: [main]
  pull_request:

jobs:
  e2e:
    # 自带 Google Chrome。要用 x86-64 的机器，ARM 的不行
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm

      - run: npm ci

      - run: npx playwright test
```

### uni-app、Taro 等框架

测试前先构建出 `mp-weixin` 目录，`playwright.config.ts` 里的 `wxaProject` 指向它。以 uni-app 为例：

```yaml
      - run: npm ci

      # 构建到 dist/build/mp-weixin
      - run: npm run build:mp-weixin

      - run: npx playwright test
```

uni-app 的配置和写法见 [uni-app 项目的 E2E 测试](./uni-app.md)。

### 其他 CI

GitLab CI、Jenkins 等也可以，机器要满足：

- Linux x86-64，Node.js ≥ 18
- 装有 Google Chrome。没有时运行 `npx playwright install --with-deps chrome`

## 限制

没有开发者工具时：

- 只支持 x86-64
- 基础库只有内置的 3.7.0
- 编译器版本较旧，模板运行时有少量差异（如单页最多 16000 个节点），地区选择器不可用
- 不能用 `--devtools-login`：开发者 ticket 很快过期。登录用 setup 的 [`mock`](./setup.md#mock) 和 [`network.routes`](./setup.md#network) 跳过

完整的列表见[功能与限制](./features.md#已知限制)。

## 排查

**启动时提示找不到基础库**：内置基础库是可选依赖，安装失败时不会报错。重新安装依赖，确认 `node_modules` 里有 `@open-wxa/wxa-baselib`。

**本地通过，CI 上失败**：本地装了开发者工具时，用的是它下载过的基础库和它自带的编译器，和 CI 不同。
本地先用和 CI 一样的基础库版本跑一遍：

```bash
WXA_BASELIB=3.7.0 npx playwright test
```

仍然只在 CI 上失败时，多半是上面列出的编译器差异，或者 CI 上的网络环境不同：没有被 mock 的请求在 CI 上真的会发出去。
