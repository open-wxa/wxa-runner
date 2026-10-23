/**
 * 端到端：组件引用要在编译时解析成组件路径。基础库运行时只把引用和当前路径拼在一起，
 * 不查找 miniprogram_npm、不补 /index；没解析好的组件静默渲染为空
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eReady, expectText, Runner, startRunner } from './runner';

describe.skipIf(!e2eReady)('组件引用解析', () => {
  let runner: Runner;

  beforeAll(async () => {
    runner = await startRunner({
      // Vant Weapp 文档推荐在 app.json 里按包名全局注册
      'app.json': { pages: ['pages/index/index'], usingComponents: { 'g-npm': 'my-ui/btn', 'g-dir': '/components/dir' } },
      'pages/index/index.json': {
        usingComponents: { 'own-npm': 'my-ui/btn', 'own-dir': '../../components/dir', box: '../../components/box/box' }
      },
      'pages/index/index.wxml': '<g-npm id="g-npm"/><g-dir id="g-dir"/><own-npm id="own-npm"/><own-dir id="own-dir"/><box/>',
      'pages/index/index.js': 'Page({});',
      'components/box/box.json': { component: true, componentGenerics: { slotted: { default: 'my-ui/btn' } } },
      'components/box/box.wxml': '<g-npm/><slotted/>',
      'components/box/box.js': 'Component({});',
      'components/dir/index.json': { component: true },
      'components/dir/index.wxml': '<view>dir</view>',
      'components/dir/index.js': 'Component({});',
      'miniprogram_npm/my-ui/btn/index.json': { component: true },
      'miniprogram_npm/my-ui/btn/index.wxml': '<view>btn</view>',
      'miniprogram_npm/my-ui/btn/index.js': 'Component({});'
    });
  });

  afterAll(async () => {
    await runner?.close();
  });

  it('全局和页面里按包名引用的 npm 组件、省略 /index 的目录组件、抽象节点的默认实现都渲染出来', async () => {
    const frame = await runner.open('/?path=pages/index/index');
    await expectText(frame, '#g-npm', 'btn');
    await expectText(frame, '#own-npm', 'btn');
    await expectText(frame, '#g-dir', 'dir');
    await expectText(frame, '#own-dir', 'dir');
    // 组件内的 id 会加上组件的前缀，按标签找
    await expectText(frame, 'wx-box wx-g-npm', 'btn');
    await expectText(frame, 'wx-box wx-slotted', 'btn');
    expect(await runner.page.evaluate(() => window.__wxa_test_api__.errors())).toEqual([]);
  });
});
