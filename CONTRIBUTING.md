# 参与开发

使用方式见 [README](./README.md)（[English](./README.en.md)）。这里是在本仓库里开发 wxa-runner 需要知道的内容。

## 目录结构

```
packages/
  extractor/   @open-wxa/wxa-runner-extractor  定位开发者工具、选择并解包基础库（.wxvpkg），没有时用内置基础库
  compiler/    @open-wxa/wxa-runner-compiler   调用官方 wcc / wcsc 编译 WXML / WXSS（开发者工具或 miniprogram-compiler 自带）
  core/        @open-wxa/wxa-runner-core       项目构建、开发服务器、浏览器端运行时
  cli/         wxa-runner                      命令行（包名不带 scope，npx wxa-runner 直接可用）
  playwright/  @open-wxa/wxa-runner-playwright Playwright fixture
  viewer/      @open-wxa/wxa-viewer            把小程序打成 .wxapack 在浏览器里运行，命令是 wxa-runner viewer（private，不发布；只用 core 的公开导出）
examples/      showcase（覆盖主要功能，「能力」页逐项对照原生组件和 API）、hello-world（发布前试跑用）、custom-tabbar（自定义 tabBar）、subpackages（分包预下载和分包异步化）、worker（Worker）
tests/         unit / integration / e2e，playwright（用 fixture 写的用例）
docs/          使用文档，同时是 VitePress 文档站点的源文件
```

## 构建与测试

```bash
pnpm install
pnpm build
pnpm test            # 单元 + 集成 + e2e
pnpm test:playwright # tests/playwright，用 Playwright 的 test runner 跑，需要先 pnpm build
pnpm test:coverage
WXA_BASELIB=3.8.8 pnpm test  # 在指定的基础库版本上跑全部测试（不指定时用默认选中的版本）
pnpm lint            # oxlint，有警告也算失败，CI 会跑
pnpm format <文件>   # oxfmt 格式化指定的 ts/js 文件

node packages/cli/bin/wxa-runner.js dev examples/showcase --open   # 用源码运行示例
```

- 找不到编译器、基础库或 Chrome 时，依赖它们的用例会自动跳过；`pnpm test:playwright` 不跳过，找不到时直接报错
- e2e 默认使用 Chrome 的默认安装位置（macOS 的 `/Applications/Google Chrome.app`，Windows 的 `Program Files`、`%LOCALAPPDATA%` 下的 `chrome.exe`），其他位置通过环境变量 `WXA_CHROME` 指定，如 Linux 上
  `WXA_CHROME=/usr/bin/google-chrome pnpm test`
- 本机没有开发者工具时，`pnpm install` 装上的内置基础库和 miniprogram-compiler 就够跑全部测试
- 现有代码是手工排版的，CI 不检查格式，也不要整仓库跑 `pnpm format`：只格式化自己新写或大改的文件，
  配置在 `.oxfmtrc.json`

## CI

[.github/workflows/ci.yml](./.github/workflows/ci.yml) 跑 `pnpm lint`，并在 ubuntu-latest 上跑全部测试（`pnpm test` 和 `pnpm test:playwright`），
测试前先确认编译器、基础库和 Chrome 都找得到：缺少时依赖它们的用例会自动跳过，CI 却显示通过。
最后用 `node scripts/release.mjs --dry-run` 打包全部 npm 包，像外部用户一样在新目录里用 npm 安装，确认
`wxa-runner dev` 能启动示例项目、用上内置基础库和 miniprogram-compiler。

## 文档站点

