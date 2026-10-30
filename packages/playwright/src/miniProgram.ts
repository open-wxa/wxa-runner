/**
 * miniProgram fixture：在 Node 里驱动浏览器中的 window.__wxa_test_api__
 *
 * mock、unmock、route、unroute 按调用顺序记在 Node 侧，页面每次加载时由 __wxa_before_launch__ 取回、
 * 在 setup 之后重放：打开页面前声明的在 App.onLaunch 里就生效，整页重新加载后状态与加载前一致。
 * 函数形式的 mock、route 留在 Node 里执行，浏览器经 page.exposeFunction 的通道按编号调用。
 */

import type { FrameLocator, Page } from '@playwright/test';
import type { ApiContext, ApiResult, FrameError, MockResponse, RecordedRequest, WxaTestApi } from '@open-wxa/wxa-runner-core';
import type {} from '@open-wxa/wxa-runner-core/test-api';
import { MiniProgramRequest, withBody } from './request';

type Remote<T> = { [K in keyof T]: T[K] extends (...args: infer A) => infer R ? (...args: A) => Promise<Awaited<R>> : never };

/** 原样转发给浏览器的测试 API，说明复用 WxaTestApi 的注释 */
type ForwardedApi = Remote<Pick<WxaTestApi,
  | 'currentPage' | 'pageStack' | 'webViews' | 'waitForPage' | 'pageData' | 'callPageMethod'
  | 'navigateTo' | 'navigateBack' | 'redirectTo' | 'reLaunch' | 'switchTab'
  | 'getStorage' | 'clearStorage' | 'clearRequests'>>;

/** 在 Node 里执行的 mock：args 是小程序调用时传的参数（不含回调），返回调用结果 */
export type MockHandler = (args: any, context: ApiContext) => ApiResult | void | Promise<ApiResult | void>;

/** 在 Node 里执行的拦截：按请求返回响应，不返回时为 200 空响应。request.routedBy 是这条规则 */
export type RouteHandler = (request: MiniProgramRequest) => MockResponse | void | Promise<MockResponse | void>;

export interface MiniProgram extends ForwardedApi {
  /** 当前页的渲染层，始终指向页面栈顶：跳转后不用重新获取 */
  readonly current: FrameLocator;
  /**
   * 打开小程序，等它启动完成。同一个用例里再次调用会整页重新加载，之前的 mock、route（包括撤销）仍然生效
   * @param url 启动页和参数，如 pages/detail/detail?id=1，开头的 / 可有可无；默认是首页
   * @throws 页面不在 app.json 里；编译失败、setup 或启动前声明的 mock、route 出错时，错误信息同模拟器上显示的
   */
  open(url?: string): Promise<void>;
  /**
   * 覆盖原生 API，同名的 setup mock 也被覆盖。打开页面前调用的，在 App.onLaunch 里就生效
   * @param api 与 wx 上的名字相同，如 login、getLocation
   * @param impl 对象作为调用结果。函数在 Node 里执行：能用用例里的变量、检查调用参数，
   *   但结果是异步返回的，参数和返回值要能序列化；函数抛错时这次调用失败，用例结束后也失败
   * @throws 基础库同步调用的 API（以 Sync 结尾的，以及 getSystemInfo、getMenuButtonBoundingClientRect）传了函数时；
   *   api 是 request 等 mock 不会生效的 API 时（请求用 route 拦截），打开页面前调用的在 open 时报错
   */
  mock(api: string, impl: ApiResult | MockHandler): Promise<void>;
  /** 撤销 mock，恢复内置实现；不传 api 时撤销全部，包括 setup 声明的。再次 open 后仍是撤销的 */
  unmock(api?: string): Promise<void>;
  /**
   * 拦截 wx.request：命中的请求不发往网络，直接返回给定的响应，后添加的规则优先。打开页面前调用的，在 App.onLaunch 里就生效
   * @param pattern '[请求方法 ]地址'，如 'POST https://api.example.com/login'；* 匹配一段路径，** 匹配任意内容（可以不写域名）
   * @param handler 响应 { status?, header?, body?, delay? }。或者在 Node 里执行、按请求返回响应的函数，
   *   函数抛错时请求失败，用例结束后也失败
   * @throws 规则写法不对时，打开页面前调用的在 open 时报错
   */
  route(pattern: string, handler: MockResponse | RouteHandler): Promise<void>;
  /** 删除按这个写法添加的拦截规则；不传时删除全部，包括 setup 声明的。已经发出的请求不受影响，再次 open 后仍是删除的 */
  unroute(pattern?: string): Promise<void>;
  /**
   * 小程序发出的 wx.request，按发出顺序，被拦截的和经代理转发的都有。每次打开页面从头记录，只保留最近 1000 个
   * @param pattern 只返回匹配的请求，写法同 route
   */
  requests(pattern?: string): Promise<MiniProgramRequest[]>;
  /**
   * 等到小程序发出匹配的请求，返回最近的一个。已经发出的也算：只关心某个操作之后的请求时，操作前先 clearRequests()
   * @param pattern 写法同 route
   * @param options.timeout 毫秒，默认 10000
   * @throws 超时，错误信息里列出已发出的请求
   */
  waitForRequest(pattern: string, options?: { timeout?: number }): Promise<MiniProgramRequest>;
  /**
   * 逻辑层、渲染层的运行时错误，以及业务代码调用过的未实现 wx API（api 为 API 名称，每个 API 记一次），
   * 包括本用例里之前打开页面时出现的。用例结束时 fixture 会检查它为空（wxaCheckErrors）
   */
  errors(): Promise<FrameError[]>;
  /**
   * 当前页 web-view 打开的网页窗口，只在新窗口模式下可用（test.use({ wxaWebView: 'window' })）。
   * 网页窗口跟着所在页面走：跳到别的页面时关闭，返回时重新打开，之后要重新获取
   * @param options.index 当前页有多个 web-view 时取第几个，从 0 开始，顺序同 webViews()
   * @param options.timeout 等窗口打开的毫秒数，默认 10000
   * @throws 不是新窗口模式；当前页有多个 web-view 却没给 index；超时，错误信息里列出可能的原因
   */
  webView(options?: { index?: number; timeout?: number }): Promise<Page>;
}

