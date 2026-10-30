/**
 * window.__wxa_test_api__：给 E2E 测试（Playwright 等）使用的钩子
 */

import type { RouteHandler } from '../../setup';
import type { RecordedRequest } from './api/network';
import type { WebViewInfo } from './api/webView';
import type { ApiHandler, ApiResult } from './api/registry';
import { compilePattern } from './api/routes';
import { decodeStorageValue } from './api/storage';
import type { FrameError, Host } from './Host';
import { cloneInto } from './realm';
import { TASK_APIS } from './setup';

export type { RecordedRequest, WebViewInfo };

export interface PageSnapshot {
  webviewId: number;
  /** 页面路径，如 pages/index/index，不带开头的 / */
  path: string;
  query: Record<string, string>;
  /** 渲染层 iframe 的 name，可用于 page.frame({ name }) */
  frameName: string;
}

export interface WxaTestApi {
  /** 小程序启动完成（首页加载完、整页刷新后页面栈恢复完）后 resolve。setup 或启动前的准备出错时不会 resolve，模拟器显示错误 */
  ready: Promise<void>;
  /** 当前页，即页面栈顶；小程序启动前为 null */
  currentPage(): PageSnapshot | null;
  /** 整个页面栈，栈底在前 */
  pageStack(): PageSnapshot[];
  /**
   * 当前页里设置过 src 的 web-view，按创建顺序；小程序启动前为空数组。
   * 新窗口模式下 windowName 是网页所在窗口的 name，可以用它找到这个窗口；iframe 模式下为 null
   */
  webViews(): WebViewInfo[];
  /**
   * 等到指定页面成为当前页，已经是当前页时立即返回
   * @param path 页面路径，如 pages/index/index，开头的 / 可有可无
   * @param timeout 毫秒，默认 10000
   * @throws 超时
   */
  waitForPage(path: string, timeout?: number): Promise<PageSnapshot>;
  /**
   * 页面的 data，是一份拷贝，修改它不影响页面
   * @param path 不传时读当前页；传页面路径时读页面栈里离栈顶最近的这个页面
   * @returns 页面不在页面栈里，或逻辑层还没创建它（刚跳转时）时为 null
   */
  pageData(path?: string): Record<string, unknown> | null;
  /**
   * 调用当前页的方法，如 callPageMethod('onPullDownRefresh')。方法返回 Promise 时等它完成
   * @param args 要能 JSON 序列化
   * @returns 方法的返回值
   * @throws 当前页还没创建、没有这个方法，或者方法抛错时
   */
  callPageMethod(name: string, ...args: unknown[]): Promise<unknown>;
  /**
   * 覆盖原生 API，同名的 setup mock 也被覆盖。整页刷新后失效
   * @param api 与 wx 上的名字相同，如 login、getLocation
   * @param impl 对象作为调用结果；函数按调用参数返回结果，可以返回 Promise，抛错即调用失败
   * @throws api 是 request、downloadFile 等由基础库任务实现的 API 时：mock 不会生效，wx.request 要用 route 拦截
   */
  mock(api: string, impl: ApiHandler | ApiResult): void;
  /** 撤销 mock，恢复内置实现；不传 api 时撤销全部，包括 setup 声明的 */
  unmock(api?: string): void;
  /**
   * 拦截 wx.request：命中的请求不发往网络，直接返回给定的响应。写法与 setup 的 network.routes 相同，后添加的规则优先。整页刷新后失效
   * @param pattern '[请求方法 ]地址'，如 'POST https://api.example.com/login'；* 匹配一段路径，** 匹配任意内容（可以不写域名）
   * @param handler 响应 { status?, header?, body?, delay? }，或按请求返回响应的函数
   * @throws 规则写法不对时
   */
  route(pattern: string, handler: RouteHandler): void;
  /** 删除按这个写法添加的拦截规则；不传时删除全部，包括 setup 声明的 */
  unroute(pattern?: string): void;
  /**
   * 小程序发出的 wx.request，按发出顺序，被拦截的和经代理转发的都有。只保留最近 1000 个，整页刷新后清空
   * @param pattern 只返回匹配的请求，写法同 route
   * @throws pattern 写法不对时
   */
  requests(pattern?: string): RecordedRequest[];
  /** 清空已记录的请求，常用于只关心某个操作之后发出的请求 */
  clearRequests(): void;
  /**
   * 打开新页面，同 wx.navigateTo
   * @param url 从小程序根目录写起，如 /pages/detail/detail?id=1
   * @returns 调用结果；失败时不抛错，errMsg 以 navigateTo:fail 开头说明原因
   */
  navigateTo(url: string): Promise<ApiResult>;
  /**
   * 返回上一页或多级页面，同 wx.navigateBack
   * @param delta 返回的层数，默认 1
   * @returns 调用结果；失败时不抛错，errMsg 说明原因
   */
  navigateBack(delta?: number): Promise<ApiResult>;
  /**
   * 关闭当前页，打开新页面，同 wx.redirectTo
   * @returns 调用结果；失败时不抛错，errMsg 说明原因
   */
  redirectTo(url: string): Promise<ApiResult>;
  /**
   * 关闭所有页面，打开新页面，同 wx.reLaunch
   * @returns 调用结果；失败时不抛错，errMsg 说明原因
   */
  reLaunch(url: string): Promise<ApiResult>;
  /**
   * 切换到 tabBar 页面，同 wx.switchTab
   * @returns 调用结果；失败时不抛错，errMsg 说明原因
   */
  switchTab(url: string): Promise<ApiResult>;
  /** 读取小程序的 Storage，值保持写入时的类型；没有这个 key 时为 undefined */
  getStorage(key: string): unknown;
  /** 清空小程序的 Storage。基础库会缓存读过的值，小程序启动后再清空，已读过的 key 可能仍读到旧值 */
  clearStorage(): void;
  /**
   * 逻辑层、渲染层的运行时错误，以及业务代码调用过的未实现 wx API（api 为 API 名称，每个 API 记一次）。
   * 这些都不会让测试失败，需要自己检查
   */
  errors(): FrameError[];
}

