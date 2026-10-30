/**
 * 端到端：web-view 组件
 *
 * web-view 铺满整个页面显示 src 指向的网页；网页跟着所在页面走，页面关闭时一起消失。
 * 新窗口模式下网页在新窗口打开：和模拟器跨站的网页，Cookie 也能正常使用。
 */

import http from 'http';
import { AddressInfo } from 'net';
import type { Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { e2eReady, expectText, Runner, startRunner } from './runner';

const WEB_WXML = `
<web-view src="{{src}}" bindload="onWebLoad"></web-view>
<view id="loaded">{{loaded}}</view>
`;

const WEB_JS = `
Page({
  data: { src: '', loaded: '' },
  onLoad(query) {
    this.next = decodeURIComponent(query.next || '');
    this.setData({ src: decodeURIComponent(query.src || '') });
  },
  setSrc(src) {
    this.setData({ src });
  },
  onWebLoad(e) {
    this.setData({ loaded: e.detail.src });
    // 第一个网页加载完后改 src，模拟页面切换网页
    if (this.next) {
      const next = this.next;
      this.next = '';
      this.setData({ src: next });
    }
  }
});
`;

const PROJECT = {
  'app.json': { pages: ['pages/index/index', 'pages/web/web'] },
  'pages/index/index.json': {},
  'pages/index/index.wxml': '<view>首页</view>',
  'pages/index/index.js': 'Page({});',
  'pages/web/web.json': {},
  'pages/web/web.wxml': WEB_WXML,
  'pages/web/web.js': WEB_JS,
  'h5/hello.html': '<!doctype html><meta charset="utf-8"><h1 id="title">Hello H5</h1><a id="next" href="bye.html">下一页</a>',
  'h5/bye.html': '<!doctype html><meta charset="utf-8"><h1 id="title">Bye H5</h1>'
};

const webPage = (url: string) => `/?path=pages/web/web&src=${encodeURIComponent(url)}`;

/**
 * 和模拟器（localhost）跨站的网页：/login 用 SameSite=Lax 的 Cookie 记下登录态后跳到 /hello，页面上显示收到的 Cookie
 */
async function startCrossSiteH5(): Promise<{ origin: string; close(): void }> {
  const server = http.createServer((req, res) => {
    if (req.url === '/login') {
      res.writeHead(302, { 'set-cookie': 'sid=1; Path=/; HttpOnly; SameSite=Lax', location: '/hello' });
      res.end();
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    const title = req.url === '/bye' ? 'Bye H5' : 'Hello H5';
    res.end(`<!doctype html><meta charset="utf-8"><h1 id="title">${title}</h1><p id="cookie">${req.headers.cookie ?? ''}</p>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close() };
}

describe.skipIf(!e2eReady)('web-view', () => {
  let runner: Runner;
  let hello = '';
  let bye = '';

  const embedded = () => runner.page.frameLocator('iframe[data-current]').frameLocator('iframe');

  beforeAll(async () => {
    runner = await startRunner(PROJECT);
    hello = runner.base + '/h5/hello.html';
    bye = runner.base + '/h5/bye.html';
  });

  afterAll(() => runner?.close());

  it('web-view 铺满页面显示 src 指向的网页，加载完成后页面收到 load', async () => {
    const frame = await runner.open(webPage(hello));
    await expect(embedded().locator('#title').textContent()).resolves.toBe('Hello H5');
    await expectText(frame, '#loaded', hello);

    const layout = await frame.evaluate(() => {
      const rect = document.querySelector('iframe')!.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height, windowWidth: innerWidth, windowHeight: innerHeight };
    });
    expect(layout).toMatchObject({ left: 0, top: 0, width: layout.windowWidth, height: layout.windowHeight });
  });

  it('页面改了 src 后 web-view 打开新地址', async () => {
    const frame = await runner.open(`${webPage(hello)}&next=${encodeURIComponent(bye)}`);
    await expectText(frame, '#loaded', bye);
    await expect(embedded().locator('#title').textContent()).resolves.toBe('Bye H5');
  });

  it('用户在网页里点链接跳转后，页面收到新网页的 load', async () => {
    const frame = await runner.open(webPage(hello));
    await expectText(frame, '#loaded', hello);

    await embedded().locator('#next').click();
    await expect(embedded().locator('#title').textContent()).resolves.toBe('Bye H5');
    await expectText(frame, '#loaded', bye);
  });

  it('返回上一页后网页随页面一起关闭', async () => {
    await runner.open('/?path=pages/index/index');
    await runner.page.evaluate(url => window.__wxa_test_api__.navigateTo(url), `/pages/web/web?src=${encodeURIComponent(hello)}`);
    await expect(embedded().locator('#title').textContent()).resolves.toBe('Hello H5');

    await runner.page.evaluate(() => window.__wxa_test_api__.navigateBack());
    expect(runner.page.frames().some(frame => frame.url() === hello)).toBe(false);
  });
});

describe.skipIf(!e2eReady)('web-view 跨站提示', () => {
  let runner: Runner;
  let h5: Awaited<ReturnType<typeof startCrossSiteH5>>;

  beforeAll(async () => {
    h5 = await startCrossSiteH5();
    runner = await startRunner(PROJECT);
  });

  afterAll(async () => {
    await runner?.close();
    h5?.close();
  });

  it('网页和模拟器跨站时提示 Cookie 可能不生效，同一站点只提示一次', async () => {
    const warnings: string[] = [];
    runner.page.on('console', message => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    await runner.open(webPage(h5.origin + '/hello'));
    const setSrc = (src: string) => runner.page.evaluate(url => window.__wxa_test_api__.callPageMethod('setSrc', url), src);
    await setSrc(runner.base + '/h5/bye.html');
    await setSrc(h5.origin + '/bye');

    // 跨站的网页打开了两个地址，同一站点的网页不提示：一共只有一条
    await vi.waitFor(() => expect(warnings.some(text => text.includes(h5.origin))).toBe(true));
    const crossSite = warnings.filter(text => text.startsWith('[wxa-runner] web-view'));
    expect(crossSite).toHaveLength(1);
    expect(crossSite[0]).toContain(h5.origin);
    expect(crossSite[0]).toContain('--webview-window');
  });
});

describe.skipIf(!e2eReady)('web-view 新窗口模式', () => {
  let runner: Runner;
  let h5: Awaited<ReturnType<typeof startCrossSiteH5>>;

  /** 打开 web-view 页面，等网页窗口打开 */
  const openWebPage = async (src: string): Promise<Page> => {
    const popup = runner.page.waitForEvent('popup');
    await runner.open(webPage(src));
    return popup;
  };
  const webViews = () => runner.page.evaluate(() => window.__wxa_test_api__.webViews());

  beforeAll(async () => {
    h5 = await startCrossSiteH5();
    runner = await startRunner(PROJECT, { webViewWindow: true });
  });

  afterAll(async () => {
    await runner?.close();
    h5?.close();
  });

  it('网页在新窗口打开，模拟器里显示占位；不触发 bindload', async () => {
    const popup = await openWebPage(h5.origin + '/hello');
    await expect(popup.locator('#title').textContent()).resolves.toBe('Hello H5');

    const [view] = await webViews();
    expect(view).toEqual({ src: h5.origin + '/hello', windowName: expect.stringMatching(/^wxa-h5-/) });
    await expect(popup.evaluate(() => window.name)).resolves.toBe(view.windowName);

    // 窗口名和渲染层 iframe 不同名：页面本身没有被导航成网页
    const frame = runner.page.frame({ name: (await runner.page.evaluate(() => window.__wxa_test_api__.currentPage()))!.frameName })!;
    await expect(frame.locator('text=H5 已在新窗口打开').count()).resolves.toBe(1);
    expect(await frame.textContent('#loaded')).toBe('');
  });

  it('跨站网页自己写的 SameSite=Lax Cookie 正常保存和发送', async () => {
    const popup = await openWebPage(h5.origin + '/login');
    await popup.waitForURL(h5.origin + '/hello');
    await expect(popup.locator('#cookie').textContent()).resolves.toBe('sid=1');
  });

  it('src 改变后在同一个窗口里打开新地址', async () => {
    const popup = await openWebPage(h5.origin + '/hello');
    const pages = runner.page.context().pages().length;

    await runner.page.evaluate(src => window.__wxa_test_api__.callPageMethod('setSrc', src), h5.origin + '/bye');
    await popup.waitForURL(h5.origin + '/bye');
    await expect(popup.locator('#title').textContent()).resolves.toBe('Bye H5');
    expect(runner.page.context().pages()).toHaveLength(pages);
  });

  it('网页改了自己的 window.name 后，src 改变仍在原窗口打开，离开页面时一起关闭', async () => {
    const popup = await openWebPage(h5.origin + '/hello');
    await popup.evaluate(() => {
      window.name = 'renamed-by-h5';
    });
    const pages = runner.page.context().pages().length;

    await runner.page.evaluate(src => window.__wxa_test_api__.callPageMethod('setSrc', src), h5.origin + '/bye');
    await popup.waitForURL(h5.origin + '/bye');
    expect(runner.page.context().pages()).toHaveLength(pages);

    await runner.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/index/index'));
    await popup.waitForEvent('close');
  });

  it('跳到下一页时关闭网页窗口，返回后重新打开', async () => {
    const popup = await openWebPage(h5.origin + '/hello');

    await runner.page.evaluate(() => window.__wxa_test_api__.navigateTo('/pages/index/index'));
    await popup.waitForEvent('close');

    const reopened = runner.page.waitForEvent('popup');
    await runner.page.evaluate(() => window.__wxa_test_api__.navigateBack());
    await expect((await reopened).locator('#title').textContent()).resolves.toBe('Hello H5');
  });

  it('关闭 web-view 所在页面、重新打开小程序时，网页窗口一起关闭', async () => {
    let popup = await openWebPage(h5.origin + '/hello');
    await runner.page.evaluate(() => window.__wxa_test_api__.redirectTo('/pages/index/index'));
    await popup.waitForEvent('close');

    popup = await openWebPage(h5.origin + '/hello');
    await runner.open('/?path=pages/index/index');
    expect(popup.isClosed()).toBe(true);
  });
});

describe.skipIf(!e2eReady)('web-view 新窗口模式：弹窗被拦截', () => {
  let runner: Runner;
  let h5: Awaited<ReturnType<typeof startCrossSiteH5>>;

  beforeAll(async () => {
    h5 = await startCrossSiteH5();
    runner = await startRunner(PROJECT, { webViewWindow: true });
    // 无头 Chrome 不拦截弹窗，这里模拟普通浏览器：用户刚点过页面时 window.open 才能打开窗口。
    // 不能看 navigator.userActivation：Playwright 的 evaluate 也算用户操作。脚本在每个 frame 里都会执行
    await runner.page.addInitScript(() => {
      const host = window.top as Window & { __clickedAt?: number };
      addEventListener('click', event => {
        if (event.isTrusted) host.__clickedAt = Date.now();
      }, true);
      if (window !== host) return;
      const open = window.open;
      window.open = function (...args) {
        return Date.now() - (host.__clickedAt ?? 0) < 1000 ? open.apply(this, args) : null;
      };
    });
  });

  afterAll(async () => {
    await runner?.close();
    h5?.close();
  });

  it('被拦截时占位里提示，点按钮后打开网页窗口', async () => {
    const frame = await runner.open(webPage(h5.origin + '/hello'));
    await expectText(frame, 'button', '在新窗口打开 H5');
    await expect(frame.locator('text=浏览器拦截了弹出窗口').count()).resolves.toBe(1);

    const popup = runner.page.waitForEvent('popup');
    await frame.click('button');
    await expect((await popup).locator('#title').textContent()).resolves.toBe('Hello H5');
  });
});