export interface MiniProgramSession {
  miniProgram: MiniProgram;
  /** 处理函数出过错时抛出：浏览器里只变成一次失败的调用，断言写在处理函数里时用例会误以为通过 */
  throwHandlerError(): void;
}

export interface MiniProgramOptions {
  baseURL: string;
  /** app.json 里的页面；编译失败时为 null，由模拟器显示编译错误 */
  listPages(): Promise<string[] | null>;
  /** web-view 的网页在新窗口打开，见 WxaOptions.wxaWebView */
  webViewWindow?: boolean;
}

/** 浏览器调用 Node 的通道名 */
const BRIDGE = '__wxa_playwright__';
/** 二进制的拦截响应体在传给浏览器时换成 { [BINARY_BODY]: base64 }，见 encodeBinaryBody */
const BINARY_BODY = '__wxa_binary_body__';
const DEFAULT_REQUEST_TIMEOUT = 10000;
const DEFAULT_WEB_VIEW_TIMEOUT = 10000;

/** 基础库同步调用的原生 API：wx.getWindowInfo、getDeviceInfo、getSystemInfoSync 等都同步调用 getSystemInfo */
const SYNC_APIS = new Set(['getSystemInfo', 'getMenuButtonBoundingClientRect']);

/** 一次 mock、unmock、route 或 unroute；handler 是 Node 里处理函数的编号 */
type Operation =
  | { type: 'mock'; api: string; result?: ApiResult; handler?: number }
  | { type: 'unmock'; api?: string }
  | { type: 'route'; pattern: string; response?: MockResponse; handler?: number }
  | { type: 'unroute'; pattern?: string };

/** 在页面脚本之前执行（序列化后注入浏览器，只能引用自己的参数） */
function installInPage({ bridge, binaryBody }: { bridge: string; binaryBody: string }) {
  if (window !== window.top) return;
  const callNode = (...args: unknown[]) => (window as any)[bridge](...args);
  const decodeBody = (response: any) => {
    const base64 = response?.body?.[binaryBody];
    return typeof base64 === 'string' ? { ...response, body: Uint8Array.from(atob(base64), char => char.charCodeAt(0)) } : response;
  };
  // 传给 Node 的 ArrayBuffer 会变成 {}，Uint8Array 能保留，到 Node 里再换回 ArrayBuffer（见 fromPage）
  const toNode = (request: any) => (Object.prototype.toString.call(request?.data) === '[object ArrayBuffer]'
    ? { ...request, data: new Uint8Array(request.data) }
    : request);
  const replay = (api: WxaTestApi, operations: Operation[]) => {
    for (const op of operations) {
      if (op.type === 'mock') {
        api.mock(op.api, op.handler ? (args: unknown, context: unknown) => callNode('call', op.handler, [args, context]) : op.result!);
      } else if (op.type === 'unmock') {
        api.unmock(op.api);
      } else if (op.type === 'route') {
        api.route(op.pattern, op.handler
          ? async (request: unknown) => decodeBody(await callNode('call', op.handler, [toNode(request)]))
          : decodeBody(op.response));
      } else {
        api.unroute(op.pattern);
      }
    }
  };
  (window as any).__wxa_playwright_replay__ = replay;
  (window as any).__wxa_playwright_requests__ = (pattern?: string) => window.__wxa_test_api__.requests(pattern).map(toNode);
  window.__wxa_before_launch__ = async api => replay(api, await callNode('operations'));
}