export function installTestApi(host: Host, ready: Promise<void>): WxaTestApi {
  const snapshot = (page: ReturnType<Host['currentPage']>): PageSnapshot | null =>
    page ? { webviewId: page.id, path: page.path, query: { ...page.query }, frameName: page.frame.name } : null;

  /** 逻辑层里的页面实例；同一页面打开多次时取离栈顶最近的 */
  const pageInstance = (path: string | undefined): any => {
    if (!path) return undefined;
    const pages: any[] = (host.serviceWindow() as any)?.getCurrentPages?.() || [];
    return [...pages].reverse().find(page => page.route === path);
  };

  const api: WxaTestApi = {
    ready,
    currentPage: () => snapshot(host.currentPage()),
    pageStack: () => host.pageStack().map(page => snapshot(page)!),
    webViews: () => {
      const page = host.currentPage();
      return page ? host.webViewsOf(page) : [];
    },
    waitForPage(path, timeout = 10000) {
      const target = path.replace(/^\//, '');
      return new Promise((resolve, reject) => {
        const current = host.currentPage();
        if (current?.path === target) return resolve(snapshot(current)!);
        const timer = setTimeout(() => reject(new Error(`等待页面 ${target} 超时`)), timeout);
        host.onRoute(page => {
          if (page.path === target) {
            clearTimeout(timer);
            resolve(snapshot(page)!);
          }
        });
      });
    },
    pageData(path) {
      const instance = pageInstance(path === undefined ? host.currentPage()?.path : host.resolveUrl(path).path);
      if (!instance) return null;
      // __webviewId__ 是基础库加进 data 的内部字段
      const { __webviewId__: _webviewId, ...data } = JSON.parse(JSON.stringify(instance.data));
      return data;
    },
    async callPageMethod(name, ...args) {
      const current = host.currentPage();
      if (!current) throw new Error('小程序还没有启动');
      const instance = pageInstance(current.path);
      if (!instance) throw new Error(`页面 ${current.path} 的逻辑层还没有创建`);
      if (typeof instance[name] !== 'function') throw new Error(`页面 ${current.path} 没有方法 ${name}`);
      return instance[name](...cloneInto(host.serviceWindow()!, args));
    },
    mock(name, impl) {
      if (TASK_APIS.has(name)) {
        throw new Error(`wx.${name} 由基础库内部的任务实现，mock 不会生效；wx.request 请用 route 拦截`);
      }
      host.api.mock(name, impl);
    },
    unmock: name => host.api.unmock(name),
    route: (pattern, handler) => host.routes.add(pattern, handler),
    unroute: pattern => host.routes.remove(pattern),
    requests(pattern) {
      const matches = pattern === undefined ? () => true : compilePattern(pattern);
      return host.requests.list().filter(matches);
    },
    clearRequests: () => host.requests.clear(),
    navigateTo: url => host.enqueueRoute(() => host.navigateTo(url)),
    navigateBack: (delta = 1) => host.enqueueRoute(() => host.navigateBack(delta)),
    redirectTo: url => host.enqueueRoute(() => host.redirectTo(url)),
    reLaunch: url => host.enqueueRoute(() => host.reLaunch(url)),
    switchTab: url => host.enqueueRoute(() => host.switchTab(url)),
    getStorage(key) {
      const item = host.storage.get('s0', key);
      return item ? decodeStorageValue(item) : undefined;
    },
    clearStorage: () => host.storage.clear('s0'),
    errors: () => [...host.errors]
  };

  (window as any).__wxa_test_api__ = api;
  return api;
}
