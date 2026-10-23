/**
 * 被拦截的 wx.request 在 Network 面板里显示为 /__wxa__/mock/…：宿主一侧发出显示用的请求、回复 Service Worker
 *
 * Service Worker 本身在 e2e（tests/e2e/networkPanel.test.ts）里用真实的 Chrome 测
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { MockMirror } from '../../packages/core/src/runtime/host/api/mockMirror';
import { createNetworkApis } from '../../packages/core/src/runtime/host/api/network';
import { MockedResponse, RequestRoutes } from '../../packages/core/src/runtime/host/api/routes';
import { MOCK_ID_HEADER, MockReply } from '../../packages/core/src/runtime/networkPanel';

/** 页面里的 navigator.serviceWorker：controller 为 null 表示 Service Worker 没有接管页面 */
class FakeServiceWorkerContainer extends EventTarget {
  constructor(public controller: object | null = {}) {
    super();
  }

  startMessages() {}
}

/** 像 Service Worker 一样，带着 MessagePort 向页面要某个 id 的响应 */
function askForReply(container: FakeServiceWorkerContainer, id: string): Promise<MockReply> {
  const channel = new MessageChannel();
  const reply = new Promise<MockReply>(resolve => {
    channel.port1.onmessage = event => {
      channel.port1.close();
      resolve(event.data);
    };
  });
  container.dispatchEvent(new MessageEvent('message', { data: { type: 'wxa-mock-response', id }, ports: [channel.port2] }));
  return reply;
}

/** 显示用的请求带的 id，Service Worker 凭它来要响应 */
const shownId = (fetchMock: ReturnType<typeof setup>['fetchMock'], index = 0) =>
  (fetchMock.mock.calls[index][1] as RequestInit & { headers: Headers }).headers.get(MOCK_ID_HEADER)!;

/** 默认让显示用的请求一直挂着，就像在等 Service Worker 给出响应 */
function setup(controller: object | null = {}, displayed: () => Promise<Response> = () => new Promise(() => undefined)) {
  const container = new FakeServiceWorkerContainer(controller);
  const mirror = new MockMirror(container as unknown as ServiceWorkerContainer);
  const fetchMock = vi.fn((..._args: unknown[]) => displayed());
  vi.stubGlobal('fetch', fetchMock);
  return { container, mirror, fetchMock };
}

const request = {
  url: 'https://api.example.com/api/order?id=1',
  method: 'POST',
  header: { 'content-type': 'application/json' },
  data: '{"sku":"A1"}'
};
const mocked: MockedResponse = { statusCode: 201, header: { 'content-type': 'application/json' }, body: '{"ok":true}' };

describe('在 Network 面板里显示被拦截的请求', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('照原请求的方法、请求头和请求体发往 /__wxa__/mock/，Service Worker 来要时拿到拦截规则给出的响应', async () => {
    const { container, mirror, fetchMock } = setup();
    mirror.show(request, Promise.resolve(mocked), new AbortController().signal);

    const [path, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(path).toBe('/__wxa__/mock/https/api.example.com/api/order?id=1');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{"sku":"A1"}');
    expect((init.headers as Headers).get('content-type')).toBe('application/json');

    expect(await askForReply(container, shownId(fetchMock))).toEqual(mocked);
  });

  it('响应还没生成时，Service Worker 等到拦截规则给出响应', async () => {
    const { container, mirror, fetchMock } = setup();
    let respond!: (response: MockedResponse) => void;
    mirror.show(request, new Promise(resolve => (respond = resolve)), new AbortController().signal);

    const reply = askForReply(container, shownId(fetchMock));
    respond(mocked);
    expect(await reply).toEqual(mocked);
  });

  it('拦截规则出错时回复 null，这一行显示为失败；不认识的 id 同样回复 null', async () => {
    const { container, mirror, fetchMock } = setup();
    mirror.show(request, Promise.reject(new Error('规则出错')), new AbortController().signal);

    expect(await askForReply(container, shownId(fetchMock))).toBeNull();
    expect(await askForReply(container, 'unknown')).toBeNull();
  });

  it('请求取消或超时后，Service Worker 马上拿到 null，不用等可能不再返回的拦截规则', async () => {
    const { container, mirror, fetchMock } = setup();
    const controller = new AbortController();
    mirror.show(request, new Promise(() => undefined), controller.signal);

    controller.abort();
    expect(await askForReply(container, shownId(fetchMock))).toBeNull();
  });

  it('显示用的请求结束后不再保留它的响应，Service Worker 再来要时拿到 null', async () => {
    const { container, mirror, fetchMock } = setup({}, async () => new Response('{"ok":true}'));
    mirror.show(request, Promise.resolve(mocked), new AbortController().signal);

    await new Promise(resolve => setTimeout(resolve, 0));
    expect(await askForReply(container, shownId(fetchMock))).toBeNull();
  });

  it('Service Worker 没有接管页面时不发显示用的请求', () => {
    const { mirror, fetchMock } = setup(null);
    mirror.show(request, Promise.resolve(mocked), new AbortController().signal);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('GET 请求不带请求体；请求头的值不合法或为 undefined 时跳过这个头，照样显示', () => {
    const { mirror, fetchMock } = setup();
    // 业务代码常写 { Authorization: token ? … : undefined }，类型上是 string，运行时可能是 undefined
    const header = { 'x-name': '中文', 'x-empty': undefined as unknown as string, 'x-ok': '1' };
    mirror.show({ ...request, method: 'GET', header }, Promise.resolve(mocked), new AbortController().signal);

    const init = fetchMock.mock.calls[0][1] as RequestInit & { headers: Headers };
    expect(init.body).toBeUndefined();
    expect(init.headers.has('x-name')).toBe(false);
    expect(init.headers.has('x-empty')).toBe(false);
    expect(init.headers.get('x-ok')).toBe('1');
  });

  it('被拦截的 wx.request 交给 onMocked 显示，小程序拿到的是同一个响应；经代理转发的请求不交给它', async () => {
    const shown: Array<{ url: string; response: MockedResponse }> = [];
    const events: Array<Record<string, any>> = [];
    vi.stubGlobal('fetch', async () => new Response('{}', { headers: { 'x-wxa-headers': '%7B%7D' } }));
    const routes = new RequestRoutes();
    routes.add('POST **/api/order', { status: 201, body: { ok: true } });
    const apis = createNetworkApis({
      emit: (_event, data) => events.push(data),
      defaultTimeout: () => 60000,
      routes,
      onMocked: async (req, response) => shown.push({ url: req.url, response: await response })
    });

    for (const url of ['https://api.example.com/api/order', 'https://api.example.com/api/user']) {
      apis.createRequestTask({ url, method: 'POST', data: '{}' }, { api: 'createRequestTask', from: 'service', webviewId: 1 });
    }

    await vi.waitFor(() => expect(events.filter(event => event.state === 'success')).toHaveLength(2));
    expect(shown).toEqual([
      { url: 'https://api.example.com/api/order', response: expect.objectContaining({ statusCode: 201, body: '{"ok":true}' }) }
    ]);
    expect(events).toContainEqual(expect.objectContaining({ state: 'success', statusCode: 201, data: '{"ok":true}' }));
  });
});