`docs/` 下的 Markdown 在 GitHub 上直接阅读，同时用 [VitePress](https://vitepress.dev/zh/) 构建成文档站点：

```bash
pnpm docs:dev      # 本地预览，改动实时生效
pnpm docs:build    # 构建到 docs/.vitepress/dist，有死链时失败
pnpm docs:preview  # 预览构建结果
```

- 导航、侧边栏、站点地址在 `docs/.vitepress/config.mts`。新增页面要加进 `sidebar`，并在开头的 frontmatter 里写
  `description`（搜索结果里显示的摘要，也是 `llms.txt` 里这一页的说明）
- 页面之间用相对路径链接（`./setup.md#network`），GitHub 上和站点里都能打开。指向 `docs/` 之外的文件要写 GitHub 上的完整地址
  （`https://github.com/open-wxa/wxa-runner/blob/main/…`）：站点里没有这些文件，给 AI 读的 `.md` 版本也是照原文生成的
- [.github/workflows/docs.yml](./.github/workflows/docs.yml) 在 `docs/` 有改动并推送到 main 时部署到 GitHub Pages；PR 里只构建

## 提交与分支

提交信息按 [Conventional Commits](https://www.conventionalcommits.org/zh-hans/) 写，如 `fix: 没装开发者工具时偶发 wcc 编译崩溃`；
分支名用「类型/短横线描述」，如 `fix/wcc-split`。两者的类型相同：

| 类型 | 用于 |
| --- | --- |
| `feat` | 新功能 |
| `fix` | 修复问题 |
| `perf` | 性能优化 |
| `refactor` | 不改变行为的重构 |
| `docs` / `test` | 文档 / 测试 |
| `ci` / `build` / `chore` / `style` | CI、构建、杂项、代码格式 |
| `revert` | 回退 |

- `pnpm install` 时会装上 git hooks（[husky](https://typicode.github.io/husky/)）：提交时用 [commitlint](https://commitlint.js.org/)
  检查提交信息，推送时检查分支名，不符合就拒绝。规则在 `commitlint.config.mjs` 和 `scripts/check-branch-name.mjs`
- 描述用中文即可，可以以 README、Playwright 等英文专有名词开头；标题和正文每行不超过 100 个字符
- hook 能用 `--no-verify` 跳过，但 PR 上的 CI 会再检查一遍提交信息和分支名
- 类型决定发不发版、版本号升哪一位，见下文「发布」

## 发布

5 个包版本号保持一致。版本号和 [CHANGELOG.md](./CHANGELOG.md) 由 [release-please](https://github.com/googleapis/release-please)
根据提交记录生成，[.github/workflows/release.yml](./.github/workflows/release.yml) 负责发布到 npm：

1. 提交信息按上面「提交与分支」的规范写：`feat:` 升次版本号，
   `fix:`、`perf:` 升修订号；0.x 阶段破坏性改动（`feat!:`，或正文里写 `BREAKING CHANGE:`）也只升次版本号。
   `test:`、`docs:`、`chore:`、`ci:`、`refactor:` 不进 CHANGELOG，只有这些提交时不发版
2. 推送到 main 后，release.yml 开一个（或更新已有的）发布 PR「chore: release x.y.z」，6 个 package.json 的版本号和 CHANGELOG
   都已改好。合并前可以直接在这个 PR 里修改 CHANGELOG 的措辞，想攒几个改动一起发就先不合并
3. 合并发布 PR 后，release.yml 打 tag `vx.y.z`、建 GitHub Release，跑一遍 CI，再执行 `node scripts/release.mjs` 发布到 npm

- release.mjs：打包、在新目录里安装试跑、按依赖顺序发布。版本号与 tag 不一致时直接失败；npm 上已有的版本会跳过，
  中途失败后在 Actions 里重跑失败的 job 即可
- 要指定版本号（如正式进入 `1.0.0`），在提交正文里加一行 `Release-As: 1.0.0`。版本号带 `-`（如 `0.3.0-beta.1`）时
  发布到 `next` 标签，`npm i wxa-runner` 装到的版本不变
- 发布 PR 由 GitHub Actions 自带的 token 创建，GitHub 不会为它触发 CI，PR 上看不到检查结果；发布前 release.yml 会先跑一遍完整的 CI。
  仓库设置里要勾选 Settings → Actions → General →「Allow GitHub Actions to create and approve pull requests」，否则开不了发布 PR
- 认证用 npm 的 Trusted Publishing，不需要 token：每个包在 npmjs.com 的设置里登记了本仓库的 `release.yml`，改文件名要同步改登记
- 新增包时，把目录加到 `scripts/release.mjs` 的 `PACKAGE_DIRS`（被依赖的排在前面）和 `release-please-config.json` 的
  `extra-files`，package.json 照着已有的包写上 `repository`、`publishConfig` 等字段。Trusted Publishing 只能给 npm 上已有的包配置，
  所以新包的第一个版本要在本机 `npm login` 后执行 `node scripts/release.mjs` 手动发布，再到 npmjs.com 为它登记 `release.yml`。
  登记后 2 天内要由 release.yml 成功发布一次，否则登记失效

## 工作原理

```
浏览器
├── 宿主页面            页面栈、路由、wx.* 原生 API、导航栏 / tabBar / 弹窗
├── 逻辑层 iframe       官方 WAService.js + 小程序的 App / Page / Component 代码
└── 渲染层 iframe × N   官方 WAWebview.js + wcc / wcsc 编译出的模板和样式（每个页面一个）
```

逻辑层与渲染层之间的通信、`onAppRoute` 等原生事件，由 wxa-runner 按基础库期望的 `WeixinJSBridge` 接口实现。
详细设计见 [PROJECT_DESIGN.md](./PROJECT_DESIGN.md)。
