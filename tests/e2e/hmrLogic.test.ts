/**
 * 端到端：修改页面、组件的 JS 后换上新逻辑，不刷新页面
 *
 * 需要本机安装微信开发者工具，以及 Chrome（或通过 WXA_CHROME 指定浏览器路径）。
 */

import { describe, expect, it } from 'vitest';
import { useHmrApp } from './hmrApp';
import { e2eReady } from './runner';

describe.skipIf(!e2eReady)('热更新：JS', () => {
  const app = useHmrApp();
  const { edit, textOf, waitForText, hostReloaded, tap, waitForPage, hotUpdated } = app;

  it('开发者修改页面 JS 后，下一次交互执行新逻辑，data 不重置、onLoad 不重跑，新增的 data 字段生效', async () => {
    await tap('#add');
    await tap('#add');
    await waitForText('#count', '2');

    edit('pages/index/index.js', js => js
      .replace('this.data.count + 1', 'this.data.count + 10')
      .replace("data: { count: 0, loads: 0 }", "data: { count: 0, loads: 0, label: '新字段' }"));

    await waitForText('#label', '新字段');
    expect(await textOf('#count')).toBe('2');
    await tap('#add');
    await waitForText('#count', '12');
    expect(await textOf('#loads')).toBe('1');
    expect(await hostReloaded()).toBe(false);
  });

  it('页面栈里不在前台的页面也换上新逻辑', async () => {
    await tap('#add');
    await waitForText('#count', '1');
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/detail/detail'));
    await waitForPage('pages/detail/detail');

    const updated = hotUpdated();
    edit('pages/index/index.js', js => js.replace('this.data.count + 1', 'this.data.count + 10'));
    await updated;
    await app.page.evaluate(() => window.__wxa_test_api__.navigateBack());
    await waitForPage('pages/index/index');

    expect(await textOf('#count')).toBe('1');
    await tap('#add');
    await waitForText('#count', '11');
    expect(await hostReloaded()).toBe(false);
  });

  it('修改页面 JS 后新打开的页面使用新代码', async () => {
    const updated = hotUpdated();
    edit('pages/detail/detail.js', js => js.replace("tag: 'old'", "tag: 'new'"));
    await updated;

    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/detail/detail'));
    await waitForPage('pages/detail/detail');
    await waitForText('#tag', 'new');
    expect(await hostReloaded()).toBe(false);
  });

  it('构建工具重写了大量内容没变的文件时，只按内容真正变化的文件热更新', async () => {
    const updated = hotUpdated();
    // uni-app 的监听构建每次保存都会重写全部 js 和 wxss
    for (const file of ['app.js', 'app.wxss', 'pages/detail/detail.js', 'components/badge/badge.js']) edit(file, content => content);
    edit('pages/index/index.wxml', wxml => wxml.replace('<view id="loads">', '<view id="hot">新节点</view><view id="loads">'));
    await updated;

    await waitForText('#hot', '新节点');
    expect(app.serverLogs.filter(line => line.includes('已更新'))).toEqual([expect.stringMatching(/^\[wxa-runner\] pages\/index\/index\.wxml 已更新/)]);
    expect(await hostReloaded()).toBe(false);
  });

  it('用 Component 构造的页面（如 uni-app）修改 JS 后重新挂载这一页：页面栈、globalData 保留，不整页刷新', async () => {
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/vue/vue'));
    await waitForPage('pages/vue/vue');
    await tap('#inc');
    await waitForText('#n', '1');

    const updated = hotUpdated();
    edit('pages/vue/vue.js', js => js.replace("tag: 'old'", "tag: 'new'"));
    await updated;

    // 页面自己的状态随重新挂载回到初始值，与 Vite 下修改 Vue 组件 <script> 的语义一致
    await waitForText('#tag', 'new');
    expect(await textOf('#n')).toBe('0');
    expect((await app.page.evaluate(() => window.__wxa_test_api__.pageStack())).map(p => p.path)).toEqual(['pages/index/index', 'pages/vue/vue']);
    await app.page.evaluate(() => window.__wxa_test_api__.navigateBack());
    await waitForPage('pages/index/index');
    expect(await textOf('#loads')).toBe('1');
    expect(await hostReloaded()).toBe(false);
  });

  it('修改组件 JS 后只重新挂载这个组件，所在页面的状态保留', async () => {
    await tap('#add');
    await tap('#add');
    await waitForText('#count', '2');
    await tap('#badge wx-button');
    await waitForText('#badge wx-view', 'n=1');

    const updated = hotUpdated();
    edit('components/badge/badge.js', js => js.replace('this.data.n + 1', 'this.data.n + 10'));
    await updated;

    await waitForText('#badge wx-view', 'n=0');
    await tap('#badge wx-button');
    await waitForText('#badge wx-view', 'n=10');
    expect(await textOf('#count')).toBe('2');
    expect(await hostReloaded()).toBe(false);
  });
});
