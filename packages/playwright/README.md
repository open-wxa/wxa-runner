# @open-wxa/wxa-runner-playwright

在 Playwright 里测试微信小程序：每个 worker 自动启动 [wxa-runner](https://github.com/open-wxa/wxa-runner) 开发服务器，
用例里直接拿到 `miniProgram`，能读页面 `data`、断言小程序发出的请求，跳转后不用手动等待。

```bash
pnpm add -D @playwright/test @open-wxa/wxa-runner-playwright
```

```ts
// playwright.config.ts，放在小程序项目目录（project.config.json 所在目录）
import { defineConfig } from '@playwright/test';
import type { WxaOptions } from '@open-wxa/wxa-runner-playwright';

export default defineConfig<WxaOptions>({
  testDir: 'e2e',
  use: { channel: 'chrome' }
});
```

```ts
// e2e/order.spec.ts
import { test, expect } from '@open-wxa/wxa-runner-playwright';

test('提交订单后跳转到结果页', async ({ miniProgram }) => {
  await miniProgram.mock('login', { code: 'test_code' });   // 打开前声明，App.onLaunch 里就生效
  await miniProgram.route('POST **/api/orders', { status: 201, body: { id: 'o-1' } });
  await miniProgram.open('pages/cart/cart');

  await miniProgram.current.locator('#submit').click();

  await expect(miniProgram).toHavePath('pages/result/result');
  await expect(miniProgram).toHavePageData({ orderId: 'o-1' });
  expect((await miniProgram.waitForRequest('POST **/api/orders')).body).toEqual({ skuId: 1, count: 2 });
});
```

- `miniProgram` 的每个成员都有类型注释，编辑器里悬停就能看到说明
- `mock`、`route` 可以传 Node 里的函数，能用用例里的变量、检查参数；函数抛错时用例失败
- 用例结束时检查运行时错误和未实现的 wx API，`wxaCheckErrors: false` 可以关掉
- 每个 worker 一个开发服务器，每个用例一个新的浏览器上下文，并行运行互不影响
- Chrome 默认带上 `--js-flags=--no-enable-lazy-source-positions`，Playwright 连着浏览器时基础库初始化不用重新解析源码，打开页面快约 1/3

配置项、mock 的限制等见 [在 Playwright 中测试](https://open-wxa.github.io/wxa-runner/testing)。

## 不用 fixture

只用 Playwright 自带的 `webServer` 也能测试（先装上命令行：`pnpm add -D wxa-runner`），在用例里通过 `window.__wxa_test_api__` 操作：

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

写法见 [测试 API](https://open-wxa.github.io/wxa-runner/test-api)。
