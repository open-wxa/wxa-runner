/**
 * 转发 wx.request 的请求处理函数（打包为 dist/proxy.mjs，wxa-runner viewer export 一并导出）
 *
 * 只用标准 Fetch API，接到任何能处理 Request → Response 的平台上都行：把 /__wxa__/proxy/ 开头的请求交给它，
 * 其余请求交给静态站点。只转发到白名单里的域名：不设限的话，任何人都能把部署出去的查看器当成代理用。
 */

import { PROXY_PREFIX, proxyFetch } from '@open-wxa/wxa-runner-core/web';

/** 需要交给代理的请求路径前缀 */
export const PROXY_PATH = PROXY_PREFIX;

export interface ProxyHandlerOptions {
  /** 允许转发的域名，数组或逗号分隔的字符串；*.example.com 匹配所有子域名，但不匹配 example.com 本身。空时拒绝全部 */
  allowedHosts: string[] | string;
}

/** host 是否在白名单里，大小写不敏感 */
export function isAllowedHost(host: string, allowedHosts: string[] | string): boolean {
  const hostname = host.toLowerCase();
  return toPatterns(allowedHosts).some(pattern => {
    if (!pattern.startsWith('*.')) return hostname === pattern;
    const suffix = pattern.slice(1);
    return suffix.length > 1 && hostname.length > suffix.length && hostname.endsWith(suffix);
  });
}

/**
 * 创建转发处理函数。传进来的请求路径要以 PROXY_PATH 开头，不是时返回 404；
 * 白名单为空时一律返回 403，并说明怎么配置
 */
export function createProxyHandler(options: ProxyHandlerOptions): (request: Request) => Promise<Response> {
  const patterns = toPatterns(options.allowedHosts);
  return async request => {
    if (!new URL(request.url).pathname.startsWith(PROXY_PATH)) {
      return new Response(`not a proxy request, expected a path starting with ${PROXY_PATH}`, { status: 404, headers: { 'x-wxa-proxy-error': '1' } });
    }
    if (!patterns.length) {
      return new Response('Proxy denied: allowedHosts is empty. Pass the API hostnames to createProxyHandler, for example ["api.example.com", "*.example.com"].', {
        status: 403,
        headers: { 'x-wxa-proxy-error': '1' }
      });
    }
    return proxyFetch(request, { isAllowed: url => isAllowedHost(url.hostname, patterns) });
  };
}

/** 去掉空项和 *：* 等于不设白名单，不允许 */
function toPatterns(allowedHosts: string[] | string): string[] {
  const list = typeof allowedHosts === 'string' ? allowedHosts.split(',') : allowedHosts;
  return list.map(entry => entry.trim().toLowerCase()).filter(entry => entry && entry !== '*');
}
