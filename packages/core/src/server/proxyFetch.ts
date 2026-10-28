/**
 * 网络代理：浏览器端的 wx.request 经由这里转发到真实服务器
 *
 * - 原地址写在路径里：/__wxa__/proxy/https/api.example.com/a?b=1（见 networkPanel.ts）
 * - 绕开 CORS
 * - 小程序设置的请求头放在 x-wxa-headers（JSON）里传过来，
 *   这样 cookie / referer / user-agent 等浏览器禁止设置的头也能带上
 * - 响应头和 set-cookie 以 URL 编码的 JSON 返回，浏览器端可以完整读取
 *
 * 只用标准 Fetch API：开发服务器（proxy.ts）和其他支持 Fetch API 的运行时共用。
 */

import { fromServerPath, PROXY_PREFIX } from '../runtime/networkPanel';

// fetch 不允许或无意义的请求头
const DROPPED_REQUEST_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'expect']);
// 响应体已被解压/重新分块，这些头不再成立
const DROPPED_RESPONSE_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'connection', 'set-cookie']);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export async function proxyFetch(
  request: Request,
  options: { fetch?: typeof fetch; isAllowed?: (url: URL) => boolean } = {}
): Promise<Response> {
  const url = new URL(request.url);
  // pathname 保留 %2F 等编码，解码会改变上游地址。
  const path = url.pathname + url.search;
  const target = fromServerPath(PROXY_PREFIX, path);
  if (!target) return proxyError(400, `invalid url "${path}"`);

  try {
    let current = new URL(target);
    if (options.isAllowed && !options.isAllowed(current)) return forbiddenHost(current, 0);
    const headers = new Headers(
      forwardedRequestHeaders(request.headers.get('x-wxa-headers') ?? undefined, request.headers.get('content-type') ?? '')
    );
    let method = request.method;
    // 手动重定向时 307/308 需要重发同一个请求体；响应体始终直接透传。
    let body = request.body && !['GET', 'HEAD'].includes(method) ? await request.arrayBuffer() : undefined;
    const send = options.fetch ?? fetch;
    let upstream: Response;
    for (let hop = 0; ; hop++) {
      upstream = await send(current.href, {
        method,
        headers,
        body,
        redirect: options.isAllowed ? 'manual' : 'follow',
        signal: request.signal
      });
      const location = upstream.headers.get('location');
      if (!options.isAllowed || !REDIRECT_STATUSES.has(upstream.status) || location === null) break;
      await upstream.body?.cancel();
      const next = new URL(location, current);
      if (hop >= 20) return proxyError(403, `host "${next.hostname}": redirect hop ${hop + 1} exceeds limit 20`);
      if (!['http:', 'https:'].includes(next.protocol) || !options.isAllowed(next)) return forbiddenHost(next, hop + 1);
      if (
        (upstream.status === 303 && method !== 'GET' && method !== 'HEAD') ||
        ((upstream.status === 301 || upstream.status === 302) && method === 'POST')
      ) {
        method = 'GET';
        body = undefined;
        for (const name of ['content-type', 'content-encoding', 'content-language', 'content-location']) headers.delete(name);
      }
      // 跨源跳转不能把原站点凭据交给另一个白名单域名。
      if (next.origin !== current.origin) {
        for (const name of ['authorization', 'proxy-authorization', 'cookie']) headers.delete(name);
      }
      current = next;
    }
    return relayResponse(upstream);
  } catch (error) {
    return proxyError(502, fetchErrorMessage(error));
  }
}

function forbiddenHost(url: URL, hop: number): Response {
  return proxyError(403, `host "${url.hostname}" is not in the allowlist (redirect hop ${hop})`);
}

function proxyError(status: number, message: string): Response {
  return new Response(message, { status, headers: { 'x-wxa-proxy-error': '1', 'content-type': 'text/html; charset=utf-8' } });
}

/** fetch 连不上时 message 只有 "fetch failed"，具体原因（ECONNREFUSED 等）在 cause 里 */
function fetchErrorMessage(error: unknown): string {
  const detail = error as { cause?: { message?: string }; message?: string } | null;
  return detail?.cause?.message || detail?.message || String(error);
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
    const parsed = JSON.parse(encoded);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function relayResponse(upstream: Response): Response {
  const responseHeaders: Record<string, string> = {};
  const headers = new Headers();
  upstream.headers.forEach((value, key) => {
    responseHeaders[key] = value;
    if (!DROPPED_RESPONSE_HEADERS.has(key)) headers.set(key, value);
  });
  headers.set('x-wxa-headers', encodeURIComponent(JSON.stringify(responseHeaders)));
  const setCookies = typeof upstream.headers.getSetCookie === 'function' ? upstream.headers.getSetCookie() : [];
  headers.set('x-wxa-set-cookie', encodeURIComponent(JSON.stringify(setCookies)));
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers });
}
