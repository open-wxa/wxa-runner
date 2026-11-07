/**
 * e2e：伴生 SDK 子包的全局读取不抛错
 *
 * 基础库初始化时把 __cloudSDKMain__ / ADSDK / __splashAdFloatWindowSDK__ 等伴生 SDK 子包的全局
 * 挂成「读取时同步加载 SDK」的存取器。真机和开发者工具由原生层加载伴生文件，读取不抛；
 * 浏览器运行时没有这套加载机制，读取在基础库内部抛 TypeError。
 *
 * 业务代码直接读它们会崩；更隐蔽的是 Taro 这类全局垫片把宿主全局的可枚举属性逐个读取后
 * 拷贝（br[e]=i[e]），读到任何一个抛错的属性，整个垫片模块加载失败，下游依赖垫片的代码跟着出错。
 * 运行时在业务代码执行前把读取即抛的全局降级成「返回 undefined」（对齐真机行为）。
 */

import { afterAll, beforeAll, describe, it } from 'vitest';
import { e2eReady, expectText, Runner, startRunner } from './runner';

describe.skipIf(!e2eReady)('伴生 SDK 子包的全局读取不抛错', () => {
  let runner: Runner;

  beforeAll(async () => {
    runner = await startRunner({
      'app.json': { pages: ['pages/index/index'] },
      'app.js': `
        const root = Function('return this')();
        const names = ['__cloudSDKMain__', 'ADSDK', '__splashAdFloatWindowSDK__'];
        const values = names.map(name => {
          try { return typeof root[name]; } catch { return 'throw'; }
        });
        App({ globalData: { values: values.join(',') } });`,
      'pages/index/index.json': {},
      'pages/index/index.wxml': '<view id="values">{{values}}</view>',
      'pages/index/index.js': `Page({
        data: { values: '' },
        onLoad() { this.setData({ values: getApp().globalData.values }); }
      });`
    });
  });

  afterAll(() => runner?.close());

  it('读取伴生 SDK 子包的全局返回 undefined 而不是抛错，小程序照常启动', async () => {
    const frame = await runner.open('/');
    await expectText(frame, '#values', 'undefined,undefined,undefined');
  });
});
