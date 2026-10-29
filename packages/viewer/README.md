# @open-wxa/wxa-viewer

不带源码、不开开发服务器，在浏览器里运行小程序：用 `wxa-runner viewer pack` 把小程序打成 `.wxapack` 包，拖进查看器页面就能运行。
查看器是静态网页，可以在本机打开，也可以导出后部署，发链接给别人看（[在线预览](https://wxa-viewer.picfinder.workers.dev)）。

打包、配置、部署和限制见文档[查看器：不带源码在浏览器里运行](../../docs/viewer.md)。

命令挂在 `wxa-runner viewer` 下面，实现在这个包里，执行时才加载：`wxa-runner` 不依赖它，只用 `dev` 的人不会多装 esbuild-wasm 等依赖；没装这个包时，命令会提示怎么装。

> 这个包目前是 `private`，没有发布到 npm，查看器命令只能在仓库里用：先 `pnpm install && pnpm build`，再用 `node packages/cli/bin/wxa-runner.js` 代替 `npx wxa-runner`。

## 和 wxa-runner 的关系

查看器只通过 `@open-wxa/wxa-runner-core` 的公开导出使用 wxa-runner：Node 端用根入口（`AppBuilder`、`bundleSetup`、`handleProxy` 等），
浏览器、Service Worker、转发处理函数里用不依赖 Node 的 `@open-wxa/wxa-runner-core/web`（`routeApp`、`FileStore`、`proxyFetch` 等）。
`tests/unit/viewer/boundary.test.ts` 检查这条边界：查看器不能用相对路径引用 core 的源码，core 也不引用查看器。
