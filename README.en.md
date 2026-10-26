# wxa-runner

> Run WeChat Mini Programs in a regular browser on the **official base library**. Built for local debugging and end-to-end testing.

English · [中文](./README.md)

```bash
npx wxa-runner dev ./dist/dev/mp-weixin   # a native mini program, or uni-app / Taro build output
# → http://localhost:3000
```

Base library 3.7.0 and below is used by default; newer versions (3.7.1 onwards) must be chosen explicitly. See [Known limitations](#known-limitations) for the rest.

## Why wxa-runner

- **Matches the real thing**: runs the mini program build output directly; rendering, components, `setData` and lifecycles are WeChat's official base library code, not a framework's H5 reimplementation
- **Headless E2E**: test in the browser with Playwright instead of remote-controlling DevTools; runs headless in CI, and needs no DevTools on Linux
- **Familiar debugging tools**: breakpoints, network requests and the DOM in Chrome DevTools
- **Skip what a browser cannot do**: seed the login state, mock native APIs and intercept requests in setup, without touching app code
- **Open any page directly**: add `?path=pages/detail/detail&id=1` to the URL to land on a page during development and in tests

It does not replace DevTools: previewing, uploading and on-device debugging still need it.

## Quick start

Requires Node.js ≥ 18. Run it in the mini program directory (where `project.config.json` is, or the `mp-weixin` directory a uni-app / Taro build produces):

```bash
npx wxa-runner dev . --open
```

```
[wxa-runner] 编译完成：3 个页面，1 个组件，17ms

  wxa-runner 已启动
  地址      http://localhost:3000
  项目      /path/to/my-app
  基础库    3.7.0
```

For regular use or CI, add it as a dev dependency: `pnpm add -D wxa-runner` (or `npm i -D wxa-runner`).

The CLI currently prints in Chinese. No separate setup for the base library or the compiler: wxa-runner uses WeChat DevTools' copies when installed, and bundled ones installed as dependencies otherwise.
See [docs/cli.md](./docs/cli.md) (in Chinese) for command options and environment variables.

## Usage

### Skip login

Put a `wxa.setup.ts` next to `project.config.json`; it runs before the mini program starts:

```ts
import { defineSetup } from '@open-wxa/wxa-runner-core/setup';

export default defineSetup(({ env }) => ({
  storage: { token: env.WXA_TOKEN },                              // seed storage
  mock: { getLocation: { latitude: 31.23, longitude: 121.47 } },  // override native APIs
  network: {                                                      // intercept wx.request
    routes: { 'POST **/api/auth/login': { body: { token: env.WXA_TOKEN } } }
  }
}));
```

For a real login code or phone number, WeChat service market calls or plugin pages, start with `--devtools-login`, which borrows the login of WeChat DevTools on this machine. See [docs/devtools-login.md](./docs/devtools-login.md) (in Chinese).

### Hot reload

| Change | Effect |
| --- | --- |
| A page's or component's own `.wxml` and `.js`, and any `.wxss` | Hot update without a page refresh; the page stack and global state are kept |
| Anything else (`app.js`, `.json`, …) | Full reload that restores the whole page stack |

See [docs/hot-reload.md](./docs/hot-reload.md) (in Chinese).

### Testing with Playwright

Install `@open-wxa/wxa-runner-playwright`; each worker starts its own dev server:

```ts
import { test, expect } from '@open-wxa/wxa-runner-playwright';

test('navigates to the result page after submitting', async ({ miniProgram }) => {
  await miniProgram.mock('login', { code: 'test_code' });  // declared before opening: already applies in App.onLaunch
  await miniProgram.open('pages/form/form');

  await miniProgram.current.locator('#submit').click();     // current always points to the current page

  await expect(miniProgram).toHavePath('pages/result/result');
  await expect(miniProgram).toHavePageData({ status: 'ok' });
  expect((await miniProgram.waitForRequest('POST **/api/form')).body).toEqual({ name: 'Ann' });
});
```

See [docs/testing.md](./docs/testing.md) (in Chinese) for configuration, mocking and request interception, and [docs/test-api.md](./docs/test-api.md) for using the test API without the fixture.

## Features

| Area | Supported |
| --- | --- |
| Rendering | WXML, WXSS, WXS, custom components, App / Page / Component lifecycles |
| Routing | navigateTo, redirectTo and the other page routes, a 10-level page stack, tab bar |
| Subpackages | Regular and independent subpackages, preloading (preloadRule), async subpackages: components (componentPlaceholder) and JS (require.async) from other subpackages. All code is loaded at startup, with nothing to download |
| Workers | wx.createWorker: messages both ways (ArrayBuffers included), terminate, workers as a subpackage. Asynchronous file APIs work inside a worker |
| UI | Navigation bar, tab bar (custom tab bars included), toast / modal / actionSheet; iPhone X by default |
| Components | picker, canvas, camera, video, map (needs network access), web-view |
| Media | chooseImage, chooseMedia (images and videos) and chooseVideo pick files through the browser; previewImage, getImageInfo; saving to the album downloads the image; InnerAudioContext plays audio |
| Network | request, upload and download through a proxy (no CORS limits), WebSocket |
| Storage | Storage, basic FileSystemManager operations |

Verified on real uni-app (Vue 3) projects; verified base library versions: 2.32.3, 3.3.4, 3.5.8, 3.7.0; the full test suite also passes on 3.7.1 and 3.8.8.
CI covers only the bundled 3.7.0; the other versions are checked locally with `WXA_BASELIB=<version> pnpm test`.

## Known limitations

- Base library 3.7.1 and later is never picked automatically: choose it with `--baselib` or `WXA_BASELIB`, and a warning says it is outside the verified range. The bundled base library is 3.7.0 only, so download newer versions in WeChat DevTools first
- Unimplemented native APIs return success; tests can catch them through `errors()` (see [docs/testing.md](./docs/testing.md#检查运行时错误))
- No Bluetooth or other device capabilities
- A few `MapContext` methods of the map component, such as `toScreenLocation`, `fromScreenLocation` and ground overlays, are missing from the base library's web implementation and never call back (see [PROJECT_DESIGN.md](./PROJECT_DESIGN.md#原生组件))
- Plugin pages work with `--devtools-login`; plugin components and `requirePlugin` don't yet ([#56](https://github.com/open-wxa/wxa-runner/issues/56))
- Inside a worker only asynchronous APIs work: synchronous ones such as `readFileSync` throw, and `request`, `downloadFile`, `uploadFile` and `connectSocket` fail, because the base library needs their task IDs synchronously. A worker can only talk to the page asynchronously; waiting synchronously would need the whole page to be cross-origin isolated, which would block cross-origin images and other resources
- Without WeChat DevTools (on Linux or in CI, say): x86-64 only; the compiler is older, with small template-runtime differences (such as a limit of 16,000 nodes per page); the region picker is unavailable

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) (in Chinese) for building from source, running the examples and testing. Issues and PRs are welcome.

## Acknowledgements

- The WeChat team, for the official base library and compilers
- [WEPT](https://github.com/chemzqm/wept), the first project to show that mini programs can run in a browser

## License

[MIT](./LICENSE). The bundled base library, [wxa-baselib](https://github.com/open-wxa/wxa-baselib), is WeChat's official code; its copyright belongs to Tencent, and the MIT license of this project does not apply to it.
