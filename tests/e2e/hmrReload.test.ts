/**
 * 端到端：无法热更新时整页刷新，并恢复页面栈
 *
 * 需要本机安装微信开发者工具，以及 Chrome（或通过 WXA_CHROME 指定浏览器路径）。
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { DevServer } from '../../packages/core/src/server/DevServer';
import { RUNTIME_DIR, useHmrApp } from './hmrApp';
import { e2eReady } from './runner';

describe.skipIf(!e2eReady)('热更新：退回整页刷新', () => {
  const app = useHmrApp();
  const { edit, markHost, waitForPage, stack, waitForReload } = app;

  it('修改 app.js 这类无法热更新的文件时整页刷新，整个页面栈连同参数都恢复', async () => {
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/detail/detail?id=7'));
    await waitForPage('pages/detail/detail');
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/vue/vue'));
    await waitForPage('pages/vue/vue');

    edit('app.js', js => js.replace('loads: 0', 'loads: 100'));

    await waitForReload();
    expect(await stack()).toEqual([
      { path: 'pages/index/index', query: {} },
      { path: 'pages/detail/detail', query: { id: '7' } },
      { path: 'pages/vue/vue', query: {} }
    ]);
    // 恢复出来的是真实的页面栈：可以一路返回
    await app.page.evaluate(() => window.__wxa_test_api__.navigateBack());
    await waitForPage('pages/detail/detail');
  });

  it('恢复页面栈途中又触发整页刷新，最终仍恢复完整的页面栈', async () => {
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/detail/detail?id=7'));
    await waitForPage('pages/detail/detail');
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/vue/vue'));
    await waitForPage('pages/vue/vue');

    // 让恢复卡在第三页：第一次请求它的渲染层时一直不响应（unroute 会放行挂起的请求，所以不能用）；
    // 第二次刷新后的请求正常放行
    let stalled!: () => void;
    const reachedThirdPage = new Promise<void>(resolve => (stalled = resolve));
    let held = false;
    await app.page.route('**/__wxa__/webview/pages/vue/vue.html*', route => {
      if (held) return route.continue();
      held = true;
      stalled();
    });
    edit('app.js', js => js.replace('loads: 0', 'loads: 100'));
    await reachedThirdPage;
    expect((await stack()).map(p => p.path)).toEqual(['pages/index/index', 'pages/detail/detail']);

    await markHost();
    edit('app.js', js => js.replace('loads: 100', 'loads: 200'));

    await waitForReload();
    expect((await stack()).map(p => p.path)).toEqual(['pages/index/index', 'pages/detail/detail', 'pages/vue/vue']);
  });

  it('自动刷新后 setup 出错没能启动，修好后的刷新仍恢复整个页面栈', async () => {
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/detail/detail?id=7'));
    await waitForPage('pages/detail/detail');

    edit('wxa.setup.js', () => "export default { run() { throw new Error('setup 坏了'); } };");
    await app.page.waitForFunction(() => !(window as any).__hmrMarker, undefined, { timeout: 10000 });
    await app.page.waitForSelector('.wxa-error');

    await markHost();
    edit('wxa.setup.js', () => 'export default {};');
    await waitForReload();
    expect(await stack()).toEqual([
      { path: 'pages/index/index', query: {} },
      { path: 'pages/detail/detail', query: { id: '7' } }
    ]);
  });

  it('自动刷新后 setup 出错，开发者修好后手动刷新只恢复当前页面', async () => {
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/detail/detail?id=7'));
    await waitForPage('pages/detail/detail');

    edit('wxa.setup.js', () => "export default { run() { throw new Error('setup 坏了'); } };");
    await app.page.waitForFunction(() => !(window as any).__hmrMarker, undefined, { timeout: 10000 });
    await app.page.waitForSelector('.wxa-error');

    // 不经过开发服务器：模拟开发者先手动刷新，再改好 setup
    await app.server!.close();
    fs.writeFileSync(path.join(app.projectPath, 'wxa.setup.js'), 'export default {};');
    const restarted = new DevServer({ projectPath: app.projectPath, port: Number(new URL(app.page.url()).port), watch: false, runtimeDir: RUNTIME_DIR, logger: { log: () => undefined, warn: () => undefined, error: () => undefined } });
    app.server = restarted;
    await restarted.start();
    await app.page.reload();
    await app.page.waitForFunction(() => window.__wxa_test_api__);
    await app.page.evaluate(() => window.__wxa_test_api__.ready);
    expect(await stack()).toEqual([{ path: 'pages/detail/detail', query: { id: '7' } }]);
  });

  it('开发者手动刷新时只恢复当前页面', async () => {
    await app.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/detail/detail?id=7'));
    await waitForPage('pages/detail/detail');

    await app.page.reload();
    await app.page.waitForFunction(() => window.__wxa_test_api__);
    await app.page.evaluate(() => window.__wxa_test_api__.ready);
    expect(await stack()).toEqual([{ path: 'pages/detail/detail', query: { id: '7' } }]);
  });

  it('新代码执行出错、无法热更新时退回整页刷新', async () => {
    edit('pages/detail/detail.js', () => "throw new Error('页面模块出错');");
    await app.page.waitForFunction(() => !(window as any).__hmrMarker, undefined, { timeout: 10000 });
  });
});
