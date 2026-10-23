/**
 * 小程序的请求在浏览器 Network 面板里的样子，宿主、Service Worker 和开发服务器共用
 *
 * 原地址放在路径里：/__wxa__/proxy/https/api.example.com/user/info?id=1。Name 列显示接口名（info?id=1），
 * 按域名、路径过滤也直接可用；放在查询参数里时每一行都是 proxy?url=https%3A%2F%2F…，分不出是哪个接口。
 *
 * - 经开发服务器转发的请求：/__wxa__/proxy/…
 * - 被拦截规则拦下的请求：/__wxa__/mock/…，由 Service Worker 返回规则给出的响应，只用于显示（见 sw.ts）
 */

import type { MockedResponse } from './host/api/routes';

export const PROXY_PREFIX = '/__wxa__/proxy/';
export const MOCK_PREFIX = '/__wxa__/mock/';

/** 显示被拦截请求的 fetch 带上这个头，Service Worker 凭它向宿主要对应的响应 */
export const MOCK_ID_HEADER = 'x-wxa-mock-id';

/** Service Worker 向宿主要响应时发的消息，附带一个 MessagePort，宿主从这个端口回复 MockReply */
export interface MockQuery {
  type: 'wxa-mock-response';
  id: string;
}

/** 请求被取消、拦截规则出错，或宿主已经不认识这个 id 时为 null，Network 面板里显示为失败 */
export type MockReply = MockedResponse | null;

/**
 * 原地址在开发服务器上对应的路径，prefix 是 PROXY_PREFIX 或 MOCK_PREFIX。不是 http(s) 地址时返回 null
 *
 * 先按 URL 规范化：路径里的 .. 要在拼接前解析掉，否则浏览器会在代理路径上解析，把域名那一段也吃掉
 */
export function toServerPath(prefix: string, url: string): string | null {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return null;
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:') return null;
  return `${prefix}${target.protocol.slice(0, -1)}/${target.host}${target.pathname}${target.search}`;
}

/**
 * toServerPath 的逆运算，格式不对或还原出的地址不合法时返回 null
 *
 * 只校验不规范化，返回拼出的原样字符串：路径里的 %2F 等编码要原样转发
 */
export function fromServerPath(prefix: string, serverPath: string): string | null {
  if (!serverPath.startsWith(prefix)) return null;
  const match = /^(https?)\/([^/?#]+)(.*)$/.exec(serverPath.slice(prefix.length));
  if (!match) return null;
  const url = `${match[1]}://${match[2]}${match[3]}`;
  try {
    new URL(url);
    return url;
  } catch {
    return null;
  }
}

/**
 * 用于显示的请求、响应头。浏览器不允许设置的（cookie、set-cookie 等）会被忽略，
 * 名字或值不合法的（如值里有中文）跳过：它们只影响 Network 面板里的显示，小程序拿到的头不受影响。
 * 值为 undefined、null 的和代理一样不发
 */
export function toHeaders(header: Record<string, unknown>): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(header)) {
    if (value === undefined || value === null) continue;
    try {
      headers.set(name, String(value));
    } catch {
      // 跳过
    }
  }
  return headers;
}
