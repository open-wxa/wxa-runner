/**
 * 端到端：用到基础库伴生 SDK 子包的能力时不阻断页面
 *
 * 回归的是这些崩溃：
 * - wx.createRewardedVideoAd 在基础库里是 new ADSDK.RewardedVideoAd()，而 ADSDK 由 WAAppAd.js 提供、
 *   运行时不加载，于是抛 TypeError 打断整个 onLoad
 * - 单上下文的基础库（3.7.0 及以前）里一读 wx.cloud 就抛 Fatal: unexpected loadSdkSubPackage case；
 *   Taro 启动时把全局对象上的属性逐个拷到自己的 window 上，读到 ADSDK 等懒加载的 SDK 全局也会抛错
 */

import path from 'path';
import { Browser, chromium, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevServer } from '../../packages/core/src/server/DevServer';
import { createProject, REPO_ROOT } from '../helpers';
import { chromeLaunchOptions, e2eReady, expectText, installedBaseLibs, Runner, startRunner, VERIFIED_BASELIBS } from './runner';

const RUNTIME_DIR = path.join(REPO_ROOT, 'packages/core/dist/runtime');

const PAGE_JS = `
Page({
  data: { step: 'start', adError: '' },
  onLoad() {
    this.setData({ step: 'onLoad 开始' });
    const ad = wx.createRewardedVideoAd({ adUnitId: 'adunit-test' });
    ad.onError(err => this.setData({ adError: String(err && err.errMsg) }));
    ad.load().catch(() => undefined);
    // 崩溃时这一行永远跑不到
    this.setData({ step: 'onLoad 结束' });
  }
});
`;

describe.skipIf(!e2eReady)('伴生 SDK 子包占位', () => {
  let server: DevServer;
  let browser: Browser;
  let page: Page;
  let base = '';

  beforeAll(async () => {
    const projectPath = createProject({
      'project.config.json': { appid: 'wxtest0000000000', compileType: 'miniprogram' },
      'app.json': { pages: ['pages/ad/ad'] },
      'app.js': 'App({});',
      'app.wxss': '',
      'pages/ad/ad.json': {},
      'pages/ad/ad.js': PAGE_JS,
      'pages/ad/ad.wxml': '<view id="step">{{step}}</view><view id="ad-error">{{adError}}</view>',
      'pages/ad/ad.wxss': ''
    });

    server = new DevServer({
      projectPath,
      port: 0,
      watch: false,
      runtimeDir: RUNTIME_DIR,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
    });
    base = await server.start();
    browser = await chromium.launch(chromeLaunchOptions);
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('createRewardedVideoAd 不再打断 onLoad，失败走 onError', async () => {
    await page.goto(base);
    await page.waitForFunction(() => window.__wxa_test_api__);
    await page.evaluate(() => window.__wxa_test_api__.ready);

    const { frameName } = (await page.evaluate(() => window.__wxa_test_api__.currentPage()))!;
    const frame = page.frame({ name: frameName })!;

    await frame.waitForFunction(() => document.querySelector('#step')?.textContent === 'onLoad 结束');
    await frame.waitForFunction(() => (document.querySelector('#ad-error')?.textContent || '').length > 0);

    const errors = await page.evaluate(() => window.__wxa_test_api__.errors());
    expect(errors.filter(e => e.message.includes('RewardedVideoAd'))).toEqual([]);
  });
});

// 同 Taro 3 的 window 垫片：启动时把全局对象上的属性逐个拷到自己的 window 上
const TARO_LIKE_APP_JS = `
const root = Function('return this')();
const taroWindow = {};
for (const key of Object.getOwnPropertyNames(root)) taroWindow[key] = root[key];
App({
  onLaunch() {
    wx.cloud.init({ env: 'test-env' });
  }
});
`;

const CLOUD_PAGE_JS = `
Page({
  data: { result: '' },
  onLoad() {
    wx.cloud.callFunction({ name: 'login', data: {} }).then(
      () => this.setData({ result: '成功' }),
      err => this.setData({ result: String(err && err.errMsg) })
    );
  }
});
`;

describe.skipIf(!e2eReady)('云开发', () => {
  for (const version of VERIFIED_BASELIBS) {
    describe.skipIf(!installedBaseLibs.has(version))(`基础库 ${version}`, () => {
      let runner: Runner;

      beforeAll(async () => {
        runner = await startRunner({
          'app.json': { pages: ['pages/index/index'], cloud: true },
          'app.js': TARO_LIKE_APP_JS,
          'pages/index/index.json': {},
          'pages/index/index.wxml': '<view id="result">{{result}}</view>',
          'pages/index/index.js': CLOUD_PAGE_JS
        }, { baseLibVersion: version });
      });

      afterAll(() => runner?.close());

      it('启动时遍历全局对象、onLaunch 里 init 都不中断启动，调用云函数明确失败', async () => {
        const frame = await runner.open('/');
        await expectText(frame, '#result', /^cloud\.callFunction:fail .*wxa-runner 不支持云开发（tcbapi_\w+）/, 15000);
        expect(await runner.page.evaluate(() => window.__wxa_test_api__.errors())).toEqual([]);
      }, 60000);
    });
  }
});
