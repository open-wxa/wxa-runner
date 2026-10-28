/** 查看器的 Service Worker（打包为 /__wxa__/runtime/pack-sw.js）：包和 setup 来自 IndexedDB，页面、文件与镜像响应在本地生成。 */

import { createPackRequestContext, handlePackRequest, isPackNetworkRequest } from './packRoutes';
import { mockedResponse } from '@open-wxa/wxa-runner-core/web';
import type { MockClient } from '@open-wxa/wxa-runner-core/web';

// tsconfig 使用 DOM 类型，这里只声明本 Worker 需要的接口。
interface ExtendableEvent extends Event {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEvent extends ExtendableEvent {
  request: Request;
  clientId: string;
  respondWith(response: Promise<Response>): void;
}
interface WorkerScope {
  location: { origin: string };
  registration: { unregister(): Promise<boolean> };
  skipWaiting(): Promise<void>;
  clients: {
    claim(): Promise<void>;
    get(id: string): Promise<MockClient | undefined>;
  };
  addEventListener(type: 'install', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'activate', listener: (event: ExtendableEvent) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEvent) => void): void;
}

const scope = self as unknown as WorkerScope;
const context = createPackRequestContext({
  origin: scope.location.origin,
  onNotViewer: () => void scope.registration.unregister(),
  mockResponse: async (clientId, id) => mockedResponse(await scope.clients.get(clientId), id)
});

scope.addEventListener('install', event => event.waitUntil(scope.skipWaiting()));
scope.addEventListener('activate', event => event.waitUntil(scope.clients.claim()));
scope.addEventListener('fetch', event => {
  if (isPackNetworkRequest(event.request, context.origin)) return;
  event.respondWith(handlePackRequest(event.request, context, event.clientId).then(response => response ?? fetch(event.request)));
});
