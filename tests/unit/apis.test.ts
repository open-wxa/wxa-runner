/**
 * 不依赖 DOM 的原生 API 实现
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileStore } from '../../packages/core/src/server/FileStore';
import { createFileSystemApis } from '../../packages/core/src/runtime/host/api/fs';
import { createMiscApis } from '../../packages/core/src/runtime/host/api/misc';
import { createNetworkApis } from '../../packages/core/src/runtime/host/api/network';
import { ApiHandler, ApiRegistry, ApiResult } from '../../packages/core/src/runtime/host/api/registry';
import { createSystemApis } from '../../packages/core/src/runtime/host/api/system';
import { createUiApis } from '../../packages/core/src/runtime/host/api/ui';
import type { PhoneShell } from '../../packages/core/src/runtime/host/ui/PhoneShell';

const device = {
  model: 'iPhone 6/7/8', screenWidth: 375, screenHeight: 667, pixelRatio: 2,
  statusBarHeight: 20, safeAreaBottom: 0, system: 'iOS 16.0', platform: 'devtools'
};

const call = (apis: Record<string, ApiHandler>, api: string, args: object = {}) =>
  apis[api](args, { api, from: 'service', webviewId: 1 }) as any;

describe('系统信息', () => {
  const apis = createSystemApis({ device, baseLibVersion: '3.7.0', windowHeight: () => 553, screenTop: () => 64 });

  it('getSystemInfo 合并设备、窗口和基础库信息', () => {
    expect(call(apis, 'getSystemInfoSync')).toMatchObject({
      model: 'iPhone 6/7/8', screenWidth: 375, windowWidth: 375, windowHeight: 553,
      statusBarHeight: 20, SDKVersion: '3.7.0', platform: 'devtools', errMsg: 'getSystemInfoSync:ok'
    });
  });

  it('带 type 参数时只返回对应部分（基础库的 getWindowInfo 等走这条路）', () => {
    const windowInfo = call(apis, 'getSystemInfo', { type: 'windowInfo' });
    expect(windowInfo).toMatchObject({ windowHeight: 553, pixelRatio: 2 });
    expect(windowInfo.model).toBeUndefined();
    expect(call(apis, 'getSystemInfo', { type: 'appBaseInfo' })).toMatchObject({ SDKVersion: '3.7.0' });
  });

  it('刘海屏的安全区扣除状态栏和底部 Home Indicator', () => {
    const iphoneX = { ...device, model: 'iPhone X', screenHeight: 812, pixelRatio: 3, statusBarHeight: 44, safeAreaBottom: 34 };
    const xApis = createSystemApis({ device: iphoneX, baseLibVersion: '3.7.0', windowHeight: () => 812, screenTop: () => 0 });
    expect(call(xApis, 'getWindowInfo')).toMatchObject({
      screenWidth: 375, screenHeight: 812, windowWidth: 375, windowHeight: 812,
      windowTop: 0, windowBottom: 0, screenTop: 0, pixelRatio: 3, statusBarHeight: 44,
      safeArea: { top: 44, left: 0, right: 375, bottom: 778, width: 375, height: 734 },
      safeAreaInsets: { top: 44, left: 0, right: 0, bottom: 34 }
    });
  });

  it('胶囊按钮位置按状态栏高度计算', () => {
    expect(call(apis, 'getMenuButtonBoundingClientRect')).toMatchObject({ top: 26, right: 368, width: 87, height: 32 });
  });
});

describe('界面 API', () => {
  const shell = {
    showToast: vi.fn(),
    hideToast: vi.fn(),
    showModal: vi.fn(async () => ({ confirm: true, cancel: false })),
    showActionSheet: vi.fn(async () => null as number | null),
    setNavigationLoading: vi.fn(),
    updateTabBarItem: vi.fn((index: number) => index < 3),
    updateTabBarStyle: vi.fn()
  };
  const updateNavigation = vi.fn();
  const setTabBarHidden = vi.fn();
  const apis = createUiApis({ shell: shell as unknown as PhoneShell, updateNavigation, setTabBarHidden });

  it('showLoading 是不会自动消失的 loading toast', () => {
    call(apis, 'showLoading', { title: '加载中' });
    expect(shell.showToast).toHaveBeenCalledWith({ title: '加载中', icon: 'loading', duration: 0 });
  });

  it('showModal 等待用户选择后返回结果', async () => {
    await expect(call(apis, 'showModal', { title: 't' })).resolves.toEqual({ confirm: true, cancel: false, errMsg: 'showModal:ok' });
  });

  it('取消 actionSheet 返回 fail cancel', async () => {
    await expect(call(apis, 'showActionSheet', { itemList: ['a'] })).resolves.toEqual({ errMsg: 'showActionSheet:fail cancel' });
    shell.showActionSheet.mockResolvedValueOnce(1);
    await expect(call(apis, 'showActionSheet', { itemList: ['a', 'b'] })).resolves.toMatchObject({ tapIndex: 1 });
  });

  it('导航栏颜色：frontColor 换算为文字样式', () => {
    call(apis, 'setNavigationBarColor', { frontColor: '#000000', backgroundColor: '#ffffff' });
    expect(updateNavigation).toHaveBeenLastCalledWith({ backgroundColor: '#ffffff', textStyle: 'black' });
    call(apis, 'setNavigationBarTitle', { title: '新标题' });
    expect(updateNavigation).toHaveBeenLastCalledWith({ title: '新标题' });
  });

  it('hideTabBar / showTabBar 切换原生 tabBar 的显隐', () => {
    call(apis, 'hideTabBar', { animation: true });
    expect(setTabBarHidden).toHaveBeenLastCalledWith(true);
    call(apis, 'showTabBar');
    expect(setTabBarHidden).toHaveBeenLastCalledWith(false);
  });

  it('基础库转来的 setTabBarBadge 按 type 设置徽标、红点或清除', () => {
    call(apis, 'setTabBarBadge', { index: 2, type: 'text', badgeValue: '9' });
    expect(shell.updateTabBarItem).toHaveBeenLastCalledWith(2, { mark: { type: 'text', text: '9' } });
    call(apis, 'setTabBarBadge', { index: 0, type: 'redDot' });
    expect(shell.updateTabBarItem).toHaveBeenLastCalledWith(0, { mark: { type: 'redDot' } });
    call(apis, 'setTabBarBadge', { index: 0, type: 'none' });
    expect(shell.updateTabBarItem).toHaveBeenLastCalledWith(0, { mark: null });
  });

  it('tabBar 项 index 越界时 fail', () => {
    expect(call(apis, 'setTabBarBadge', { index: 5, type: 'redDot' })).toEqual({ errMsg: 'setTabBarBadge:fail tabbar item not found' });
    expect(call(apis, 'setTabBarItem', { index: 5, text: 'x' })).toEqual({ errMsg: 'setTabBarItem:fail tabbar item not found' });
    expect(call(apis, 'setTabBarItem', { index: 1, text: 'x' })).toBeUndefined();
  });
});

describe('网络 API', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const flush = () => new Promise(resolve => setTimeout(resolve, 0));

  function setup(response: () => Promise<Response>) {
    const events: Array<[string, any]> = [];
    const fetchMock = vi.fn(async (..._args: unknown[]) => response());
    vi.stubGlobal('fetch', fetchMock);
    const apis = createNetworkApis({ emit: (event, data) => events.push([event, data]), defaultTimeout: () => 60000 });
    return { apis, events, fetchMock };
  }

  const proxied = (body: BodyInit, status = 200, header: object = { 'content-type': 'text/plain' }) => async () =>
    new Response(body, {
      status,
      headers: {
        'x-wxa-headers': encodeURIComponent(JSON.stringify(header)),
        'x-wxa-set-cookie': encodeURIComponent(JSON.stringify(['a=1']))
      }
    });

  it('同步返回 requestTaskId，随后依次推送 headersReceived 和 success', async () => {
    const { apis, events, fetchMock } = setup(proxied('{"ok":1}', 201));
    const result = call(apis, 'createRequestTask', { url: 'https://api.example.com/x?y=1', method: 'post', data: 'a=1', header: { cookie: 'c=1' } });
    expect(result.errMsg).toBe('createRequestTask:ok');
    expect(events).toEqual([]);

    await vi.waitFor(() => expect(events.length).toBe(2));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/__wxa__/proxy/https/api.example.com/x?y=1');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('a=1');
    expect(JSON.parse((init.headers as Record<string, string>)['x-wxa-headers'])).toEqual({ cookie: 'c=1' });

    expect(events[0]).toEqual(['onRequestTaskStateChange', expect.objectContaining({ state: 'headersReceived', statusCode: 201, cookies: ['a=1'] })]);
    expect(events[1]).toEqual(['onRequestTaskStateChange', expect.objectContaining({
      requestTaskId: result.requestTaskId, state: 'success', data: '{"ok":1}', statusCode: 201, header: { 'content-type': 'text/plain' }
    })]);
  });

  it('GET 请求不带请求体', async () => {
    const { apis, fetchMock } = setup(proxied(''));
    call(apis, 'createRequestTask', { url: 'https://a.com', data: 'ignored' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].body).toBeUndefined();
  });

  it('代理报错或地址非法时推送 fail', async () => {
    const { apis, events } = setup(async () => new Response('ECONNREFUSED', { status: 502, headers: { 'x-wxa-proxy-error': '1' } }));
    call(apis, 'createRequestTask', { url: 'https://down.example.com' });
    call(apis, 'createRequestTask', { url: 'relative/path' });
    await vi.waitFor(() => expect(events.length).toBe(2));
    expect(events.map(([, data]) => data.errMsg).sort()).toEqual([
      'request:fail ECONNREFUSED',
      'request:fail invalid url "relative/path"'
    ]);
  });

  it('abort 后推送 request:fail abort', async () => {
    const { apis, events } = setup(() => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new DOMException('aborted', 'AbortError')), 20);
    }));
    const { requestTaskId } = call(apis, 'createRequestTask', { url: 'https://slow.example.com' });
    await flush();
    call(apis, 'operateRequestTask', { requestTaskId, operationType: 'abort' });
    await vi.waitFor(() => expect(events.length).toBe(1));
    expect(events[0][1]).toMatchObject({ state: 'fail' });
  });

  it('基础库自己的网络请求（数据上报等）不发往网络、不记入请求记录，直接失败', async () => {
    const recorded: unknown[] = [];
    const fetchMock = vi.fn();
    const socketMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', socketMock);
    const apis = createNetworkApis({ emit: () => undefined, defaultTimeout: () => 60000, onRequest: request => recorded.push(request) });

    // 基础库通过 _requestSkipCheckDomain 等内部接口发出，带 __skipDomainCheck__ 标记
    const internal = { url: 'https://report-online.sh.wxgateway.com/SdkReport', method: 'POST', __skipDomainCheck__: true };
    const results = ['createRequestTask', 'createDownloadTask', 'createUploadTask', 'createSocketTask'].map(api => call(apis, api, internal).errMsg);
    await flush();

    expect(results).toEqual([
      expect.stringMatching(/^createRequestTask:fail/),
      expect.stringMatching(/^createDownloadTask:fail/),
      expect.stringMatching(/^createUploadTask:fail/),
      expect.stringMatching(/^createSocketTask:fail/)
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(socketMock).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('插件里的 wx.request 经代理发出、记入请求记录：基础库同样标了 __skipDomainCheck__，但带着插件签名', async () => {
    const recorded: Array<{ url: string }> = [];
    const events: Array<[string, any]> = [];
    const fetchMock = vi.fn(async (..._args: unknown[]) => proxied('{"ok":true}', 200, { 'content-type': 'application/json' })());
    vi.stubGlobal('fetch', fetchMock);
    const apis = createNetworkApis({
      emit: (event, data) => events.push([event, data]), defaultTimeout: () => 60000, onRequest: request => recorded.push(request)
    });

    // 基础库按 verifyPlugin 给的域名校验过插件的请求，加上签名头后标 __skipDomainCheck__ 交给原生
    const header = { 'X-WECHAT-HOSTSIGN': '{"noncestr":"n","timestamp":1,"signature":"s"}' };
    call(apis, 'createRequestTask', { url: 'https://plugin.example.com/data', method: 'GET', header, __skipDomainCheck__: true });

    await vi.waitFor(() => expect(events.some(([, data]) => data.state === 'success')).toBe(true));
    expect(fetchMock.mock.calls[0][0]).toBe('/__wxa__/proxy/https/plugin.example.com/data');
    expect(recorded.map(request => request.url)).toEqual(['https://plugin.example.com/data']);
  });

  it('基础库为 InnerAudioContext 下载音频的内部请求经代理发出，success 的 data 是 ArrayBuffer，不记入请求记录', async () => {
    const recorded: unknown[] = [];
    const events: Array<[string, any]> = [];
    const fetchMock = vi.fn(async (..._args: unknown[]) => proxied(new Uint8Array([1, 2, 255]), 200, { 'content-type': 'audio/mpeg' })());
    vi.stubGlobal('fetch', fetchMock);
    const apis = createNetworkApis({
      emit: (event, data) => events.push([event, data]), defaultTimeout: () => 60000, onRequest: request => recorded.push(request)
    });

    // 平台是 devtools 时 InnerAudioContext 用 Web Audio 播放，基础库这样把音频下载成 ArrayBuffer
    const audio = { url: 'https://cdn.example.com/a.mp3', responseType: 'arraybuffer', enableHttp2: true, enableCache: true, __skipDomainCheck__: true };
    const { requestTaskId } = call(apis, 'createRequestTask', audio);

    await vi.waitFor(() => expect(events.some(([, data]) => data.state === 'success')).toBe(true));
    expect(fetchMock.mock.calls[0][0]).toBe('/__wxa__/proxy/https/cdn.example.com/a.mp3');
    const success = events.find(([, data]) => data.state === 'success')![1];
    expect(success).toMatchObject({ requestTaskId, statusCode: 200, header: { 'content-type': 'audio/mpeg' } });
    expect(new Uint8Array(success.data)).toEqual(new Uint8Array([1, 2, 255]));
    expect(recorded).toEqual([]);
  });

  it('小程序按 responseType: arraybuffer 请求时，拿到服务器返回的原始字节，不按文本解码', async () => {
    // 0x80、0xff 不是合法的 UTF-8，按文本解码会变成替换字符
    const bytes = [0, 0x80, 0xff, 0x41];
    const { apis, events } = setup(proxied(new Uint8Array(bytes), 200, { 'content-type': 'application/octet-stream' }));
    const { requestTaskId } = call(apis, 'createRequestTask', { url: 'https://cdn.example.com/a.bin', responseType: 'arraybuffer' });

    await vi.waitFor(() => expect(events.some(([, data]) => data.state === 'success')).toBe(true));
    const success = events.find(([, data]) => data.state === 'success')![1];
    expect(success).toMatchObject({ requestTaskId, statusCode: 200 });
    expect(success.data).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(success.data)).toEqual(new Uint8Array(bytes));
  });

  it('WebSocket 收到的二进制消息以 ArrayBuffer 交给小程序，文本消息仍是字符串', () => {
    const sockets: FakeSocket[] = [];
    class FakeSocket {
      static OPEN = 1;
      readyState = 1;
      binaryType = 'blob';
      onmessage: ((event: { data: unknown }) => void) | null = null;
      constructor() {
        sockets.push(this);
      }
      /** 服务器发来一条消息。和浏览器一样，binaryType 不是 arraybuffer 时二进制消息是 Blob */
      receive(message: string | Uint8Array) {
        if (typeof message === 'string') this.onmessage?.({ data: message });
        else this.onmessage?.({ data: this.binaryType === 'arraybuffer' ? message.slice().buffer : new Blob([message.slice()]) });
      }
    }
    vi.stubGlobal('WebSocket', FakeSocket);
    const events: Array<[string, any]> = [];
    const apis = createNetworkApis({ emit: (event, data) => events.push([event, data]), defaultTimeout: () => 60000 });

    const { socketTaskId } = call(apis, 'createSocketTask', { url: 'wss://chat.example.com' });
    sockets[0].receive(new Uint8Array([0, 0x80, 0xff]));
    sockets[0].receive('hello');

    const messages = events.filter(([, data]) => data.state === 'message').map(([, data]) => data);
    expect(messages.map(message => message.socketTaskId)).toEqual([socketTaskId, socketTaskId]);
    expect(messages[0].data).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(messages[0].data)).toEqual(new Uint8Array([0, 0x80, 0xff]));
    expect(messages[1].data).toBe('hello');
  });

  it('downloadFile 把下载的文件存成开发服务器上的临时文件，返回它的地址', async () => {
    vi.stubGlobal('localStorage', { getItem: () => 'test-session' });
    const saved: Array<{ url: string; content: string }> = [];
    const { apis, events } = setup(proxied('file-content'));
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      if (!url.startsWith('/__wxa__/tmp')) return proxied('file-content')();
      saved.push({ url, content: await (init!.body as Blob).text() });
      return Response.json({ url: 'http://localhost:3000/__wxa__/tmp/saved.png' });
    });

    const { downloadTaskId } = call(apis, 'createDownloadTask', { url: 'https://cdn.example.com/a.png?v=2' });

    await vi.waitFor(() => expect(events.some(([, d]) => d.state === 'success')).toBe(true));
    expect(saved).toEqual([{ url: '/__wxa__/tmp/test-session?type=png', content: 'file-content' }]);
    expect(events.at(-1)).toEqual(['onDownloadTaskStateChange', expect.objectContaining({
      downloadTaskId, state: 'success', tempFilePath: 'http://localhost:3000/__wxa__/tmp/saved.png', statusCode: 200
    })]);
  });
});

