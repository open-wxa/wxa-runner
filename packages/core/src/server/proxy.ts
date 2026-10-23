/**
 * 网络代理：浏览器端的 wx.request 经由这里转发到真实服务器
 *
 * - 绕开 CORS
 * - 小程序设置的请求头放在 x-wxa-headers（JSON）里传过来，
 *   这样 cookie / referer / user-agent 等浏览器禁止设置的头也能带上
 * - 响应头和 set-cookie 以 URL 编码的 JSON 返回，浏览器端可以完整读取
 */

import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';

// fetch 不允许或无意义的请求头
const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect']);
// 响应体已被解压/重新分块，这些头不再成立
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie']);

export async function handleProxy(req: Request, res: Response) {
  const target = String(req.query.url || '');
  if (!/^https?:\/\//i.test(target)) {
    res.status(400).set('x-wxa-proxy-error', '1').send(`invalid url "${target}"`);
    return;
  }

  let requestHeaders: Record<string, string> = {};
  try {
    requestHeaders = JSON.parse(req.get('x-wxa-headers') || '{}');
  } catch {
    // 头格式错误时按无自定义头处理
  }
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(requestHeaders)) {
    if (!DROPPED_REQUEST_HEADERS.has(key.toLowerCase()) && value !== undefined && value !== null) {
      headers[key] = String(value);
    }
  }
  // 上传文件时 multipart 的 boundary 只有浏览器生成的 content-type 里才有
  const browserContentType = req.get('content-type') || '';
  if (browserContentType.startsWith('multipart/form-data')) {
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === 'content-type') delete headers[key];
    }
    headers['content-type'] = browserContentType;
  }

  const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;

  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);

  try {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers,
        body: hasBody ? req.body : undefined,
        redirect: 'follow',
        signal: controller.signal
      });
    } catch (error) {
      if (res.destroyed || controller.signal.aborted) return;
      const cause = (error as any)?.cause?.message;
      res.status(502).set('x-wxa-proxy-error', '1').send(cause || (error as Error).message);
      return;
    }

    const responseHeaders: Record<string, string> = {};
    upstream.headers.forEach((value, key) => {
      responseHeaders[key] = value;
    });
    const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];

    res.status(upstream.status);
    upstream.headers.forEach((value, key) => {
      if (!DROPPED_RESPONSE_HEADERS.has(key)) res.setHeader(key, value);
    });
    res.setHeader('x-wxa-headers', encodeURIComponent(JSON.stringify(responseHeaders)));
    res.setHeader('x-wxa-set-cookie', encodeURIComponent(JSON.stringify(setCookies)));
    // 不等响应结束：长连接的响应头和数据块要立即到达浏览器。
    res.flushHeaders();
    if (!upstream.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(upstream.body as ReadableStream), res);
  } catch (error) {
    // 响应头已经发出，流中断时关闭连接，让客户端收到失败，而不是补发一个 502。
    if (!res.destroyed) res.destroy(error as Error);
  } finally {
    res.off('close', cancel);
  }
}
