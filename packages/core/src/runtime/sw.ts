/**
 * Service Worker（打包为 /__wxa__/runtime/sw.js）：让被拦截的 wx.request 也出现在 Network 面板里
 *
 * 宿主照原请求向 /__wxa__/mock/… 发一个带 x-wxa-mock-id 头的 fetch（见 host/mockMirror.ts），
 * 这里拦下它，向发出请求的页面要拦截规则给出的响应。其余请求一律不处理，照常走网络。
 */

import { MOCK_ID_HEADER, MOCK_PREFIX } from './networkPanel';
import { mockedResponse } from './mockResponse';
import type { MockClient } from './mockResponse';

// tsconfig 只带 DOM 的类型，这里只声明用到的 Service Worker 接口
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface InstallEvent extends ExtendableEvent {
  /** Static Routing API，Chrome 123 起支持 */
  addRoutes?(rules: object[]): Promise<void>;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  clientId: string;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    get(id: string): Promise<MockClient | undefined>;
  };
  addEventListener(type: 'install', listener: (event: InstallEvent) => void): void;
  addEventListener(type: 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

const scope = self as unknown as WorkerScope;

const URLPatternClass = (globalThis as { URLPattern?: new (init: { pathname: string }) => object }).URLPattern;

scope.addEventListener('install', event => {
  // 新版本装好后立即接替旧版本，不用等所有标签页关闭
  scope.skipWaiting();
  // 其余请求不唤起 Service Worker，直接走网络。不支持的浏览器里照样能用，只是每个请求都先经过 fetch 事件
  if (!event.addRoutes || !URLPatternClass) return;
  const others = { not: { urlPattern: new URLPatternClass({ pathname: `${MOCK_PREFIX}*` }) } };
  try {
    event.waitUntil(event.addRoutes([{ condition: others, source: 'network' }]).catch(() => undefined));
  } catch {
    // 早期版本不支持 not 条件，同上
  }
});

// 第一次打开页面时就接管它，不用刷新
scope.addEventListener('activate', event => event.waitUntil(scope.clients.claim()));

scope.addEventListener('fetch', event => {
  const id = event.request.headers.get(MOCK_ID_HEADER);
  if (!id || !new URL(event.request.url).pathname.startsWith(MOCK_PREFIX)) return;
  event.respondWith(scope.clients.get(event.clientId).then(client => mockedResponse(client, id)));
});
