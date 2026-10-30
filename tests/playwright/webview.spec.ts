/**
 * fixture：给 web-view 的首次请求注入 Cookie
 */

import http from 'http';
import { AddressInfo } from 'net';
import { expect, test } from '@open-wxa/wxa-runner-playwright';

let upstream: http.Server;
let upstreamUrl = '';
const receivedCookies: string[] = [];

test.beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    receivedCookies.push(req.headers.cookie || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><meta charset="utf-8"><p id="cookie">${req.headers.cookie || ''}</p>`);
  });
  await new Promise<void>(resolve => upstream.listen(0, 'localhost', () => resolve()));
  upstreamUrl = `http://localhost:${(upstream.address() as AddressInfo).port}`;
});

test.afterAll(() => {
  upstream?.close();
});

test('web-view 首次请求带上注入的 httpOnly Cookie', async ({ miniProgram }) => {
  await miniProgram.setWebViewCookies([{ name: 'session', value: 'from-playwright', url: upstreamUrl, httpOnly: true, sameSite: 'Lax' }]);
  await miniProgram.open(`pages/webview/webview?src=${encodeURIComponent(`${upstreamUrl}/cookie`)}`);

  const webview = miniProgram.current.frameLocator('iframe');
  await expect(webview.locator('#cookie')).toHaveText('session=from-playwright');
  expect(receivedCookies).toContain('session=from-playwright');
});
