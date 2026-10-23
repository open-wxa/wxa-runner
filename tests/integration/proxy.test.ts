import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PROXY_PREFIX, toServerPath } from '../../packages/core/src/runtime/networkPanel';
import { handleProxy } from '../../packages/core/src/server/proxy';

let upstream: http.Server;
let proxy: http.Server;
let upstreamUrl = '';
let proxyOrigin = '';

/** 浏览器端实际请求的代理地址 */
const proxied = (url: string) => proxyOrigin + toServerPath(PROXY_PREFIX, url);

beforeAll(async () => {
  upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => (body += chunk));
    req.on('end', () => {
      res.setHeader('Set-Cookie', ['sid=abc; Path=/', 'theme=dark']);
      res.setHeader('X-Upstream', 'v=1; "quoted", list');
      res.setHeader('Content-Type', 'application/json');
      res.statusCode = req.url === '/missing' ? 404 : 200;
      res.end(JSON.stringify({ method: req.method, path: req.url, cookie: req.headers.cookie, custom: req.headers['x-custom'], body }));
    });
  });
  await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', () => resolve()));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const app = express();
  app.use(PROXY_PREFIX, express.raw({ type: () => true }), handleProxy);
  proxy = app.listen(0, '127.0.0.1');
  await new Promise(resolve => proxy.once('listening', resolve));
  proxyOrigin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
});

afterAll(() => {
  upstream.close();
  proxy.close();
});

describe('网络代理', () => {
  it('转发方法、请求体和浏览器无法直接设置的请求头', async () => {
    const res = await fetch(proxied(upstreamUrl + '/echo'), {
      method: 'POST',
      headers: { 'x-wxa-headers': JSON.stringify({ cookie: 'token=1', 'X-Custom': 'yes' }) },
      body: 'payload'
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ method: 'POST', path: '/echo', cookie: 'token=1', custom: 'yes', body: 'payload' });
  });

  it('响应头和 set-cookie 以编码后的 JSON 返回给浏览器', async () => {
    const res = await fetch(proxied(upstreamUrl));
    const headers = JSON.parse(decodeURIComponent(res.headers.get('x-wxa-headers')!));
    expect(headers['x-upstream']).toBe('v=1; "quoted", list');
    expect(JSON.parse(decodeURIComponent(res.headers.get('x-wxa-set-cookie')!))).toEqual(['sid=abc; Path=/', 'theme=dark']);
  });

  it('原地址的路径和查询参数原样转发，编码过的字符不被解码', async () => {
    const res = await fetch(proxied(upstreamUrl + '/files/a%2Fb/c d?q=%E4%B8%AD&x=1'));
    expect((await res.json()).path).toBe('/files/a%2Fb/c%20d?q=%E4%B8%AD&x=1');
  });

  it('路径里有单独的 % 或非 UTF-8 编码时照样转发', async () => {
    for (const path of ['/discount/50%', '/gbk/%C4%E3']) {
      const res = await fetch(proxied(upstreamUrl + path));
      expect(res.status, path).toBe(200);
      expect((await res.json()).path, path).toBe(path);
    }
  });

  it('保留上游的状态码', async () => {
    const res = await fetch(proxied(upstreamUrl + '/missing'));
    expect(res.status).toBe(404);
  });

  it('非法地址和连接失败时标记为代理错误', async () => {
    for (const path of ['ftp/x', 'https/api.example.com:badport/a']) {
      const invalid = await fetch(`${proxyOrigin}${PROXY_PREFIX}${path}`);
      expect(invalid.status, path).toBe(400);
      expect(invalid.headers.get('x-wxa-proxy-error'), path).toBe('1');
    }

    const unreachable = await fetch(proxied('http://127.0.0.1:1/'));
    expect(unreachable.status).toBe(502);
    expect(unreachable.headers.get('x-wxa-proxy-error')).toBe('1');
  });
});
