---
title: uni-app 微信小程序 E2E 测试
titleTemplate: ':title | wxa-runner'
description: 给 uni-app 项目写微信小程序 E2E 测试：用 Vite 插件在浏览器里运行 mp-weixin 编译产物，本地热更新调试，用 Playwright 无头测试，setup 跳过登录，CI 里先构建再测试。
---

# uni-app 项目的 E2E 测试

wxa-runner 运行 uni-app 编译出的 `mp-weixin` 目录，由微信官方基础库渲染，和微信里运行的是同一份产物，不是 H5 版本。已在 Vue 3 的真实项目上验证。

## 编译产物在哪

| 项目 | 开发（监听构建） | 发行 |
| --- | --- | --- |
| 命令行创建的项目 | `npm run dev:mp-weixin` → `dist/dev/mp-weixin` | `npm run build:mp-weixin` → `dist/build/mp-weixin` |
| HBuilderX 创建的项目 | `unpackage/dist/dev/mp-weixin` | |

下文按命令行创建的项目来写，HBuilderX 的项目换成对应的目录。

## 在浏览器里运行和调试

在 `vite.config.ts` 里加上 Vite 插件，`npm run dev:mp-weixin` 时自动启动 wxa-runner，写法见[快速开始](./getting-started.md#uni-app)。

改了源码会自动[热更新](./hot-reload.md)：uni-app 的页面用 `Component()` 构造，改页面的 JS 只重新挂载这一页，页面栈、`globalData`、Pinia 等全局状态都保留。
调试方法和原生小程序一样，见[快速开始](./getting-started.md#调试)。

## setup 文件放在源码目录

`dist` 目录重新构建时可能被清空，所以 [setup 文件](./setup.md)放在源码根目录。用 Vite 插件时会自动找到项目根目录的 `wxa.setup.ts`；命令行启动时用 `--setup` 指定：

```bash
npx wxa-runner dev ./dist/dev/mp-weixin --setup ./wxa.setup.ts
```

## 写 E2E 测试

**1. 安装**

```bash
npm i -D @playwright/test @open-wxa/wxa-runner-playwright
```

用例在本机的 Google Chrome 里运行，没装时运行 `npx playwright install chrome`。

**2. 在源码根目录新建 `playwright.config.ts`**

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import type { WxaOptions } from '@open-wxa/wxa-runner-playwright';

export default defineConfig<WxaOptions>({
  testDir: 'e2e',
  use: {
    channel: 'chrome',
    // 编译产物目录，相对这个配置文件
    wxaProject: './dist/build/mp-weixin',
    // 没有 setup 文件时删掉这一行
    wxaServerOptions: { setup: './wxa.setup.ts' }
  }
});
```

**3. 写第一个用例**

```ts
// e2e/index.spec.ts
import { test, expect } from '@open-wxa/wxa-runner-playwright';

test('首页能打开', async ({ miniProgram }) => {
  await miniProgram.open('pages/index/index');
  // 换成你首页上的文字
  await expect(miniProgram.current.getByText('Hello')).toBeVisible();
});
```

页面路径和 `pages.json` 里写的一样。

**4. 先构建，再运行**

在 `package.json` 里加一个脚本，每次测试前重新构建：

```json
{
  "scripts": {
    "test:e2e": "npm run build:mp-weixin && playwright test"
  }
}
```

```bash
npm run test:e2e
```

本地开发时监听构建一直在跑，也可以把 `wxaProject` 改成 `./dist/dev/mp-weixin`，省掉构建。

用例的完整写法（mock 原生 API、拦截请求、断言请求体）见[用 Playwright 写微信小程序 E2E 测试](./testing.md)。

## 断言页面上的内容，不要断言页面 data

uni-app（Vue 3）的状态在 Vue 实例里（`ref`、`reactive`），交给小程序的是编译器生成的渲染数据，字段名是 `a`、`b` 这样的短名字。
所以 `toHavePageData`、`pageData()` 读到的不是源码里的状态，要断言页面上的文字和元素、跳转和发出的请求：

```ts
await miniProgram.current.locator('#submit').click();

await expect(miniProgram).toHavePath('pages/result/result');
await expect(miniProgram.current.getByText('提交成功')).toBeVisible();

const req = await miniProgram.waitForRequest('POST **/api/orders');
expect(req.body).toEqual({ skuId: 1, count: 2 });
```

模板里写的 `id`、`class` 编译后保留在页面上，可以直接用作选择器。

## 在 CI 里运行

CI 里先 `npm run build:mp-weixin`，再 `npx playwright test`，不需要开发者工具。完整配置见[在 CI 里跑小程序 E2E 测试](./ci.md)。

## 限制

- 真实项目上验证过的是 Vue 3 的 uni-app 项目
- 测的是 `mp-weixin` 编译产物，只覆盖微信小程序平台；`#ifdef` 条件编译里其他平台的代码不会运行
- 其他限制和原生小程序一样，见[功能与限制](./features.md#已知限制)
