# wxa-runner

在普通浏览器里，用**微信官方基础库**运行小程序。为本地调试和 E2E 自动化测试而生。

```bash
npx wxa-runner dev ./dist/dev/mp-weixin   # 原生小程序目录，或 uni-app / Taro 编译产物
# → http://localhost:3000
```

- 需要 Node.js ≥ 18。经常用或要在 CI 里跑，装成开发依赖：`pnpm add -D wxa-runner`
- 基础库和编译器不用另外准备：本机有微信开发者工具就用它的，没有就用随依赖安装的内置版本
- 默认使用基础库 3.7.0 及以下的版本，3.7.1 起的新版本用 `--baselib` 指定

| 命令 | 作用 |
| --- | --- |
| `wxa-runner dev <项目目录>` | 启动开发服务器，改动后热更新 |
| `wxa-runner baselib list` | 列出可用的基础库及兼容性 |
| `wxa-runner baselib extract [版本]` | 解包基础库（`dev` 会自动执行） |

命令选项和环境变量、跳过登录、热更新、在 Playwright 中测试等用法见[文档](https://open-wxa.github.io/wxa-runner/)。

## 许可证

MIT。内置基础库 [wxa-baselib](https://github.com/open-wxa/wxa-baselib) 是微信官方代码，版权归腾讯所有，不适用本项目的 MIT 协议。
