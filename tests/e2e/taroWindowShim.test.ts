/**
 * 端到端：Taro 全局垫片拷贝完全局对象后，分包页里的 addEventListener 注册不报错
 *
 * 回归真实项目（#112 报告的场景）：Taro 3.4.3 的全局垫片初始只有 { navigator, document: { createElement } }，
 * 启动时按 hasOwnProperty 把全局对象的可枚举属性逐个拷到自己身上（br[e]=i[e]），"atob" 除外；
 * 分包页再用垫片的 document.createElement 做文档探测（垫片自带假体，探测恒真）并注册可见性监听。
 *
 * 基础库把伴生 SDK 子包的全局挂成读取时同步加载 SDK 的存取器（__cloudSDKMain__ / ADSDK /
 * __splashAdFloatWindowSDK__ 等）。拷贝循环逐个读取这些属性，在没有伴生 SDK 加载机制的环境里
 * 一踩就抛错：整个垫片模块加载失败、垫片半途而废，Taro 自己挂在垫片上的 addEventListener
 * 空函数占位还没挂上，分包页注册直接报 "t.addEventListener is not a function"。
 *
 * guardSdkGlobals 把这些存取器换成返回 undefined 之后，拷贝循环不再踩雷，垫片完整、注册是 no-op。
 */

import { Frame } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eReady, expectText, Runner, startRunner } from './runner';

const APP_JS = `
const root = Function('return this')();
// 同 Taro 运行时的启动顺序：API 初始化先读 wx.cloud（e.cloud=wx.cloud），这一次读取会触发
// 基础库的伴生 SDK 加载尝试——失败后 ADSDK / __splashAdFloatWindowSDK__ 等读取即抛的存取器
// 才被留在全局对象上，随后初始化的垫片拷贝循环才会踩到它们。修复前的 Fatal 也在这一步抛出。
try { void wx.cloud; } catch { /* 修复前：Fatal: unexpected loadSdkSubPackage case */ }
// 同 Taro 3.4.3 的 br 垫片：初始形态只有 navigator 和一个带 createElement 的 document 假体
const shim = { navigator: {}, document: { createElement: () => ({}) } };
for (const key of Object.getOwnPropertyNames(root)) {
  if (key === 'atob' || Object.prototype.hasOwnProperty.call(shim, key)) continue;
  shim[key] = root[key];
}
// Taro 自己挂的 no-op 占位：真机的逻辑层没有 DOM，监听注册本来就是空操作
shim.addEventListener = () => {};
// 分包页拿到的是同一个垫片（Taro 的模块导出）
App({ globalData: { shim } });
`;

const SUB_PAGE_JS = `
Page({
  data: { done: '', detected: '' },
  onLoad() {
    const shim = getApp().globalData.shim;
    // 同分包页的文档探测：垫片的 document 有 createElement，探测恒真，随后注册可见性监听
    const detected = typeof shim !== 'undefined' && shim.document && shim.document.createElement ? 'yes' : 'no';
    if (detected === 'yes') shim.addEventListener('visibilitychange', () => {}, false);
    this.setData({ done: 'registered', detected });
  }
});
`;

describe.skipIf(!e2eReady)('Taro 全局垫片拷贝与分包页监听注册', () => {
  let runner: Runner;
  const currentFrame = async (): Promise<Frame> => {
    const { frameName } = (await runner.page.evaluate(() => window.__wxa_test_api__.currentPage()))!;
    return runner.page.frame({ name: frameName })!;
  };

  beforeAll(async () => {
    runner = await startRunner({
      'app.json': { pages: ['pages/index/index'], cloud: true, subPackages: [{ root: 'subPkg', pages: ['sub/sub'] }] },
      'app.js': APP_JS,
      'pages/index/index.json': {},
      'pages/index/index.wxml': '<view id="keys">{{keys}}</view><view id="to-sub" bindtap="toSub">去分包页</view>',
      'pages/index/index.js': `Page({
        data: { keys: '' },
        onLoad() {
          const shim = getApp().globalData.shim;
          // 垫片完整：拷贝循环跑完了（没有半途而废），addEventListener 占位也挂上了
          const keys = Object.keys(shim);
          this.setData({ keys: keys.length + (typeof shim.addEventListener === 'function' ? '+fn' : '-no-fn') });
        },
        toSub() { wx.navigateTo({ url: '/subPkg/sub/sub' }); }
      });`,
      'subPkg/sub/sub.json': {},
      'subPkg/sub/sub.wxml': '<view id="done">{{done}}</view><view id="detected">{{detected}}</view>',
      'subPkg/sub/sub.js': SUB_PAGE_JS,
      'subPkg/sub/sub.wxss': ''
    });
  });

  afterAll(() => runner?.close());

  it('垫片拷贝完整、addEventListener 占位还在', async () => {
    const frame = await runner.open('/');
    await expectText(frame, '#keys', /^(0|[1-9]\d*)\+fn$/);
    expect(await runner.page.evaluate(() => window.__wxa_test_api__.errors())).toEqual([]);
  });

  it('分包页的文档探测成立，addEventListener 注册不报错', async () => {
    const frame = await runner.open('/');
    await frame.click('#to-sub');
    await runner.page.evaluate(() => window.__wxa_test_api__.waitForPage('subPkg/sub/sub'));
    const sub = await currentFrame();
    await expectText(sub, '#detected', 'yes');
    await expectText(sub, '#done', 'registered');
    expect(await runner.page.evaluate(() => window.__wxa_test_api__.errors())).toEqual([]);
  });
});
