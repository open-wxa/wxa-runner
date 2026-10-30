/**
 * fixture：web-view 的新窗口模式，和模拟器跨站的网页 Cookie 也能正常使用
 */

import http from 'http';
import { AddressInfo } from 'net';
import { expect, test } from '@open-wxa/wxa-runner-playwright';

/** 和模拟器（localhost）跨站的网页，页面上显示收到的 Cookie。/coop 开头的地址带 Cross-Origin-Opener-Policy */
let h5: http.Server;
let origin = '';

test.beforeAll(async () => {
  h5 = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8');
    if (req.url?.startsWith('/coop')) res.setHeader('cross-origin-opener-policy', 'same-origin');
    res.end(`<!doctype html><meta charset="utf-8"><h1 id="title">${req.url}</h1><p id="cookie">${req.headers.cookie ?? ''}</p>`);
  });
  await new Promise<void>(resolve => h5.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(h5.address() as AddressInfo).port}`;
});

test.afterAll(() => {
  h5.close();
});

const webViewPage = (path: string) => `pages/webview/webview?src=${encodeURIComponent(origin + path)}`;

test('默认模式下 webView() 报错，提示开启新窗口模式', async ({ miniProgram }) => {
  await miniProgram.open(webViewPage('/hello'));
  await expect(miniProgram.webView()).rejects.toThrow("wxaWebView: 'window'");
});

test.describe('新窗口模式', () => {
  test.use({ wxaWebView: 'window' });

  test('开发者用 context.addCookies 注入 SameSite=Lax 的登录态，跨站网页能收到', async ({ miniProgram, context }) => {
    await context.addCookies([{ name: 'session', value: 'x', url: origin, sameSite: 'Lax', httpOnly: true }]);
    await miniProgram.open(webViewPage('/hello'));

    const h5Page = await miniProgram.webView();
    await expect(h5Page.locator('#title')).toHaveText('/hello');
    await expect(h5Page.locator('#cookie')).toHaveText('session=x');
  });

  test('跳到下一页再返回后，webView() 拿到重新打开的网页窗口', async ({ miniProgram }) => {
    await miniProgram.open(webViewPage('/hello'));
    const first = await miniProgram.webView();

    await miniProgram.navigateTo('/pages/detail/detail?id=1');
    await expect(miniProgram.webView({ timeout: 1000 })).rejects.toThrow();

    await miniProgram.navigateBack();
    const reopened = await miniProgram.webView();
    expect(reopened).not.toBe(first);
    expect(first.isClosed()).toBe(true);
    await expect(reopened.locator('#title')).toHaveText('/hello');
  });

  test('网页设置了 Cross-Origin-Opener-Policy 时，webView() 照样拿到窗口，跳转后不留下旧窗口', async ({ miniProgram, context }) => {
    await miniProgram.open(webViewPage('/coop'));
    const first = await miniProgram.webView();
    await expect(first.locator('#title')).toHaveText('/coop');

    await miniProgram.navigateTo('/pages/detail/detail?id=1');
    await expect.poll(() => first.isClosed()).toBe(true);

    await miniProgram.navigateBack();
    const reopened = await miniProgram.webView();
    await expect(reopened.locator('#title')).toHaveText('/coop');

    await miniProgram.callPageMethod('setSrc', origin + '/coop-next');
    await expect.poll(async () => (await miniProgram.webView()).url()).toBe(origin + '/coop-next');
    // 模拟器和一个网页窗口
    await expect.poll(() => context.pages().length).toBe(2);
  });

  test('当前页 web-view 的 index 越界时立即报错', async ({ miniProgram }) => {
    await miniProgram.open(webViewPage('/hello'));
    await expect(miniProgram.webView({ index: 1 })).rejects.toThrow('index 应在 0 到 0 之间');
  });
});
