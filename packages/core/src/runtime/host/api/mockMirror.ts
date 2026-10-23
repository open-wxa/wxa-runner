/**
 * 让被拦截的 wx.request 出现在 Network 面板里，显示为 /__wxa__/mock/https/api.example.com/…
 *
 * 照原请求发一个同源 fetch，Service Worker（runtime/sw.ts）拦下后向这里要拦截规则给出的响应。
 * 只用于显示：小程序拿到的结果不经过这里。Service Worker 没有接管页面时不显示，请求照常完成，比如
 * 首次打开时还没装好、强制刷新（Shift+Reload）、局域网地址不是安全上下文。
 *
 * 用同源地址而不是原地址：Service Worker 没拦下时（DevTools 勾选了 Bypass for network）只会打到开发服务器，
 * 不会把本该拦截的请求发到真实后端。
 */

import type { MockRequest } from '../../../setup';
import { MOCK_ID_HEADER, MOCK_PREFIX, MockQuery, MockReply, toHeaders, toServerPath } from '../../networkPanel';
import { hasRequestBody } from './network';
import type { MockedResponse } from './routes';

const SERVICE_WORKER_URL = '/__wxa__/runtime/sw.js';

export class MockMirror {
  /** 正在显示的请求，Service Worker 按 id 来要响应 */
  private readonly replies = new Map<string, Promise<MockReply>>();
  private seq = 0;

  constructor(private readonly serviceWorker: ServiceWorkerContainer) {
    serviceWorker.addEventListener('message', event => this.answer(event));
    // 不调用的话，Service Worker 发来的消息要等页面加载完才派发
    serviceWorker.startMessages();
  }

  /** response 失败（规则出错、请求被取消）时这一行显示为失败；signal abort 时显示为取消 */
  show(request: MockRequest, response: Promise<MockedResponse>, signal: AbortSignal) {
    const path = toServerPath(MOCK_PREFIX, request.url);
    if (!path || !this.serviceWorker.controller) return;

    const id = String(++this.seq);
    // 取消、超时时马上回复，Service Worker 不用一直等着可能不再返回的拦截规则
    const cancelled = new Promise<null>(resolve => signal.addEventListener('abort', () => resolve(null), { once: true }));
    this.replies.set(id, Promise.race([response.catch(() => null), cancelled]));
    const headers = toHeaders(request.header);
    headers.set(MOCK_ID_HEADER, id);
    fetch(path, {
      method: request.method,
      headers,
      body: hasRequestBody(request.method, request.data) ? (request.data as BodyInit) : undefined,
      // 拦截规则给出 3xx 时只显示这个响应：跟随 Location 会真的发出请求，小程序那边也不跟随
      redirect: 'manual',
      signal
    })
      // 失败只影响显示，比如 TRACE 等浏览器不允许发的方法
      .catch(() => undefined)
      .finally(() => this.replies.delete(id));
  }

  private answer(event: MessageEvent) {
    const query = event.data as MockQuery | undefined;
    const port = event.ports[0];
    if (query?.type !== 'wxa-mock-response' || !port) return;
    // 不认识的 id：请求在 Service Worker 来要响应之前已经结束
    (this.replies.get(query.id) ?? Promise.resolve(null)).then(reply => port.postMessage(reply));
  }
}

/**
 * 注册 Service Worker，不等它装好；用不了时返回 null
 *
 * 自动化测试里不注册：测试不看 Network 面板，Service Worker 还会让 Playwright 的 page.route 拦不到经过它的请求
 */
export function installMockMirror(): MockMirror | null {
  // 不是安全上下文（如局域网 IP 访问）时没有 navigator.serviceWorker
  if (navigator.webdriver || !navigator.serviceWorker) return null;
  navigator.serviceWorker
    .register(SERVICE_WORKER_URL, { scope: '/' })
    .catch(error => console.warn('[wxa-runner] Service Worker 注册失败，被拦截的请求不会显示在 Network 面板里', error));
  return new MockMirror(navigator.serviceWorker);
}