describe('文件系统', () => {
  const files = new FileStore();
  const apis = createFileSystemApis(files.execute.bind(files));

  it('文件系统 API 与基础库的调用格式一致', () => {
    expect(call(apis, 'access', { path: 'http://usr/x' }).errMsg).toMatch(/^access:fail no such file/);
    expect(call(apis, 'mkdir', { dirPath: 'http://usr/logs', recursive: true }).errMsg).toBe('mkdir:ok');
    call(apis, 'writeFile', { filePath: 'http://usr/logs/1.log', data: 'hello' });
    expect(call(apis, 'readFileSync', { filePath: 'http://usr/logs/1.log', encoding: 'utf8' })).toMatchObject({ data: 'hello' });
    expect(call(apis, 'stat', { path: 'http://usr/logs/1.log' }).stats).toMatchObject({ size: 5 });
    expect(call(apis, 'readdir', { dirPath: 'http://usr/logs' }).files).toEqual(['1.log']);
  });

  describe('经开发服务器读写', () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    const respond = (body: string, status = 200) => {
      vi.stubGlobal('localStorage', { getItem: () => 'session-1', setItem: () => undefined });
      const fetchMock = vi.fn(async () => new Response(body, { status }));
      vi.stubGlobal('fetch', fetchMock);
      return fetchMock;
    };

    it('异步接口按会话请求，文件不存在等失败从响应体的 error 取原因', async () => {
      const fetchMock = respond(JSON.stringify({ error: 'no such file or directory http://usr/x' }));
      expect((await call(createFileSystemApis(), 'access', { path: 'http://usr/x' })).errMsg).toBe('access:fail no such file or directory http://usr/x');
      expect(fetchMock).toHaveBeenCalledWith('/__wxa__/fs/session-1', expect.objectContaining({ method: 'POST' }));
    });

    it('请求被拒绝（如请求体超过上限）时响应不是 JSON，报状态码', async () => {
      respond('<!DOCTYPE html><title>PayloadTooLargeError</title>', 413);
      expect((await call(createFileSystemApis(), 'writeFile', { filePath: 'http://usr/a', data: 'x' })).errMsg).toBe('writeFile:fail filesystem HTTP 413');
    });
  });
});

