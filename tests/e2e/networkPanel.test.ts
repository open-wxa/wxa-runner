/**
 * 端到端：小程序的请求在 Network 面板里显示原地址，被拦截的请求由 Service Worker 返回拦截规则给出的响应
 *
 * 需要本机安装微信开发者工具，以及 Chrome（或通过 WXA_CHROME 指定浏览器路径）。
 */

import http from 'http';
import { AddressInfo } from 'net';
import type { Response } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eReady, Runner, startRunner } from './runner';

const APP = {
  'app.json': { pages: ['pages/index/index'] },
  'pages/index/index.json': {},
  'pages/index/index.wxml': '<view>index</view>',
  'pages/index/index.js': `
    Page({
      send(url, data) {
        return new Promise(resolve => wx.request({
          url, method: 'POST', data,
          success: res => resolve({ status: res.statusCode, data: res.data }),
          fail: err => resolve({ error: err.errMsg })
        }));
      }
    });
  `
};

describe.skipIf(!e2eReady)('Network 面板里的小程序请求', () => {
  let runner: Runner;
  let upstream: http.Server;
  let upstreamHost = '';
  const upstreamPaths: string[] = [];

  beforeAll(async () => {
    upstream = http.createServer((req, res) => {
      upstreamPaths.push(req.url!);
      res.end(JSON.stringify({ path: req.url }));
    });
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
    upstreamHost = `127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    runner = await startRunner(APP);
    // 自动化测试里默认不注册 Service Worker，这里要测它
    await runner.page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
  });

  afterAll(async () => {
    await runner?.close();
    upstream?.close();
  });

  const send = (url: string, data: object) =>
    runner.page.evaluate(([u, d]) => window.__wxa_test_api__.callPageMethod('send', u, d), [url, data] as const) as Promise<any>;

  it('经代理转发的请求显示为 /__wxa__/proxy/<协议>/<域名><路径>', async () => {
    const { page } = runner;
    await runner.open('/?path=pages/index/index');

    const response = page.waitForResponse(res => res.url().includes('/__wxa__/proxy/'));
    expect(await send(`http://${upstreamHost}/api/user?id=1`, {})).toMatchObject({ status: 200, data: { path: '/api/user?id=1' } });
    expect((await response).url()).toBe(`${runner.base}/__wxa__/proxy/http/${upstreamHost}/api/user?id=1`);
  });

  it('被拦截的请求显示为 /__wxa__/mock/…，带着原请求的请求体，响应是拦截规则给出的', async () => {
    const { page } = runner;
    await runner.open('/?path=pages/index/index');
    // 第一次打开时 Service Worker 装好后接管页面，之后的请求才会显示
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    await page.evaluate(() => window.__wxa_test_api__.route('POST **/api/order', { status: 201, body: { ok: true } }));

    const response: Promise<Response> = page.waitForResponse(res => res.url().includes('/__wxa__/mock/'));
    expect(await send('https://api.example.com/api/order?id=1', { sku: 'A1' })).toEqual({ status: 201, data: { ok: true } });

    const shown = await response;
    expect(shown.url()).toBe(`${runner.base}/__wxa__/mock/https/api.example.com/api/order?id=1`);
    expect(shown.fromServiceWorker()).toBe(true);
    expect(shown.status()).toBe(201);
    expect(await shown.json()).toEqual({ ok: true });
    expect(shown.request().method()).toBe('POST');
    expect(shown.request().postData()).toBe('{"sku":"A1"}');
  });

  it('拦截规则返回重定向时只显示这个响应，不按 Location 发出真实请求', async () => {
    const { page } = runner;
    await runner.open('/?path=pages/index/index');
    await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
    const location = `http://${upstreamHost}/followed`;
    await page.evaluate(l => window.__wxa_test_api__.route('POST **/api/old', { status: 302, header: { Location: l } }), location);

    const response = page.waitForResponse(res => res.url().includes('/__wxa__/mock/'));
    expect(await send('https://api.example.com/api/old', {})).toMatchObject({ status: 302 });
    expect((await response).status()).toBe(302);
    // 跟随的话请求会在显示用的响应之后马上发出，多等一会儿再确认
    await page.waitForTimeout(300);
    expect(upstreamPaths).not.toContain('/followed');
  });
});
