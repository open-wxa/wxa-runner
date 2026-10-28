/**
 * 网络代理：浏览器端的 wx.request 经由这里转发到真实服务器
 *
 * - 原地址写在路径里：/__wxa__/proxy/https/api.example.com/a?b=1（见 networkPanel.ts）
 * - 绕开 CORS
 * - 小程序设置的请求头放在 x-wxa-headers（JSON）里传过来，
 *   这样 cookie / referer / user-agent 等浏览器禁止设置的头也能带上
 * - 响应头和 set-cookie 以 URL 编码的 JSON 返回，浏览器端可以完整读取
 */

import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { fromServerPath, PROXY_PREFIX } from '../runtime/networkPanel';

// fetch 不允许或无意义的请求头
const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect']);
// 响应体已被解压/重新分块，这些头不再成立
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie']);

/**
 * 用 app.use 挂在 PROXY_PREFIX 下。原地址从未解码的 originalUrl 取：解码后路径里的 %2F 等会变成别的地址。
 * 不能用 app.all('/__wxa__/proxy/*')：Express 会先解码 * 匹配的部分，地址里有单独的 %（如 /discount/50%）时直接报错
 */
export async function handleProxy(req: Request, res: Response) {
  const target = fromServerPath(PROXY_PREFIX, req.originalUrl);
  if (!target) {
    sendProxyError(res, 400, `invalid url "${req.originalUrl}"`);
    return;
  }

  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);

  try {
    let upstream: globalThis.Response;
    try {
      upstream = await fetch(target, {
        method: req.method,
        headers: forwardedRequestHeaders(req.get('x-wxa-headers'), req.get('content-type')),
        body: requestBody(req),
        redirect: 'follow',
        signal: controller.signal
      });
    } catch (error) {
      if (res.destroyed || controller.signal.aborted) return;
      sendProxyError(res, 502, fetchErrorMessage(error));
      return;
    }
    await relayResponse(upstream, res);
  } catch (error) {
    // 响应头已经发出，流中断时关闭连接，让客户端收到失败，而不是补发一个 502。
    if (!res.destroyed) res.destroy(error as Error);
  } finally {
    res.off('close', cancel);
  }
}

function requestBody(req: Request): BodyInit | undefined {
  const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
  return hasBody ? req.body : undefined;
}

/** fetch 连不上时 message 只有 "fetch failed"，具体原因（ECONNREFUSED 等）在 cause 里 */
function fetchErrorMessage(error: unknown): string {
  return (error as any)?.cause?.message || (error as Error).message;
}

function sendProxyError(res: Response, status: number, message: string) {
  res.status(status).set('x-wxa-proxy-error', '1').send(message);
}

/**
 * 小程序设置的请求头，去掉 fetch 不允许或无意义的。上传文件时 multipart 的 boundary 只有浏览器生成的
 * content-type 里才有，所以这时 content-type 用浏览器的
 */
function forwardedRequestHeaders(encoded: string | undefined, browserContentType = ''): Record<string, string> {
  const multipart = browserContentType.startsWith('multipart/form-data');
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(parseHeaders(encoded))) {
    const name = key.toLowerCase();
    if (DROPPED_REQUEST_HEADERS.has(name) || (multipart && name === 'content-type') || value === undefined || value === null) continue;
    headers[key] = String(value);
  }
  if (multipart) headers['content-type'] = browserContentType;
  return headers;
}

/** 头格式错误时按无自定义头处理 */
function parseHeaders(encoded = '{}'): Record<string, unknown> {
  try {
    return JSON.parse(encoded);
  } catch {
    return {};
  }
}

/** 照搬状态码和响应头，另把全部响应头和 set-cookie 编码进 x-wxa-headers / x-wxa-set-cookie，再流式转发响应体 */
async function relayResponse(upstream: globalThis.Response, res: Response) {
  const responseHeaders: Record<string, string> = {};
  upstream.headers.forEach((value, key) => {
    responseHeaders[key] = value;
    if (!DROPPED_RESPONSE_HEADERS.has(key)) res.setHeader(key, value);
  });
  res.status(upstream.status);
  res.setHeader('x-wxa-headers', encodeURIComponent(JSON.stringify(responseHeaders)));
  const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  res.setHeader('x-wxa-set-cookie', encodeURIComponent(JSON.stringify(setCookies)));
  // 不等响应结束：长连接的响应头和数据块要立即到达浏览器。
  res.flushHeaders();
  if (!upstream.body) {
    res.end();
    return;
  }
  await pipeline(Readable.fromWeb(upstream.body as ReadableStream), res);
}
