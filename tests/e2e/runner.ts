/**
 * e2e 公共部分：用临时小程序或 examples 下的示例启动 DevServer，在 Chrome 里打开
 *
 * 需要本机安装微信开发者工具，以及 Chrome（或通过 WXA_CHROME 指定浏览器路径）。
 */

import fs from 'fs';
import path from 'path';
import { chromium, Frame, LaunchOptions, Page } from 'playwright';
import { expect } from 'vitest';
import { listBaseLibs } from '../../packages/extractor/src/baselib';
import { DevServer, DevServerOptions } from '../../packages/core/src/server/DevServer';
import { createProject, hasToolchain, REPO_ROOT } from '../helpers';

const RUNTIME_DIR = path.join(REPO_ROOT, 'packages/core/dist/runtime');
/** Chrome 的默认安装位置：macOS，Windows 的全局安装和用户级安装 */
const DEFAULT_CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ...[process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]
    .filter(dir => dir)
    .map(dir => path.join(dir!, 'Google/Chrome/Application/chrome.exe'))
];
export const CHROME = process.env.WXA_CHROME || DEFAULT_CHROMES.find(file => fs.existsSync(file)) || DEFAULT_CHROMES[0];

export const e2eReady = hasToolchain() && fs.existsSync(path.join(RUNTIME_DIR, 'host.js')) && fs.existsSync(CHROME);

// README 列出的已验证版本。基础库内部调用哪些原生接口因版本而异，本机有哪个就测哪个（CI 上只有内置的 3.7.0）
export const VERIFIED_BASELIBS = ['2.32.3', '3.3.4', '3.5.8', '3.7.0'];
export const installedBaseLibs = e2eReady ? new Set(listBaseLibs().map(lib => lib.version)) : new Set<string>();

/**
 * e2e 用 chromium.launch 启动 Chrome 时都要带上这些选项
 *
 * macOS 上关掉了 App Nap：没有窗口的 Chrome 偶尔会在申请 App Nap 断言时一直等系统服务 RunningBoard，主线程卡住后
 * launch、newContext、newPage 都不再返回，多个 Chrome 同时运行时更容易遇到（#37）。
 * launchPersistentContext 不能用：它在命令行末尾加了 about:blank，再加上关 App Nap 的参数，headless 模式会拒绝启动
 */
export const chromeLaunchOptions: LaunchOptions =
  process.platform === 'darwin'
    ? { executablePath: path.join(__dirname, 'chrome-no-app-nap.sh'), env: { ...process.env, WXA_CHROME_BINARY: CHROME } }
    : { executablePath: CHROME };

export interface RunnerOptions {
  chromeArgs?: string[];
  /** 授予页面的浏览器权限，如 camera */
  permissions?: string[];
  /** 不指定时用最新的兼容版本 */
  baseLibVersion?: string;
  /** 基础库解包目录，默认 ~/.wxa-runner/baselib；模拟的基础库要放到临时目录，免得污染真实缓存 */
  baseLibCacheDir?: string;
  /** 开启 --devtools-login；不想依赖本机登录态时用 page.route 拦截 /__wxa__/api/* */
  devtoolsLogin?: boolean;
  forwardConsole?: DevServerOptions['forwardConsole'];
  /** 开发服务器的终端输出，默认丢弃 */
  logger?: DevServerOptions['logger'];
}

export interface Runner {
  base: string;
  page: Page;
  /** 打开宿主地址（如 /?path=pages/a/a），等小程序启动后返回当前页的渲染层 */
  open(url: string): Promise<Frame>;
  close(): Promise<void>;
}

/** project 传文件内容时在临时目录生成项目；传路径时直接运行已有的项目（如 examples 下的示例） */
export async function startRunner(project: Record<string, string | object> | string, options: RunnerOptions = {}): Promise<Runner> {
  const server = new DevServer({
    projectPath: typeof project === 'string' ? project : createProject({
      'project.config.json': { appid: 'wxtest0000000000', compileType: 'miniprogram' },
      'app.js': 'App({});',
      ...project
    }),
    port: 0,
    watch: false,
    baseLibVersion: options.baseLibVersion,
    baseLibCacheDir: options.baseLibCacheDir,
    devtoolsLogin: options.devtoolsLogin,
    forwardConsole: options.forwardConsole,
    runtimeDir: RUNTIME_DIR,
    logger: options.logger ?? { log: () => undefined, warn: () => undefined, error: () => undefined }
  });
  const base = await server.start();
  const browser = await chromium.launch({ ...chromeLaunchOptions, args: options.chromeArgs });
  const context = await browser.newContext({ permissions: options.permissions });
  const page = await context.newPage();

  return {
    base,
    page,
    async open(url) {
      await page.goto(base + url);
      await page.waitForFunction(() => window.__wxa_test_api__);
      await page.evaluate(() => window.__wxa_test_api__.ready);
      const { frameName } = (await page.evaluate(() => window.__wxa_test_api__.currentPage()))!;
      return page.frame({ name: frameName })!;
    },
    async close() {
      await browser.close();
      await server.close();
    }
  };
}

/** 等元素文本变成期望值；超时后用实际文本断言，失败信息里能看到页面停在了哪一步 */
export async function expectText(frame: Frame, selector: string, expected: string | RegExp, timeout = 5000) {
  const pattern = typeof expected === 'string' ? { source: expected, exact: true } : { source: expected.source, exact: false };
  await frame.waitForFunction(
    ([s, p]) => {
      const text = document.querySelector(s)?.textContent ?? '';
      return p.exact ? text === p.source : new RegExp(p.source).test(text);
    },
    [selector, pattern] as const,
    { timeout }
  ).catch(() => undefined);
  const actual = await frame.textContent(selector);
  if (typeof expected === 'string') expect(actual).toBe(expected);
  else expect(actual).toMatch(expected);
}