/**
 * 响应体是 Buffer、Uint8Array 等二进制时换成 base64，到了浏览器里再还原成 Uint8Array（installInPage 的 decodeBody）。
 * page.evaluate 的参数能保留二进制，exposeFunction 的返回值不能：打开页面前声明的规则、Node 里函数的结果都经它传回浏览器，
 * 到了浏览器里变成 { 0: …, 1: … } 这样的普通对象，会被当成 JSON 返回
 */
function encodeBinaryBody<T extends MockResponse | void>(response: T): T {
  const body = response?.body;
  if (!(body instanceof ArrayBuffer) && !ArrayBuffer.isView(body)) return response;
  const bytes = ArrayBuffer.isView(body) ? Buffer.from(body.buffer, body.byteOffset, body.byteLength) : Buffer.from(body);
  return { ...response, body: { [BINARY_BODY]: bytes.toString('base64') } };
}

/** 小程序发出的请求传到 Node：二进制请求体经 Uint8Array 传过来（见 installInPage 的 toNode），换回和浏览器里一样的 ArrayBuffer */
function fromPage(request: RecordedRequest): MiniProgramRequest {
  const { data } = request;
  if (!(data instanceof Uint8Array)) return withBody(request);
  return withBody({ ...request, data: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) });
}

/**
 * 新窗口模式下收集宿主打开的网页窗口，按窗口名（webViews() 的 windowName）对应到 Page。
 *
 * 不读网页的 window.name：网页可以改掉它，设置了 Cross-Origin-Opener-Policy 时还会被清空。宿主每新开一个窗口都会经
 * __wxa_webview_window_event__ 告诉这里窗口名，和 popup 事件按先后配对（地址相同的优先，网页重定向后按顺序）。
 * Cross-Origin-Opener-Policy 下宿主关不掉窗口，这里替它关：宿主关窗口时关掉对应的 Page，同名窗口重新打开时关掉旧的。
 * 从一开始就收集：等调用 webView() 时窗口可能早已打开，再监听 popup 会错过
 */
async function trackWebViewWindows(page: Page) {
  const windows = new Map<string, Page>();
  const opened: Array<{ name: string; src: string; closed: boolean }> = [];
  const popups: Page[] = [];
  const close = (popup: Page | undefined) => popup && !popup.isClosed() ? popup.close().catch(() => undefined) : undefined;

  const pair = () => {
    while (opened.length && popups.length) {
      const popup = popups.shift()!;
      const index = Math.max(0, opened.findIndex(open => open.src === popup.url()));
      const [{ name, closed }] = opened.splice(index, 1);
      if (closed) {
        void close(popup);
        continue;
      }
      const previous = windows.get(name);
      windows.set(name, popup);
      if (previous !== popup) void close(previous);
    }
  };

  await page.exposeFunction('__wxa_webview_window_event__', (type: 'open' | 'close', name: string, src?: string) => {
    if (type === 'open') {
      opened.push({ name, src: src ?? '', closed: false });
      pair();
      return;
    }
    // 还没等到 popup 事件就关了：配对时再关
    const pending = opened.find(open => open.name === name);
    if (pending) pending.closed = true;
    void close(windows.get(name));
    windows.delete(name);
  });
  await page.addInitScript(() => {
    window.__wxa_webview_window__ = true;
  });
  page.on('popup', popup => {
    popups.push(popup);
    pair();
  });

  return {
    get(name: string): Page | undefined {
      const popup = windows.get(name);
      return popup && !popup.isClosed() ? popup : undefined;
    },
    async closeAll() {
      const all = [...windows.values(), ...popups.splice(0)];
      windows.clear();
      opened.length = 0;
      await Promise.all(all.map(close));
    }
  };
}