describe('其它 API', () => {
  const apis = createMiscApis('wx1');

  it('不校验业务域名：基础库不论从哪个原生接口拉业务域名列表都明确失败，拉别的照常成功', () => {
    expect(call(apis, 'operateWXData', { data: { api_name: 'webapi_getwxanetwork' } }).errMsg).toMatch(/^operateWXData:fail /);
    expect(call(apis, 'getAppContact', { keyPath: 'WxaAppInfo.Network.BizDomain' }).errMsg).toMatch(/^getAppContact:fail /);
    expect(call(apis, 'operateWXData', { data: { api_name: 'webapi_getwxabusinessconfig' } }).errMsg).toBe('operateWXData:ok');
    expect(call(apis, 'getAppContact', { keyPath: 'WxaAppInfo.Name' }).errMsg).toBe('getAppContact:ok');
  });

  it('基础库做隐私检查时拿到「不用弹窗、没有未授权的接口」，业务调用的接口照常执行', () => {
    const res = call(apis, 'operateWXData', { data: { api_name: 'webapi_getwxauserprivacyauthinfo', data: { version: 3 } } });
    expect(res.errMsg).toBe('operateWXData:ok');
    expect(wxDataSeenByBaseLib(res)).toMatchObject({
      action_code: 0, need_popup_scope_list: [], unauth_scope_list: [], wording: expect.any(Object)
    });
  });

  it('没开 --devtools-login 时，服务市场调用明确失败并提示加 --devtools-login', () => {
    const res = call(apis, 'operateWXData', { data: { api_name: 'webapi_servicemarket_jsapi_comm', data: {} } });
    expect(res.errMsg).toMatch(/^operateWXData:fail .*--devtools-login/);
  });

  it('开放接口返回可预测的模拟数据，支付明确失败', () => {
    expect(call(apis, 'login').code).toMatch(/^wxa_mock_code_/);
    expect(phoneCodeSeenByBaseLib(call(apis, 'getPhoneNumber'))).toMatch(/^mock_phone_code_/);
    expect(call(apis, 'getAccountInfoSync').miniProgram.appId).toBe('wx1');
    expect(call(apis, 'requestPayment').errMsg).toMatch(/^requestPayment:fail /);
  });
});

