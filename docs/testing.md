---
titleTemplate: ':title | wxa-runner'
description: 用 Playwright 给微信小程序写 E2E 测试：安装 @open-wxa/wxa-runner-playwright，打开页面、点击、断言页面 data，mock 原生 API、拦截和断言 wx.request。
---

# 用 Playwright 写微信小程序 E2E 测试

用 [Playwright](https://playwright.dev/) 写小程序的 E2E 测试：在浏览器里打开小程序的页面，点击按钮，检查页面上的文字、页面的 `data`、小程序发出的请求。
CI 里无头运行，Linux 上不需要开发者工具。

## fixture 是什么

fixture 是 Playwright 的概念：测试框架在每个用例开始前准备好、作为参数传进来的对象。Playwright 自带的 `page`（浏览器页面）就是一个 fixture。

`@open-wxa/wxa-runner-playwright` 提供了一个叫 `miniProgram` 的 fixture。用了它，就不用自己启动 wxa-runner、打开浏览器、等小程序启动，
用例里直接写要测的东西：

```ts
test('点击「详情」进入详情页', async ({ miniProgram }) => {
  await miniProgram.open('pages/index/index');
  await miniProgram.current.locator('#detail').click();
  await expect(miniProgram).toHavePath('pages/detail/detail');
});
```

不想多装一个包，或者用的不是 Playwright，可以直接调用浏览器里的[测试 API](./test-api.md)。

## 快速上手

**1. 安装**

```bash
pnpm add -D @playwright/test @open-wxa/wxa-runner-playwright
```

用例在本机安装的 Google Chrome 里运行。没装 Chrome 时，运行 `npx playwright install chrome`。

**2. 新建 `playwright.config.ts`**

- 原生小程序：放在 `project.config.json` 所在目录
- uni-app、Taro 等框架：放在源码根目录，用 `wxaProject` 指向编译产物目录。跑测试前先构建出这个目录

```ts
// playwright.config.ts
import { defineConfig } from '@playwright/test';
import type { WxaOptions } from '@open-wxa/wxa-runner-playwright';

export default defineConfig<WxaOptions>({
  testDir: 'e2e',
  use: {
    channel: 'chrome',
    // uni-app、Taro：编译产物目录，相对这个配置文件
    // wxaProject: './dist/dev/mp-weixin',
    // setup 文件，相对这个配置文件
    // wxaServerOptions: { setup: './wxa.setup.ts' },
  }
});
```

**3. 写第一个用例**

```ts
// e2e/index.spec.ts
import { test, expect } from '@open-wxa/wxa-runner-playwright';

test('首页能打开', async ({ miniProgram }) => {
  await miniProgram.open();
  // 换成你的首页路径
  await expect(miniProgram).toHavePath('pages/index/index');
});
```

`test` 和 `expect` 要从 `@open-wxa/wxa-runner-playwright` 导入，不是 `@playwright/test`：这样用例里才有 `miniProgram`，
`expect` 才有 `toHavePath` 等断言。

**4. 运行**

```bash
npx playwright test            # 无头运行全部用例
npx playwright test --headed   # 打开浏览器窗口，看着它运行
npx playwright test --ui       # 图形界面，可以一步步回看
```

## 写用例

下面是一个完整的例子：下单前 mock 登录、拦截下单接口，点击提交后检查跳转、页面 data 和发出的请求。各部分的说明见后面几节。

```ts
import { test, expect } from '@open-wxa/wxa-runner-playwright';

test('提交订单后跳转到结果页', async ({ miniProgram }) => {
  // 打开页面前声明，App.onLaunch 里就生效
  await miniProgram.mock('login', { code: 'test_code' });
  await miniProgram.route('POST **/api/orders', {
    status: 201,
    body: { id: 'o-1' }
  });
  await miniProgram.open('pages/cart/cart');

  // current 是当前页，跳转后自动指向新页面
  await miniProgram.current.locator('#submit').click();

  // 跳转需要时间，这两个断言会自动重试，不用手动等待
  await expect(miniProgram).toHavePath('pages/result/result');
  await expect(miniProgram).toHavePageData({ orderId: 'o-1' });

  const req = await miniProgram.waitForRequest(
    'POST **/api/orders'
  );
  expect(req.body).toEqual({ skuId: 1, count: 2 });
});
```

### 打开页面

| 写法 | 作用 |
| --- | --- |
| `await miniProgram.open()` | 打开首页 |
| `await miniProgram.open('pages/detail/detail?id=1')` | 打开指定页面，`?` 后面是页面参数 |

- 页面不在 `app.json` 里时直接报错，不会停在首页上继续执行
- 同一个用例里再次 `open()` 会整页重新加载，之前的 `mock`、`route` 仍然生效

### 操作页面

`miniProgram.current` 是当前页（页面栈顶），用法和 Playwright 的 `page.frameLocator()` 一样。跳转后它自动指向新页面，不用重新获取：

```ts
const page = miniProgram.current;
await page.locator('#add').click();
await page.getByText('去结算').click();
await expect(page.locator('#count')).toHaveText('1');
```

### 断言

除了 Playwright 自带的断言，还可以直接断言小程序的状态，不满足时自动重试，直到超时：

| 写法 | 检查 |
| --- | --- |
| `expect(miniProgram).toHavePath('pages/result/result')` | 当前页是这个页面 |
| `expect(miniProgram).toHavePageData({ status: 'ok' })` | 当前页的 `data` 包含这些字段和值，没列出的字段不比较 |
| `expect(miniProgram).toHavePageData(data, { path })` | 页面栈里指定页面的 `data` |

别忘了 `await`。两者都可以加 `.not`，也可以传 `{ timeout }` 改超时时间（毫秒）。

### mock 原生 API、拦截请求

在 `open()` 之前调用，`App.onLaunch` 里就生效；打开之后调用，从下一次调用开始生效：

```ts
await miniProgram.mock('getLocation', {
  latitude: 31.23,
  longitude: 121.47
});
await miniProgram.route('GET **/api/feed', {
  body: { list: [] }
});
await miniProgram.open();
```

- 写法和 setup 的 [`mock`](./setup.md#mock)、[`network.routes`](./setup.md#network) 一样，会覆盖 setup 里的同名配置
- `unmock(api?)`、`unroute(pattern?)` 撤销，不传参数时撤销全部，包括 setup 里声明的

也可以传函数，按调用参数或请求内容返回结果。函数在 Node 里执行，能用用例里的变量，也能在里面写断言：

```ts
await miniProgram.route('POST **/api/orders', request => {
  expect(request.body).toEqual({ skuId: 1, count: 2 });
  return { status: 201, body: { id: 'o-1' } };
});
```

- 函数抛错时这次调用失败，用例结束时也会失败，写在函数里的断言失败了不会被忽略
- 函数的结果是异步返回的。基础库同步调用的 API 只能传对象：以 `Sync` 结尾的，以及 `getSystemInfo`、`getMenuButtonBoundingClientRect`
  （`wx.getWindowInfo` 等都经过 `getSystemInfo`）
- 参数和返回值要能序列化。`route` 的函数拿到的 `request.body` 已经按 Content-Type 解析好（JSON、表单）

### 检查发出的请求

```ts
await miniProgram.clearRequests();
await miniProgram.current.locator('#save').click();

const req = await miniProgram.waitForRequest(
  'POST **/api/profile'
);
expect(req.body).toEqual({ name: '张三' });
```

- `waitForRequest(pattern)`：等到小程序发出匹配的请求，返回最近的一个。之前已经发出的也算，只关心某个操作之后的请求时，操作前先 `clearRequests()`
- `requests(pattern?)`：已经发出的全部请求，按发出顺序。被拦截的和真正发出的都有，只保留最近 1000 个
- 规则的写法同 `route`

每个请求有：

| 字段 | 说明 |
| --- | --- |
| `method` | 大写，如 `POST` |
| `url` | 完整地址 |
| `header` | 请求头 |
| `body` | 按 Content-Type 解析好的请求体：JSON 是对象，表单是 `{ 字段: 值 }` |
| `data` | 没解析的原始请求体 |
| `routedBy` | 拦截它的规则；没被拦截、真正发出去的为 `null` |

### 读取状态、直接跳转

| 写法 | 作用 |
| --- | --- |
| `pageData(path?)` | 页面的 `data`。不传时读当前页 |
| `currentPage()` / `pageStack()` | 当前页 / 整个页面栈，每页有 `path`、`query` |
| `waitForPage(path)` | 等到这个页面成为当前页 |
| `callPageMethod(name, ...args)` | 调用当前页的方法，返回方法的返回值 |
| `navigateTo(url)`、`navigateBack()`、`redirectTo(url)`、`reLaunch(url)`、`switchTab(url)` | 直接跳转，同 `wx` 上的同名 API |
| `getStorage(key)` / `clearStorage()` | 读取 / 清空小程序的存储 |

都是 async 的，要 `await`。每个成员在编辑器里悬停都能看到详细说明。

### 选择图片

`wx.chooseImage`、`wx.chooseMedia` 会打开浏览器的文件选择框。用 Playwright 的 `filechooser` 事件直接给文件，不会弹出系统窗口。
和真机一样，相册和拍摄都可选时（默认）会先弹出「拍摄 / 从手机相册选择」菜单，要先点菜单项：

```ts
test('上传头像', async ({ miniProgram, page }) => {
  await miniProgram.open('pages/profile/profile');
  await miniProgram.current.locator('#avatar').click();

  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('button', { name: '从手机相册选择' }).click()
  ]);
  await chooser.setFiles('fixtures/avatar.png');
});
```

- 菜单、图片预览这些弹层在 `page` 上，不在 `miniProgram.current` 里。预览层用 `page.getByRole('dialog', { name: '图片预览' })` 找到
- `chooser.setFiles([])` 等于用户关掉选择框，页面收到 `cancel`

### 检查运行时错误

每个用例结束时，fixture 会检查小程序有没有出错，有就让用例失败：

- 逻辑层、渲染层的运行时错误
- 调用了 wxa-runner 还没有实现的 `wx` API。这些 API 会返回成功，以免打断业务代码，但测试里要 mock 掉

用 `miniProgram.errors()` 可以看到具体内容。有意触发错误的用例，用 `test.use({ wxaCheckErrors: false })` 关掉检查。

## 配置项

在 `playwright.config.ts` 的 `use` 里设置：

| 选项 | 默认值 | 作用 |
| --- | --- | --- |
| `wxaProject` | `'.'` | 小程序目录，相对配置文件 |
| `wxaServerOptions` | `{}` | 开发服务器的其他参数，如 `setup`、`baseLibVersion`、`devtoolsLogin`。路径相对配置文件 |
| `wxaCheckErrors` | `true` | 用例结束时[检查运行时错误](#检查运行时错误) |

- 每个 worker（Playwright 并行运行用例的进程）启动一个开发服务器，小程序只编译一次；每个用例用一个新的浏览器上下文，Storage、用户文件、临时文件和页面栈互不影响
- 文件在开发服务器内存中按浏览器会话隔离。会话标识保存在 localStorage；同一上下文的页面和刷新复用文件，新的上下文得到独立目录。关闭浏览器上下文不会立即清理服务器文件，开发服务器关闭时全部释放；重启服务器后文件不保留
- 文件接口保持同步和异步语义：只有 `Sync` 接口使用同步 XHR，其他文件接口用异步请求
- 测试时不监听文件变化、不热更新，运行环境和真机一致
- `wxaProject`、`wxaServerOptions` 只能写在配置文件里，或用例文件顶层的 `test.use` 里，不能写在 `describe` 里

## 注意事项

- **跳转后的选择器**：新旧页面有同一个选择器时，先 `await expect(miniProgram).toHavePath(...)` 等跳转完成，免得断言落在上一个页面上
- **text 组件的文字**：基础库 3.3.x 及更早的版本里，`textContent`（Playwright 的 `toHaveText` 默认用它）会把 text 组件的文字读到两遍。
  用 `toHaveText(text, { useInnerText: true })` 或 `innerText()`