/** 等小程序启动完成；启动失败时返回模拟器上显示的错误 */
function waitForLaunch(): Promise<string | null> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (error: string | null) => {
      settled = true;
      resolve(error);
    };
    window.__wxa_test_api__?.ready.then(() => finish(null));
    const poll = () => {
      if (settled) return;
      const shown = document.querySelector('.wxa-error');
      if (shown) finish(shown.textContent || '');
      else setTimeout(poll, 50);
    };
    poll();
  });
}

export async function createMiniProgram(page: Page, { baseURL, listPages, webViewWindow = false }: MiniProgramOptions): Promise<MiniProgramSession> {
  const operations: Operation[] = [];
  /** Node 里的处理函数。撤销后也保留：撤销前已经发出的调用仍由它处理 */
  const handlers = new Map<number, { source: string; run: (args: any[]) => unknown }>();
  const handlerErrors: Array<{ source: string; error: unknown }> = [];
  /** 本用例之前加载的页面上记录的错误：整页重新加载后宿主重建，要在离开前取出来 */
  const earlierErrors: FrameError[] = [];

  const addHandler = (source: string, run: (args: any[]) => unknown) => {
    const id = handlers.size + 1;
    handlers.set(id, { source, run });
    return id;
  };

  await page.exposeFunction(BRIDGE, async (kind: 'operations' | 'call', id?: number, args: any[] = []) => {
    if (kind === 'operations') return operations;
    const handler = handlers.get(id!)!;
    try {
      return await handler.run(args);
    } catch (error) {
      handlerErrors.push({ source: handler.source, error });
      throw error;
    }
  });
  await page.addInitScript(installInPage, { bridge: BRIDGE, binaryBody: BINARY_BODY });

  const windows = webViewWindow ? await trackWebViewWindows(page) : null;

  /** 已经打开的页面上立即执行（规则写错等在这里报错），再记下来供之后加载页面时重放 */
  const declare = async (operation: Operation) => {
    await page.evaluate(op => {
      const api = window.__wxa_test_api__;
      const replay = (window as any).__wxa_playwright_replay__;
      if (api && replay) replay(api, [op]);
    }, operation);
    operations.push(operation);
  };

  const currentErrors = () => page.evaluate(() => window.__wxa_test_api__?.errors() ?? []).catch((): FrameError[] => []);

  const forward = <K extends keyof ForwardedApi>(name: K) =>
    ((...args: unknown[]) => page.evaluate(([n, a]) => {
      const api = window.__wxa_test_api__;
      if (!api) throw new Error('小程序还没有打开，先调用 miniProgram.open()');
      return (api[n] as (...args: unknown[]) => unknown)(...a);
    }, [name, args] as const)) as unknown as ForwardedApi[K];

  const requests = async (pattern?: string) => {
    const recorded: RecordedRequest[] = await page.evaluate(p => {
      if (!window.__wxa_test_api__) throw new Error('小程序还没有打开，先调用 miniProgram.open()');
      return (window as any).__wxa_playwright_requests__(p);
    }, pattern);
    return recorded.map(fromPage);
  };

  const miniProgram: MiniProgram = {
    current: page.frameLocator('iframe[data-current]'),

    async open(url = '') {
      // 参数值里也可能有 ?，只按第一个分开
      const queryStart = url.indexOf('?');
      const path = (queryStart < 0 ? url : url.slice(0, queryStart)).replace(/^\/+/, '').replace(/\.html$/, '');
      const query = queryStart < 0 ? '' : url.slice(queryStart + 1);
      const pages = path ? await listPages() : null;
      // 宿主找不到页面时会打开首页，用例就在错误的页面上继续执行
      if (pages && !pages.includes(path)) throw new Error(`页面 ${path} 不在 app.json 的 pages 里`);

      earlierErrors.push(...await currentErrors());
      // 宿主离开时自己会关掉网页窗口；网页设置了 Cross-Origin-Opener-Policy 时宿主拿不到窗口，这里兜底
      await windows?.closeAll();
      const search = [path && `path=${encodeURIComponent(path)}`, query].filter(Boolean).join('&');
      await page.goto(`${baseURL}/${search ? `?${search}` : ''}`);
      // 编译失败时测试 API 不会安装，只显示错误
      await page.waitForFunction(() => window.__wxa_test_api__ || document.querySelector('.wxa-error'));
      const error = await page.evaluate(waitForLaunch);
      if (error !== null) throw new Error(`小程序启动失败：\n${error}`);
    },

    async mock(api, impl) {
      if (typeof impl !== 'function') return declare({ type: 'mock', api, result: impl });
      if (api.endsWith('Sync') || SYNC_APIS.has(api)) {
        throw new Error(`wx.${api} 由基础库同步调用，只能 mock 成固定的结果对象：Node 里的函数只能异步返回结果`);
      }
      const handler = addHandler(`mock('${api}')`, ([args, context]) => impl(args, context));
      return declare({ type: 'mock', api, handler });
    },

    unmock: api => declare({ type: 'unmock', api }),

    async route(pattern, handler) {
      if (typeof handler !== 'function') return declare({ type: 'route', pattern, response: encodeBinaryBody(handler) });
      const id = addHandler(`route('${pattern}')`, async ([request]) => encodeBinaryBody(await handler(fromPage({ ...request, routedBy: pattern }))));
      return declare({ type: 'route', pattern, handler: id });
    },

    unroute: pattern => declare({ type: 'unroute', pattern }),

    requests,

    async waitForRequest(pattern, { timeout = DEFAULT_REQUEST_TIMEOUT } = {}) {
      const deadline = Date.now() + timeout;
      for (;;) {
        const matched = await requests(pattern);
        if (matched.length) return matched[matched.length - 1];
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      const sent = (await requests()).map(request => `  ${request.method} ${request.url}`);
      throw new Error(`等待请求 ${pattern} 超时（${timeout}ms）。已发出的请求：\n${sent.join('\n') || '  （无）'}`);
    },

    errors: async () => [...earlierErrors, ...await currentErrors()],

    async webView({ index, timeout = DEFAULT_WEB_VIEW_TIMEOUT } = {}) {
      if (!windows) {
        throw new Error("webView() 只在新窗口模式下可用：test.use({ wxaWebView: 'window' })。默认模式下网页在 miniProgram.current.frameLocator('iframe') 里");
      }
      const deadline = Date.now() + timeout;
      for (;;) {
        const views = await miniProgram.webViews();
        if (views.length > 1 && index === undefined) {
          throw new Error(`当前页有 ${views.length} 个 web-view，用 webView({ index }) 指定第几个（从 0 开始）：\n${views.map((view, i) => `  ${i}: ${view.src}`).join('\n')}`);
        }
        if (index !== undefined && views.length && (index < 0 || index >= views.length)) {
          throw new Error(`当前页只有 ${views.length} 个 web-view，index 应在 0 到 ${views.length - 1} 之间`);
        }
        const name = views[index ?? 0]?.windowName;
        const found = name ? windows.get(name) : undefined;
        if (found) return found;
        if (Date.now() >= deadline) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(
        `等待 web-view 的网页窗口超时（${timeout}ms）。可能的原因：\n` +
          '  - 当前页没有 web-view，或 web-view 还没有设置 src\n' +
          '  - 弹出窗口被浏览器拦截：Playwright 启动浏览器时默认带 --disable-popup-blocking，配置里用 ignoreDefaultArgs 去掉了它\n' +
          '  - 网页窗口已被关闭'
      );
    },

    currentPage: forward('currentPage'),
    pageStack: forward('pageStack'),
    webViews: forward('webViews'),
    waitForPage: forward('waitForPage'),
    pageData: forward('pageData'),
    callPageMethod: forward('callPageMethod'),
    navigateTo: forward('navigateTo'),
    navigateBack: forward('navigateBack'),
    redirectTo: forward('redirectTo'),
    reLaunch: forward('reLaunch'),
    switchTab: forward('switchTab'),
    getStorage: forward('getStorage'),
    clearStorage: forward('clearStorage'),
    clearRequests: forward('clearRequests')
  };

  return {
    miniProgram,
    throwHandlerError() {
      if (!handlerErrors.length) return;
      const { source, error } = handlerErrors[0];
      const wrapped = new Error(`${source} 的处理函数出错：${error instanceof Error ? error.message : String(error)}`);
      if (error instanceof Error && error.stack) wrapped.stack = `${wrapped.message}\n${error.stack.split('\n').slice(1).join('\n')}`;
      throw wrapped;
    }
  };
}
