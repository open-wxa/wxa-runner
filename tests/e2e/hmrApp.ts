/**
 * 热更新 e2e 共用的示例小程序和页面操作。用例按主题分在 hmrView、hmrLogic、hmrReload 三个文件里，
 * 好让 CI 分片时落到不同机器上并行跑（合在一个文件里时它是最慢的一个文件，卡住整个 CI）
 *
 * 「没有整页刷新」用宿主 window 上的标记判断：整页刷新后标记就没了。
 */

import fs from 'fs';
import path from 'path';
import { Browser, chromium, Frame, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';
import { DevServer } from '../../packages/core/src/server/DevServer';
import { createProject, REPO_ROOT } from '../helpers';
import { chromeLaunchOptions } from './runner';

export const RUNTIME_DIR = path.join(REPO_ROOT, 'packages/core/dist/runtime');

const INDEX_JS = `
Page({
  data: { count: 0, loads: 0 },
  onLoad() {
    const app = getApp();
    app.globalData.loads += 1;
    this.setData({ loads: app.globalData.loads });
  },
  add() {
    this.setData({ count: this.data.count + 1 });
  }
});
`;

const INDEX_WXML = `
<view id="count">{{count}}</view>
<view id="loads">{{loads}}</view>
<view id="label">{{label}}</view>
<button id="add" bindtap="add">add</button>
<badge id="badge" />
`;

const BADGE_JS = `
Component({
  data: { n: 0 },
  methods: {
    inc() { this.setData({ n: this.data.n + 1 }); }
  }
});
`;

// uni-app 等框架的页面：用 Component 构造，状态不在 Page 实例上
const VUE_PAGE_JS = `
Component({
  data: { tag: 'old', n: 0 },
  methods: {
    inc() { this.setData({ n: this.data.n + 1 }); }
  }
});
`;

function miniProgram() {
  return createProject({
    'project.config.json': { appid: 'wxtest0000000000', compileType: 'miniprogram' },
    'app.json': {
      pages: ['pages/index/index', 'pages/detail/detail', 'pages/vue/vue'],
      usingComponents: { badge: '/components/badge/badge' }
    },
    'app.js': 'App({ globalData: { loads: 0 } });',
    'app.wxss': '',
    'pages/index/index.json': {},
    'pages/index/index.js': INDEX_JS,
    'pages/index/index.wxml': INDEX_WXML,
    'pages/index/index.wxss': '#loads { color: rgb(20, 20, 20); }',
    'pages/detail/detail.json': {},
    'pages/detail/detail.js': "Page({ data: { tag: 'old' } });",
    'pages/detail/detail.wxml': '<view id="tag">{{tag}}</view>',
    'pages/detail/detail.wxss': '@import "../../styles/common.wxss";',
    'styles/common.wxss': '',
    'pages/vue/vue.json': {},
    'pages/vue/vue.js': VUE_PAGE_JS,
    'pages/vue/vue.wxml': '<view id="tag">{{tag}}</view><view id="n">{{n}}</view><button id="inc" bindtap="inc">inc</button>',
    'pages/vue/vue.wxss': '',
    'components/badge/badge.json': { component: true },
    'components/badge/badge.js': BADGE_JS,
    'components/badge/badge.wxml': '<view class="badge-n">n={{n}}</view><button class="badge-inc" bindtap="inc">inc</button>',
    'components/badge/badge.wxss': '',
    'wxa.setup.js': 'export default {};'
  });
}

/**
 * 在 describe 里调用：每个用例前新建示例小程序、启动开发服务器并打开页面，用例后关闭。
 * 返回对象上的 page、server 等属性每个用例都会换新，要在用例里现取
 */
export function useHmrApp() {
  let server: DevServer | undefined;
  let browser: Browser;
  let page: Page;
  let projectPath = '';
  let serverLogs: string[] = [];

  const edit = (file: string, update: (content: string) => string) => {
    const target = path.join(projectPath, file);
    fs.writeFileSync(target, update(fs.readFileSync(target, 'utf8')));
  };
  const current = async (): Promise<Frame> => {
    const { frameName } = (await page.evaluate(() => window.__wxa_test_api__.currentPage()))!;
    return page.frame({ name: frameName })!;
  };
  const textOf = async (selector: string) => (await (await current()).textContent(selector))?.trim();
  const waitForText = async (selector: string, text: string) => {
    const frame = await current();
    await frame.waitForFunction(
      ([s, t]) => document.querySelector(s)?.textContent?.trim() === t,
      [selector, text] as const,
      { timeout: 10000 }
    );
  };
  /** 整页刷新会清掉这个标记 */
  const markHost = () => page.evaluate(() => ((window as any).__hmrMarker = true));
  const hostReloaded = async () => !(await page.evaluate(() => (window as any).__hmrMarker));
  const tap = async (selector: string) => (await current()).click(selector);
  /** 页面栈里第 index 页的渲染层，不一定在前台 */
  const frameAt = async (index: number): Promise<Frame> => {
    const { frameName } = (await page.evaluate(() => window.__wxa_test_api__.pageStack()))[index];
    return page.frame({ name: frameName })!;
  };
  const waitForColor = (frame: Frame, selector: string, color: string) => frame.waitForFunction(
    ([s, c]) => {
      const element = document.querySelector(s);
      return !!element && getComputedStyle(element).color === c;
    },
    [selector, color] as const,
    { timeout: 10000 }
  );
  const colorOf = async (selector: string) => (await current()).evaluate(s => getComputedStyle(document.querySelector(s)!).color, selector);
  const waitForPage = async (pagePath: string): Promise<void> => {
    await page.evaluate(p => window.__wxa_test_api__.waitForPage(p), pagePath);
  };
  const stack = (): Promise<{ path: string; query: Record<string, string> }[]> => page.evaluate(() => window.__wxa_test_api__.pageStack().map(({ path, query }) => ({ path, query })));
  const waitForReload = async () => {
    await page.waitForFunction(() => !(window as any).__hmrMarker, undefined, { timeout: 10000 });
    await page.waitForFunction(() => window.__wxa_test_api__);
    await page.evaluate(() => window.__wxa_test_api__.ready);
  };
  /** 开发者在控制台看到的热更新完成提示；要在修改文件之前开始等 */
  const hotUpdated = () => page.waitForEvent('console', { predicate: msg => msg.text().includes('[wxa-runner] 热更新完成'), timeout: 10000 });

  beforeAll(async () => {
    browser = await chromium.launch(chromeLaunchOptions);
  });

  beforeEach(async () => {
    projectPath = miniProgram();
    server = new DevServer({
      projectPath,
      port: 0,
      runtimeDir: RUNTIME_DIR,
      logger: { log: message => serverLogs.push(String(message)), warn: () => undefined, error: () => undefined }
    });
    serverLogs = [];
    page = await browser.newPage();
    await page.goto(await server.start());
    await page.waitForFunction(() => window.__wxa_test_api__);
    await page.evaluate(() => window.__wxa_test_api__.ready);
    await markHost();
  });

  afterEach(async () => {
    await page?.close();
    await server?.close();
    server = undefined;
  });

  afterAll(async () => {
    await browser?.close();
  });

  return {
    get page() { return page; },
    /** 用例里换成自己启动的开发服务器时赋值，用例结束时由这里关闭 */
    get server() { return server; },
    set server(value) { server = value; },
    get projectPath() { return projectPath; },
    get serverLogs() { return serverLogs; },
    edit, current, textOf, waitForText, markHost, hostReloaded, tap, frameAt, waitForColor, colorOf, waitForPage, stack, waitForReload,
    hotUpdated
  };
}
