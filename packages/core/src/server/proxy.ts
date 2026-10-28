/**
 * 开发服务器和本机查看器的网络代理：把 express 的请求转成 Fetch 请求交给 proxyFetch.ts，再把响应流式写回
 */

import type { Request, Response } from 'express';
import { Readable } from 'node:stream';
import type { ReadableStream } from 'node:stream/web';
import { pipeline } from 'node:stream/promises';
import { proxyFetch } from './proxyFetch';

/**
 * 用 app.use 挂载，保留未解码的 originalUrl：Express 通配路由会解码 %2F，甚至拒绝单独的 %。
 */
export async function handleProxy(req: Request, res: Response) {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  res.once('close', cancel);

  try {
    const headers = new Headers();
    for (const name of ['x-wxa-headers', 'content-type']) {
      const value = req.get(name);
      if (value !== undefined) headers.set(name, value);
    }
    const hasBody = !['GET', 'HEAD'].includes(req.method) && Buffer.isBuffer(req.body) && req.body.length > 0;
    const request = new globalThis.Request(`http://localhost${req.originalUrl}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      signal: controller.signal
    });
    const response = await proxyFetch(request);
    if (res.destroyed || controller.signal.aborted) {
      await response.body?.cancel();
      return;
    }
    response.headers.forEach((value, name) => res.setHeader(name, value));
    res.status(response.status);
    // 不等响应结束：长连接的响应头和数据块要立即到达浏览器。
    res.flushHeaders();
    if (!response.body) {
      res.end();
      return;
    }
    await pipeline(Readable.fromWeb(response.body as ReadableStream), res);
  } catch (error) {
    // 响应头已经发出，流中断时关闭连接，让客户端收到失败，而不是补发一个 502。
    if (!res.destroyed) res.destroy(error as Error);
  } finally {
    res.off('close', cancel);
  }
}
