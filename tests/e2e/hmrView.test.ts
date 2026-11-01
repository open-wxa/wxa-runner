/**
 * 端到端：修改 WXML、WXSS 后直接换上新内容和新样式，不刷新页面、不丢状态
 *
 * 需要本机安装微信开发者工具，以及 Chrome（或通过 WXA_CHROME 指定浏览器路径）。
 */

import { describe, expect, it } from 'vitest';
import { useHmrApp } from './hmrApp';
import { e2eReady } from './runner';

describe.skipIf(!e2eReady)('热更新：WXML 与 WXSS', () => {
  const app = useHmrApp();
  const { edit, current, textOf, waitForText, hostReloaded, tap, frameAt, waitForColor, colorOf, waitForPage } = app;

  it('开发者修改页面 WXML 后，新内容直接出现，页面不刷新、已有状态保留', async () => {
    await tap('#add');
    await tap('#add');
    await waitForText('#count', '2');

    edit('pages/index/index.wxml', wxml => wxml.replace('<view id="count">{{count}}</view>', '<view id="count">{{count}}</view><view id="hot">已更新 {{count}}</view>'));

    await waitForText('#hot', '已更新 2');
    expect(await textOf('#count')).toBe('2');
    expect(await textOf('#loads')).toBe('1');
    expect(await hostReloaded()).toBe(false);
  });

  it('开发者修改组件 WXML 后，组件内部状态保留', async () => {
    // 组件内的 class 会被基础库加上组件前缀，用组件节点的 id 定位
    await tap('#badge wx-button');
    await tap('#badge wx-button');
    await waitForText('#badge wx-view', 'n=2');

    edit('components/badge/badge.wxml', wxml => wxml.replace('n={{n}}', '徽标 {{n}}'));

    await waitForText('#badge wx-view', '徽标 2');
    expect(await hostReloaded()).toBe(false);
  });

  it('开发者修改页面 WXSS 后，新样式直接生效、删掉的规则不再生效，页面不刷新、已有状态保留', async () => {
    await tap('#add');
    await tap('#add');
    await waitForText('#count', '2');

    edit('pages/index/index.wxss', () => '#count { color: rgb(1, 2, 3); }');

    await waitForColor(await current(), '#count', 'rgb(1, 2, 3)');
    expect(await colorOf('#loads')).not.toBe('rgb(20, 20, 20)');
    expect(await textOf('#count')).toBe('2');
    expect(await hostReloaded()).toBe(false);
  });

  it('开发者在加载时为空的 app.wxss 里写入样式后，页面自己的同名规则仍然优先，与刷新后一致', async () => {
    edit('app.wxss', () => '#loads { color: rgb(255, 0, 0); } #count { color: rgb(30, 30, 30); }');

    await waitForColor(await current(), '#count', 'rgb(30, 30, 30)');
    expect(await colorOf('#loads')).toBe('rgb(20, 20, 20)');
  });

  it('开发者修改 WXSS 后，渲染层的组件收到重新布局的通知', async () => {
    // 基础库的组件（如 movable-area 重新计算尺寸）只靠 pageReRender 事件得知样式变了，事件本身就是契约。
    // 页面打开约 300ms 后宿主发出 onAppRouteDone，基础库也会派发一次，先等它过去；
    // 再只认样式已经换新时收到的通知
    const frame = await current();
    await app.page.waitForTimeout(500);
    await frame.evaluate(() => document.addEventListener('pageReRender', () => {
      if (getComputedStyle(document.querySelector('#count')!).color === 'rgb(1, 2, 3)') (window as any).__reRendered = true;
    }));

    edit('pages/index/index.wxss', () => '#count { color: rgb(1, 2, 3); }');

    await frame.waitForFunction(() => (window as any).__reRendered, undefined, { timeout: 10000 });
  });

  it('开发者修改组件 WXSS 后，组件换上新样式，组件内部状态保留', async () => {
    await tap('#badge wx-button');
    await waitForText('#badge wx-view', 'n=1');

    edit('components/badge/badge.wxss', () => '.badge-n { color: rgb(4, 5, 6); }');

    await waitForColor(await current(), '#badge wx-view', 'rgb(4, 5, 6)');
    expect(await textOf('#badge wx-view')).toBe('n=1');
    expect(await hostReloaded()).toBe(false);
  });

  it('开发者修改 app.wxss 后，页面栈里前台和后台的页面都换上新样式', async () => {
    await tap('#add');
    await waitForText('#count', '1');
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/detail/detail'));
    await waitForPage('pages/detail/detail');

    edit('app.wxss', () => 'page { color: rgb(7, 8, 9); }');

    await waitForColor(await frameAt(1), '#tag', 'rgb(7, 8, 9)');
    await waitForColor(await frameAt(0), '#count', 'rgb(7, 8, 9)');
    expect((await (await frameAt(0)).textContent('#count'))?.trim()).toBe('1');
    expect(await hostReloaded()).toBe(false);
  });

  it('开发者修改被 @import 的样式文件后，引用它的页面换上新样式', async () => {
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/detail/detail'));
    await waitForPage('pages/detail/detail');

    edit('styles/common.wxss', () => '#tag { color: rgb(10, 11, 12); }');

    await waitForColor(await current(), '#tag', 'rgb(10, 11, 12)');
    expect(await hostReloaded()).toBe(false);
  });
});