describe('读取代码包里的文件', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // 开发服务器以项目目录为根目录提供代码包里的文件
  function setup() {
    const files: Record<string, Uint8Array<ArrayBuffer>> = {
      '/assets/data.bin': new Uint8Array([1, 2, 255]),
      '/assets/hello.txt': new TextEncoder().encode('你好'),
      // 文件名里的 # 和 ? 要编码，否则会被当成地址的片段和查询
      '/assets/c%23%3F.txt': new TextEncoder().encode('sharp')
    };
    const fetchMock = vi.fn(async (url: string) => (files[url] ? new Response(files[url]) : new Response('', { status: 404 })));
    vi.stubGlobal('fetch', fetchMock);
    const store = new FileStore();
    return { apis: createFileSystemApis(store.execute.bind(store)), fetchMock };
  }

  it('readFile 不指定编码时得到 ArrayBuffer，指定 utf8 时得到文本，路径可以不以 / 开头', async () => {
    const { apis } = setup();
    const binary = await call(apis, 'readFile', { filePath: '/assets/data.bin' });
    expect(binary.errMsg).toBe('readFile:ok');
    expect(new Uint8Array(binary.data)).toEqual(new Uint8Array([1, 2, 255]));
    expect(await call(apis, 'readFile', { filePath: 'assets/hello.txt', encoding: 'utf8' })).toMatchObject({ data: '你好' });
    expect(await call(apis, 'readFile', { filePath: '/assets/c#?.txt', encoding: 'utf8' })).toMatchObject({ data: 'sharp' });
  });

  it('代码包里没有的文件、不支持的编码，readFile 失败', async () => {
    const { apis } = setup();
    expect((await call(apis, 'readFile', { filePath: '/assets/none.bin' })).errMsg).toBe(
      'readFile:fail no such file or directory, open /assets/none.bin'
    );
    expect((await call(apis, 'readFile', { filePath: '/assets/hello.txt', encoding: 'hex' })).errMsg).toMatch(/^readFile:fail /);
  });

  it('用户文件只访问文件存储，不向代码包静态资源接口取', async () => {
    const { apis, fetchMock } = setup();
    call(apis, 'writeFile', { filePath: 'http://usr/a.txt', data: 'local' });
    expect(await call(apis, 'readFile', { filePath: 'http://usr/a.txt', encoding: 'utf8' })).toMatchObject({ data: 'local' });
    expect((await call(apis, 'readFile', { filePath: 'http://usr/assets/data.bin' })).errMsg).toMatch(/^readFile:fail no such file/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('readFileSync 同步读取可写文件存储，不读取代码包静态资源', () => {
    const { apis, fetchMock } = setup();
    expect(call(apis, 'readFileSync', { filePath: 'assets/data.bin' }).errMsg).toMatch(/^readFileSync:fail no such file/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('用户目录下有同名文件时，不带协议的路径仍读代码包里的文件', async () => {
    const { apis } = setup();
    call(apis, 'mkdir', { dirPath: 'http://usr/assets' });
    call(apis, 'writeFile', { filePath: 'http://usr/assets/data.bin', data: 'local' });

    const result = await call(apis, 'readFile', { filePath: 'assets/data.bin' });

    expect(new Uint8Array(result.data)).toEqual(new Uint8Array([1, 2, 255]));
  });
});

/** 基础库的 operateWXData 封装：data（对象或 JSON 文本）里的 data 是 JSON 文本，解析后才是接口返回的数据 */
function wxDataSeenByBaseLib(result: { data?: unknown }): unknown {
  const outer = typeof result.data === 'string' ? JSON.parse(result.data) : result.data as { data?: unknown } | undefined;
  return typeof outer?.data === 'string' ? JSON.parse(outer.data) : undefined;
}

/** 基础库（WAWebview 的 getPhoneNumber）只从 JSON.parse(data) 里取 code，顶层的 code 会被丢掉 */
function phoneCodeSeenByBaseLib(result: { data?: string }): string | undefined {
  return result.data ? JSON.parse(result.data).code : undefined;
}

describe('开发者工具登录态（--devtools-login）', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function invoke(api: string, response: Response, args: Record<string, any> = {}) {
    const fetchMock = vi.fn(async (..._args: unknown[]) => response);
    vi.stubGlobal('fetch', fetchMock);
    const onDevtoolsLoginFail = vi.fn();
    const registry = new ApiRegistry();
    registry.register(createMiscApis('wx1', { devtoolsLogin: true, onDevtoolsLoginFail }));
    return { result: registry.invoke(api, args, { api, from: 'service', webviewId: 1 }) as Promise<ApiResult>, fetchMock, onDevtoolsLoginFail };
  }

  const json = (body: object, status = 200) => new Response(JSON.stringify(body), { status });

  it('wx.login 返回开发服务器向微信换来的 code', async () => {
    const { result, fetchMock } = invoke('login', json({ code: 'real-code' }));
    expect(await result).toEqual({ code: 'real-code', errMsg: 'login:ok' });
    expect(fetchMock).toHaveBeenCalledWith('/__wxa__/api/login', { method: 'POST' });
  });

  it('getPhoneNumber 的 code 能被基础库取到', async () => {
    const data = JSON.stringify({ data: '{"mobile":"138****1997"}', encryptedData: 'enc', iv: 'iv', code: 'phone-code' });
    const { result } = invoke('getPhoneNumber', json({ data, encryptedData: 'enc', iv: 'iv' }));
    const phone = await result;
    expect(phone).toMatchObject({ encryptedData: 'enc', iv: 'iv', errMsg: 'getPhoneNumber:ok' });
    expect(phoneCodeSeenByBaseLib(phone)).toBe('phone-code');
  });

  it('开发服务器给出的失败原因原样作为 fail 消息，不退回模拟数据', async () => {
    const { result } = invoke('login', json({ error: '微信开发者工具的登录态已过期' }, 500));
    expect(await result).toEqual({ errMsg: 'login:fail 微信开发者工具的登录态已过期' });
  });

  it('失败时把 API 名称和原因交给宿主页面提示开发者，成功时不提示', async () => {
    const failed = invoke('getPhoneNumber', json({ error: '微信开发者工具的登录态已过期' }, 500));
    await failed.result;
    expect(failed.onDevtoolsLoginFail).toHaveBeenCalledWith('getPhoneNumber', '微信开发者工具的登录态已过期');

    const succeeded = invoke('login', json({ code: 'real-code' }));
    await succeeded.result;
    expect(succeeded.onDevtoolsLoginFail).not.toHaveBeenCalled();
  });

  it('wx.serviceMarket 的请求经开发服务器发给微信，结果原样交给基础库', async () => {
    const request = { api_name: 'webapi_servicemarket_jsapi_comm', data: { service_id: 'wxcae50ba710ca29d3', api_name: 'jokebot', data: '{"mode":2}' } };
    const data = { data: JSON.stringify({ request_id: 'req-1', errcode: 0, data: '{"err_code":0}' }), err_no: 0 };
    const { result, fetchMock } = invoke('operateWXData', json({ data }), { data: request });

    expect(await result).toEqual({ data, errMsg: 'operateWXData:ok' });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/__wxa__/api/operate-wx-data');
    expect(JSON.parse(init.body as string)).toEqual({ data: request });
  });

  it('服务市场调用失败时，业务代码收到 fail，宿主页面提示是哪个接口', async () => {
    const request = { api_name: 'webapi_servicemarket_jsapi_comm', data: {} };
    const { result, onDevtoolsLoginFail } = invoke('operateWXData', json({ error: '服务市场调用失败 40001: invalid credential' }, 500), { data: request });

    // 带上 err_code，基础库才会把原因拼进 invokeService 的错误
    expect(await result).toEqual({ errMsg: 'operateWXData:fail 服务市场调用失败 40001: invalid credential', err_code: -1 });
    expect(onDevtoolsLoginFail).toHaveBeenCalledWith('serviceMarket.invokeService', '服务市场调用失败 40001: invalid credential');
  });

  it('开启 --devtools-login后，基础库拉取配置的 operateWXData 不发给开发服务器', () => {
    const { result, fetchMock } = invoke('operateWXData', json({}), { data: { api_name: 'webapi_getwxabusinessconfig' } });
    expect(result).toEqual({ errMsg: 'operateWXData:ok' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('基础库校验插件、拉插件信息时经开发服务器向微信取，结果原样交给基础库', async () => {
    const list = [{ plugin_id: 'wxplugin', request_domain: ['https://api.example.com'] }];
    const verify = invoke('verifyPlugin', json({ data: { list } }), { data: { plugins: [{ provider: 'wxplugin' }] } });
    expect(await verify.result).toEqual({ data: { list }, errMsg: 'verifyPlugin:ok' });
    expect(verify.fetchMock.mock.calls[0][0]).toBe('/__wxa__/api/verify-plugin');
    expect(JSON.parse((verify.fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual({ data: { plugins: [{ provider: 'wxplugin' }] } });

    const contactList = [{ appId: 'wxplugin', plugin_list: [{ nickname: '快递跟踪' }] }];
    const contact = invoke('batchGetContact', json({ contactList }), { appIds: ['wxplugin'] });
    expect(await contact.result).toEqual({ contactList, errMsg: 'batchGetContact:ok' });
    expect(contact.fetchMock.mock.calls[0][0]).toBe('/__wxa__/api/batch-get-contact');
  });

  it('响应不是 JSON 时（如代理返回的错误页）fail 消息带上状态码', async () => {
    const { result } = invoke('getPhoneNumber', new Response('<!DOCTYPE html>', { status: 502 }));
    expect(await result).toEqual({ errMsg: 'getPhoneNumber:fail 开发服务器返回 HTTP 502' });
  });
});
