---
description: 小程序页面上的 window.__wxa_test_api__：不用 Playwright fixture 时，直接用它读取页面 data、mock 原生 API、拦截和记录 wx.request、跳转页面。
---

# 测试 API

wxa-runner 在浏览器页面上提供 `window.__wxa_test_api__`，能读取页面状态、mock 原生 API、拦截请求、直接跳转页面，[Playwright fixture](./testing.md) 就是基于它实现的。

用 Playwright 时推荐用 fixture，写起来更简单；用其他测试工具，或不想多装一个包时，再直接调用它。

## 在 Playwright 中直接使用

先装上命令行和类型：

```bash
pnpm add -D @playwright/test wxa-runner @open-wxa/wxa-runner-core
```

用 Playwright 自带的 `webServer` 启动开发服务器。跑测试时加 `--no-watch`，不热更新，运行环境和真机一致：

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  webServer: {
    command: 'npx wxa-runner dev . --no-watch --port 3000',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI
  },
  use: { baseURL: 'http://localhost:3000', channel: 'chrome' }
});
```

在用例里打开页面，等小程序启动完成，再通过 `page.evaluate` 调用测试 API：

```ts
/// <reference types="@open-wxa/wxa-runner-core/test-api" />
import { test, expect } from '@playwright/test';

test('提交后跳转到结果页', async ({ page }) => {
  // 打开指定页面，等小程序启动完成
  await page.goto('/?path=pages/form/form');
  await page.waitForFunction(() => window.__wxa_test_api__);
  await page.evaluate(() => window.__wxa_test_api__.ready);

  // 每个页面是一个 iframe，iframe[data-current] 始终是当前页
  const current = page.frameLocator('iframe[data-current]');
  await current.locator('#submit').click();

  const result = await page.evaluate(() =>
    window.__wxa_test_api__.waitForPage('pages/result/result')
  );
  expect(result.query).toEqual({ status: 'ok' });
});

// 运行时错误、调用了未实现的 API 都不会让测试失败，要自己检查
test.afterEach(async ({ page }) => {
  const errors = await page.evaluate(
    () => window.__wxa_test_api__.errors()
  );
  expect(errors).toEqual([]);
});
```

完整示例见 [tests/e2e/showcase.test.ts](https://github.com/open-wxa/wxa-runner/blob/main/tests/e2e/showcase.test.ts)。

## 成员

| 成员 | 作用 |
| --- | --- |
| `ready` | 小程序启动完成后 resolve 的 Promise |
| `currentPage()` / `pageStack()` | 当前页 / 整个页面栈，每页有 `path`、`query`、`webviewId`、`frameName`（可用于 `page.frame({ name })`） |
| `waitForPage(path, timeout?)` | 等到指定页面成为当前页，默认超时 10 秒 |
| `pageData(path?)` | 页面的 `data`（拷贝）。不传 `path` 时读当前页；页面不在页面栈里时为 `null` |
| `callPageMethod(name, ...args)` | 调用当前页的方法，返回方法的返回值（返回 Promise 时等它完成）。参数要能 JSON 序列化 |
| `mock(api, impl)` / `unmock(api?)` | 覆盖原生 API，写法同 setup 的 [`mock`](./setup.md#mock)。`unmock()` 不传参数时撤销全部 |
| `route(pattern, handler)` / `unroute(pattern?)` | 拦截 `wx.request`，写法同 setup 的 [`network.routes`](./setup.md#network)，后添加的优先。`unroute()` 不传参数时删除全部 |
| `requests(pattern?)` / `clearRequests()` | 小程序发出的 `wx.request`：方法、地址、请求头、请求体 `data`、拦截它的规则 `routedBy`。被拦截的和真正发出的都有，只保留最近 1000 个 |
| `navigateTo` / `navigateBack` / `redirectTo` / `reLaunch` / `switchTab` | 直接跳转页面，同 `wx` 上的同名 API |
| `getStorage(key)` / `clearStorage()` | 读取 / 清空小程序的存储 |
| `errors()` | 逻辑层、渲染层的运行时错误，以及业务代码调用过的未实现 API（`api` 为 API 名称，每个 API 记一次） |

`mock`、`route` 整页刷新后失效。详细说明见类型注释（`WxaTestApi`）。

## 启动前声明 mock 和拦截

`App.onLaunch`、首页 `onLoad` 里就调用的 API，等 `ready` 之后再 mock 就晚了。除了写进 [setup](./setup.md)，还可以在页面脚本执行前定义 `window.__wxa_before_launch__`：
wxa-runner 在 setup 之后、小程序启动前调用它，等它完成才启动小程序，这里的 mock 覆盖 setup 里的同名 mock：

```ts
await page.addInitScript(() => {
  window.__wxa_before_launch__ = api => {
    api.mock('login', { code: 'test_code' });
    api.route('POST **/api/auth/login', {
      body: { token: 'test-token' }
    });
  };
});
await page.goto('/');
```

函数可以是 async 的。抛错时模拟器显示错误，小程序不启动。fixture 的「打开页面前 mock」就是这样实现的。

## 类型

把 `@open-wxa/wxa-runner-core` 加为开发依赖后，上面示例第一行的引用给 `window.__wxa_test_api__` 提供类型（也可以写进 tsconfig 的 `compilerOptions.types`）。
写 mock 时用到的 `ApiHandler`、`WxaTestApi` 等类型也从这个包导入。

## 注意事项

- 没有实现的 `wx` API 仍返回成功，以免打断业务代码，但会在 `errors()` 里记一条；基础库内部调用的原生接口不记。用到的要 mock 掉
- `wx.request` 不能 mock，要用 `route` 或 setup 的 `network.routes` 拦截
- 跳转后的选择器、text 组件的文字等，和用 fixture 时一样，见[在 Playwright 中测试](./testing.md#注意事项)
