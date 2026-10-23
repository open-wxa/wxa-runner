/**
 * 宿主：管理逻辑层 iframe 和各页面的渲染层 iframe
 *
 * 宿主不实现页面生命周期——它只维护页面栈并在路由变化时派发 onAppRoute，
 * App/Page 的生命周期全部由官方基础库根据这个事件驱动。
 */

import type { ConsoleLevel } from '../consoleHook';
import type { AppInfo, ForwardConsole, FrameBridge, FrameKind, HostApi, InvokeCallback } from '../types';
import { ConsoleForwarder, ConsoleReport } from './ConsoleForwarder';
import { ApiContext, ApiRegistry, ApiResult, fail, ok } from './api/registry';
import { createAudioApis } from './api/audio';
import { createFileSystemApis } from './api/fs';
import { createLibFileApis } from './api/libFiles';
import { createMapApis, MapOperations } from './api/map';
import { createMediaApis } from './api/media';
import { createMiscApis } from './api/misc';
import { createNetworkApis, RequestLog } from './api/network';
import { createPickerApis, fetchRegionData } from './api/picker';
import { RequestRoutes } from './api/routes';
import { createSavedFileApis } from './api/savedFiles';
import { createStorageApis, MiniProgramStorage } from './api/storage';
import { createSubpackageApis } from './api/subpackages';
import { createSystemApis } from './api/system';
import { tempFileRootPath } from './api/tempFiles';
import { createUiApis } from './api/ui';
import { createWebViewApis } from './api/webView';
import { PageStack } from './PageStack';
import { PageView } from './PageView';
import { cloneInto, cloneNativeInto } from './realm';
import { chooseFiles, hasUserActivation } from './ui/fileChooser';
import { NavigationState, PhoneShell } from './ui/PhoneShell';

export type OpenType = 'appLaunch' | 'navigateTo' | 'navigateBack' | 'redirectTo' | 'reLaunch' | 'switchTab';

export interface LaunchTarget {
  path: string;
  query: Record<string, string>;
}

export interface FrameError {
  kind: FrameKind;
  webviewId: number;
  message: string;
  stack?: string;
  /** 调用了未实现的原生 API 时为 API 名称 */
  api?: string;
}

const ROUTE_DONE_DELAY = 300;
const PAGE_LOAD_TIMEOUT = 15000;
/** 基础库建在逻辑层里、要搬进页面的画布类型；旧版 canvas-id 画布在渲染层里画 */
const BINDING_CANVAS_TYPES = new Set(['2d', 'webgl', 'webgl2']);
/** placeCanvas 探测用的 top，不会是真实位置。读回 style.top 时浏览器只保留 6 位有效数字，所以用位数少的整数 */
const PROBE_TOP = -54321;

interface CanvasBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface CanvasRecord {
  webviewId: number;
  type: string;
  box: CanvasBox;
  placed: boolean;
}

/** 渲染层的 canvasInserted / canvasUpdated / canvasRemoved 消息里的 data */
type CanvasMessage = Partial<CanvasBox> & { canvasNumber: number; type?: string; isXrFrame?: boolean };

export class Host implements HostApi {
  readonly device;
  readonly errors: FrameError[] = [];
  /** 小程序发出的 wx.request */
  readonly requests = new RequestLog();
  readonly api = new ApiRegistry(context => this.reportUnimplemented(context));
  readonly shell: PhoneShell;
  readonly storage: MiniProgramStorage;
  /** setup 和测试 API 声明的请求拦截 */
  readonly routes = new RequestRoutes();
  private readonly mapOperations = new MapOperations((webviewId, event, data) => this.publishToPages(event, data, [webviewId]));
  private service: { win: Window; bridge: FrameBridge } | null = null;
  /** 新版基础库的业务子上下文；旧版基础库业务代码直接在逻辑层 iframe 里 */
  private appContext: Window | null = null;
  private serviceLoaded!: () => void;
  private readonly serviceReady = new Promise<void>(resolve => {
    this.serviceLoaded = resolve;
  });
  private readonly pages = new Map<number, PageView>();
  private readonly tabPages = new Map<string, PageView>();
  private readonly stack = new PageStack<PageView>();
  private readonly tabPaths: Set<string>;
  private nextWebviewId = 1;
  private routeChain: Promise<unknown> = Promise.resolve();
  private routeListeners: Array<(page: PageView, openType: OpenType) => void> = [];
  /** 渲染层报来的 2d、webgl 画布，按编号记下所在页面和最近的位置，供 placeCanvas 认出逻辑层的画布元素 */
  private readonly canvases = new Map<number, CanvasRecord>();
  private readonly forwarder: ConsoleForwarder;

  /** @param sendReport 把报错发给开发服务器打印到终端，见 AppInfo.forwardConsole */
  constructor(readonly info: AppInfo, root: HTMLElement, sendReport: (report: ConsoleReport) => void = () => undefined) {
    this.device = info.device;
    this.forwarder = new ConsoleForwarder(info.forwardConsole ?? false, sendReport, (kind, webviewId) =>
      kind === 'service' ? this.currentPage()?.path : this.pages.get(webviewId)?.path
    );
    this.shell = new PhoneShell(root, info.device);
    this.tabPaths = new Set((info.wxConfig.tabBar?.list || []).map((item: any) => stripHtml(item.pagePath)));
    this.storage = new MiniProgramStorage(window.localStorage, info.appid);

    const tabBar = info.wxConfig.tabBar
      ? { ...info.wxConfig.tabBar, list: info.wxConfig.tabBar.list.map((item: any) => ({ ...item, pagePath: stripHtml(item.pagePath) })) }
      : undefined;
    this.shell.setTabBar(tabBar, pagePath => this.enqueueRoute(() => this.switchTab(pagePath)));
    this.shell.onBack(() => this.enqueueRoute(() => this.navigateBack(1)));

    this.registerApis();
  }

  async start(target: LaunchTarget) {
    const frame = document.createElement('iframe');
    frame.name = 'wxa-appservice';
    frame.style.display = 'none';
    const params = new URLSearchParams({ v: String(this.info.version), path: target.path, query: new URLSearchParams(target.query).toString() });
    frame.src = `/__wxa__/appservice.html?${params}`;
    document.body.appendChild(frame);

    document.addEventListener('visibilitychange', () => {
      const page = this.currentPage();
      if (!page) return;
      const event = document.hidden ? 'onAppEnterBackground' : 'onAppEnterForeground';
      this.emitToService(event, { path: page.path, query: page.query, scene: 1001, referrerInfo: {} });
    });

    await this.serviceReady;
    await this.enqueueRoute(() => this.launch(target));
  }

  // ---------------------------------------------------------------------------
  // HostApi：供 iframe 内的桥调用
  // ---------------------------------------------------------------------------

  registerFrame(kind: FrameKind, win: Window, bridge: FrameBridge, webviewId: number) {
    if (kind === 'service') {
      this.service = { win, bridge };
    } else {
      this.pages.get(webviewId)?.attach(win, bridge);
    }
  }

  registerAppContext(win: Window | null) {
    this.appContext = win;
  }

  /**
   * 逻辑层的画布元素上没有编号，只能问基础库：给每个还没放好的同类型画布发一条 top 带记号的 canvasUpdated，
   * 基础库把位置写到那个编号的元素上，记号落在这个元素上就是它；随后用原来的位置再发一次，恢复原样。
   * 基础库只在类型与画布一致时才调到元素的 getContext，按类型筛选不会漏掉
   */
  placeCanvas(canvas: HTMLCanvasElement, type: string) {
    const service = this.service;
    if (!service) return;
    const update = (canvasNumber: number, record: CanvasRecord, top: number) => service.bridge.__dispatchSub(
      'canvasUpdated',
      this.cloneForService({ data: { canvasNumber, ...record.box, top }, options: { timestamp: Date.now() } }),
      record.webviewId
    );
    for (const [canvasNumber, record] of this.canvases) {
      if (record.placed || record.type !== type) continue;
      update(canvasNumber, record, PROBE_TOP);
      const matched = canvas.style.top === `${PROBE_TOP}px`;
      update(canvasNumber, record, record.box.top);
      if (matched) {
        record.placed = this.pages.get(record.webviewId)?.placeCanvas(canvas, canvasNumber) ?? false;
        return;
      }
    }
  }

  frameLoaded(kind: FrameKind, webviewId: number) {
    if (kind === 'service') this.serviceLoaded();
    else this.pages.get(webviewId)?.loaded();
  }

  invoke(kind: FrameKind, win: Window, api: string, args: unknown, callback?: InvokeCallback) {
    const webviewId = kind === 'webview' ? this.webviewIdOf(win) : this.currentPage()?.id ?? 0;
    const result = this.api.invoke(api, args, { api, from: kind, webviewId });
    const deliver = (res: ApiResult | string) => {
      if (callback) callback(cloneNativeInto(kind === 'service' ? this.serviceWindow()! : win, res));
    };

    if (result && typeof (result as Promise<ApiResult>).then === 'function') {
      (result as Promise<ApiResult | string>).then(deliver);
    } else {
      deliver(result as ApiResult | string);
    }
  }

  publish(kind: FrameKind, win: Window, event: string, data: unknown, webviewIds?: number[]) {
    if (kind === 'service') {
      this.publishToPages(event, data, webviewIds);
      return;
    }
    if (event === 'operateMapCallback' && this.mapOperations.receive(data)) return;

    const fromId = this.webviewIdOf(win);
    this.trackCanvas(event, (data as { data?: CanvasMessage } | null)?.data, fromId);
    const service = this.service;
    if (!service) return;
    const payload = this.cloneForService(data);
    queueMicrotask(() => service.bridge.__dispatchSub(event, payload, fromId));
  }

  /**
   * xr-frame 的画布不记：基础库收到它的 canvasUpdated 会派发 resize 给 xr-frame，探测会带来多余的 resize，
   * 而 xr-frame 在 wxa-runner 里没有验证过，保持原样
   */
  private trackCanvas(event: string, data: CanvasMessage | undefined, webviewId: number) {
    if (!data) return;
    const record = this.canvases.get(data.canvasNumber);
    if (event === 'canvasInserted' && data.type && BINDING_CANVAS_TYPES.has(data.type) && !data.isXrFrame) {
      this.canvases.set(data.canvasNumber, { webviewId, type: data.type, box: { top: 0, left: 0, width: 0, height: 0, ...boxOf(data) }, placed: false });
    } else if (event === 'canvasUpdated' && record) {
      // 有的 canvasUpdated 只带宽高，没带的字段保留原值
      record.box = { ...record.box, ...boxOf(data) };
    } else if (event === 'canvasRemoved') {
      this.canvases.delete(data.canvasNumber);
    }
  }

  /** 不指定目标时发给所有页面：旧版 canvas 的绘制指令就是这样发的，由 canvasNumber 找到对应画布 */
  private publishToPages(event: string, data: unknown, webviewIds?: number[]) {
    const targets = webviewIds?.length ? webviewIds.map(id => this.pages.get(Number(id))) : this.livePages();
    const message = event === 'canvasActionsChanged' ? withDrawableImages(data) : data;
    for (const page of targets) {
      page?.dispatch((bridge, target) => {
        const payload = cloneInto(target, message);
        queueMicrotask(() => bridge.__dispatchSub(event, payload, 0));
      });
    }
  }

  reportError(kind: FrameKind, webviewId: number, error: unknown) {
    // 错误对象来自 iframe，跨 realm 的 instanceof Error 不成立；DOMException 等也不是 Error 的实例
    const err = typeof (error as Error | null)?.message === 'string' ? error as Error : null;
    const report: FrameError = {
      kind,
      webviewId,
      message: err ? err.message : String(error),
      stack: typeof err?.stack === 'string' ? err.stack : undefined
    };
    this.errors.push(report);
    this.forwarder.error(kind, webviewId, report.message, report.stack);
  }

  get forwardConsole(): ForwardConsole {
    return this.forwarder.mode;
  }

  reportConsole(kind: FrameKind, webviewId: number, level: ConsoleLevel, args: unknown[]) {
    this.forwarder.console(kind, webviewId, level, args);
  }

  /**
   * 业务代码只运行在逻辑层，所以只记逻辑层调用、名字在 wx 上的 API，每个 API 一次。
   * 其余是基础库内部调用的原生接口（如 getPermissionBytes），业务既没调用也 mock 不了
   */
  private reportUnimplemented({ api, from }: ApiContext) {
    const wx = (this.serviceWindow() as any)?.wx;
    if (from !== 'service' || typeof wx?.[api] !== 'function') return;
    if (this.errors.some(error => error.api === api)) return;
    const message = `wx.${api} 尚未实现，返回了默认成功。可以用 mock 覆盖，启动阶段就调用的要在 setup 里 mock`;
    this.errors.push({ kind: 'service', webviewId: 0, api, message });
    this.forwarder.warn(message);
  }

  // ---------------------------------------------------------------------------
  // 路由
  // ---------------------------------------------------------------------------

  currentPage(): PageView | undefined {
    return this.stack.current();
  }

  pageStack(): PageView[] {
    return this.stack.entries();
  }

  /** 所有活着的页面：页面栈加上隐藏中的 tabBar 页面 */
  livePages(): PageView[] {
    return [...this.pages.values()];
  }

  /** 业务代码所在的 window：getCurrentPages / wx 等在它上面 */
  serviceWindow(): Window | null {
    return this.appContext ?? this.service?.win ?? null;
  }

  /**
   * 交给逻辑层的值属于业务代码所在的全局环境，而不是逻辑层 iframe：新版基础库不一定在业务子上下文里
   * 重建这些值，属于别的 iframe 的对象在业务代码里 instanceof 不成立，setData 也会把这样的数组当成普通对象
   */
  private cloneForService<T>(value: T): T {
    return cloneInto(this.serviceWindow()!, value);
  }

  onRoute(listener: (page: PageView, openType: OpenType) => void) {
    this.routeListeners.push(listener);
  }

  /** 路由操作串行执行，避免连续跳转时页面栈错乱 */
  enqueueRoute<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.routeChain.then(operation, operation);
    this.routeChain = run.catch(() => undefined);
    return run;
  }

  private async launch(target: LaunchTarget) {
    const page = await this.openPage(target.path, target.query);
    this.stack.reset(page);
    this.activate(page, 'appLaunch');
  }

  async navigateTo(url: string): Promise<ApiResult> {
    if (!this.stack.canPush()) return fail('navigateTo', 'webview count limit exceed');
    const { path, query } = this.resolveUrl(url);
    if (this.tabPaths.has(path)) return fail('navigateTo', 'can not navigateTo a tabbar page');
    if (!this.hasPage(path)) return fail('navigateTo', `page "${path}" is not found`);

    const page = await this.openPage(path, query);
    this.stack.push(page);
    this.activate(page, 'navigateTo');
    return ok('navigateTo', { webviewId: page.id });
  }

  async navigateBack(delta: number): Promise<ApiResult> {
    if (this.stack.size <= 1) return fail('navigateBack', 'cannot navigate back at first page.');
    this.stack.pop(delta).forEach(page => this.closePage(page));
    this.activate(this.currentPage()!, 'navigateBack');
    return ok('navigateBack');
  }

  async redirectTo(url: string): Promise<ApiResult> {
    const { path, query } = this.resolveUrl(url);
    if (this.tabPaths.has(path)) return fail('redirectTo', 'can not redirectTo a tabbar page');
    if (!this.hasPage(path)) return fail('redirectTo', `page "${path}" is not found`);

    const page = await this.openPage(path, query);
    const previous = this.stack.replaceTop(page);
    if (previous) this.closePage(previous);
    this.activate(page, 'redirectTo');
    return ok('redirectTo');
  }

  async reLaunch(url: string): Promise<ApiResult> {
    const { path, query } = this.resolveUrl(url);
    if (!this.hasPage(path)) return fail('reLaunch', `page "${path}" is not found`);

    const page = await this.openPage(path, query, { reuseTab: false });
    this.stack.reset(page).forEach(previous => this.closePage(previous, { keepTab: false }));
    for (const [tabPath, tabPage] of this.tabPages) {
      if (tabPage !== page) {
        this.closePage(tabPage, { keepTab: false });
        this.tabPages.delete(tabPath);
      }
    }
    this.activate(page, 'reLaunch');
    return ok('reLaunch');
  }

  async switchTab(url: string): Promise<ApiResult> {
    const { path } = this.resolveUrl(url);
    if (!this.tabPaths.has(path)) return fail('switchTab', 'can not switch to no-tabBar page');
    if (this.currentPage()?.path === path && this.stack.size === 1) return ok('switchTab');

    const page = await this.openPage(path, {});
    this.stack.reset(page).forEach(previous => this.closePage(previous));
    this.activate(page, 'switchTab');
    return ok('switchTab');
  }

  private async openPage(path: string, query: Record<string, string>, options = { reuseTab: true }): Promise<PageView> {
    const isTab = this.tabPaths.has(path);
    if (isTab && options.reuseTab && this.tabPages.has(path)) {
      return this.tabPages.get(path)!;
    }

    const page = new PageView(
      this.nextWebviewId++,
      path,
      query,
      this.shell.pages,
      this.info.version,
      this.navigationFor(path)
    );
    // 渲染层注册桥时（基础库加载前）写入，首屏就按正确的安全区排版
    page.setSafeAreaInsets(this.shell.safeAreaInsetsFor(path, page.navigation));
    this.pages.set(page.id, page);
    if (isTab) this.tabPages.set(path, page);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<void>(resolve => {
      timer = setTimeout(() => {
        console.error(`[wxa-runner] 页面 ${path} 的渲染层 ${PAGE_LOAD_TIMEOUT}ms 内没有加载完成，请检查控制台报错`);
        resolve();
      }, PAGE_LOAD_TIMEOUT);
    });
    await Promise.race([page.ready, timedOut]);
    clearTimeout(timer);
    return page;
  }

  private closePage(page: PageView, options = { keepTab: true }) {
    if (options.keepTab && this.tabPaths.has(page.path) && this.tabPages.get(page.path) === page) {
      page.hide();
      return;
    }
    if (this.tabPages.get(page.path) === page) this.tabPages.delete(page.path);
    this.pages.delete(page.id);
    page.destroy();
    // 页面直接关掉时渲染层不一定发 canvasRemoved
    for (const [canvasNumber, record] of this.canvases) {
      if (record.webviewId === page.id) this.canvases.delete(canvasNumber);
    }
  }

  private activate(page: PageView, openType: OpenType) {
    for (const other of this.pages.values()) {
      if (other !== page) other.hide();
    }
    page.show();

    page.navigation = { ...page.navigation, showBack: this.stack.size > 1 };
    this.shell.setNavigation(page.navigation);
    this.shell.renderTabBar(this.tabPaths.has(page.path) ? page.path : null);
    this.shell.setRoute(page.url);
    this.updateLocation(page);

    const data = { path: page.path, query: page.query, openType, webviewId: page.id };
    this.emitToService('onAppRoute', data, page.id);
    setTimeout(() => {
      // 期间又发生了路由时，基础库会把迟到的 routeDone 当作错误
      if (this.currentPage() === page) this.emitToService('onAppRouteDone', data, page.id);
    }, ROUTE_DONE_DELAY);
    this.routeListeners.forEach(listener => listener(page, openType));
  }

  /** 宿主地址栏同步为当前页面，刷新后可回到同一页面 */
  private updateLocation(page: PageView) {
    const params = new URLSearchParams(location.search);
    params.set('path', page.path);
    for (const key of [...params.keys()]) {
      if (key !== 'path') params.delete(key);
    }
    for (const [key, value] of Object.entries(page.query)) params.set(key, value);
    history.replaceState(null, '', `${location.pathname}?${params}`);
  }

  private navigationFor(path: string): NavigationState {
    const window = {
      ...this.info.wxConfig.global?.window,
      ...this.info.wxConfig.page?.[path + '.html']?.window
    };
    return {
      title: window.navigationBarTitleText || '',
      backgroundColor: window.navigationBarBackgroundColor || '#000000',
      textStyle: window.navigationBarTextStyle === 'black' ? 'black' : 'white',
      showBack: false,
      custom: window.navigationStyle === 'custom'
    };
  }

  private hasPage(path: string): boolean {
    return this.info.pages.includes(path);
  }

  /**
   * 基础库调用路由 API 前已经把相对路径解析成根路径并加上 .html（如 "pages/a/a.html?id=1"），
   * 这里只做格式归一。
   */
  resolveUrl(url: string): { path: string; query: Record<string, string> } {
    const [rawPath, rawQuery = ''] = String(url || '').split('?');
    const path = stripHtml(rawPath.replace(/^\/+/, ''));
    return { path, query: Object.fromEntries(new URLSearchParams(rawQuery)) };
  }

  // ---------------------------------------------------------------------------
  // 事件
  // ---------------------------------------------------------------------------

  emitToService(event: string, data: unknown, webviewId?: number) {
    const service = this.service;
    if (!service) return;
    const payload = cloneNativeInto(this.serviceWindow()!, data);
    queueMicrotask(() => service.bridge.__dispatchOn(event, payload, webviewId));
  }

  /** 派发给渲染层的原生事件（渲染层里 WeixinJSBridge.on 收到） */
  emitToWebview(webviewId: number, event: string, data: unknown) {
    this.pages.get(webviewId)?.dispatch((bridge, target) => {
      const payload = cloneNativeInto(target, data);
      queueMicrotask(() => bridge.__dispatchOn(event, payload, webviewId));
    });
  }

  private webviewIdOf(win: Window): number {
    for (const page of this.pages.values()) {
      if (page.win === win) return page.id;
    }
    return 0;
  }

  private updateNavigation(state: Partial<NavigationState>) {
    const page = this.currentPage();
    if (!page) return;
    page.navigation = { ...page.navigation, ...Object.fromEntries(Object.entries(state).filter(([, v]) => v !== undefined)) };
    this.shell.setNavigation(page.navigation);
  }

  private registerApis() {
    const routeApi = (handler: (args: any) => Promise<ApiResult>) =>
      (args: any) => this.enqueueRoute(() => handler(args));

    this.api.register({
      navigateTo: routeApi(args => this.navigateTo(args.url)),
      navigateBack: routeApi(args => this.navigateBack(args.delta || 1)),
      redirectTo: routeApi(args => this.redirectTo(args.url)),
      reLaunch: routeApi(args => this.reLaunch(args.url)),
      switchTab: routeApi(args => this.switchTab(args.url)),
      ...createStorageApis(this.storage),
      ...createSubpackageApis({
        subPackages: this.info.wxConfig.subPackages || [],
        workers: this.info.wxConfig.workers,
        emit: (event, data) => this.emitToService(event, data)
      }),
      ...createSavedFileApis(this.storage),
      ...createFileSystemApis(),
      ...createSystemApis({
        device: this.device,
        baseLibVersion: this.info.baseLibVersion,
        windowHeight: () => this.shell.windowHeight(),
        screenTop: () => this.shell.screenTop()
      }),
      ...createNetworkApis({
        emit: (event, data) => this.emitToService(event, data),
        defaultTimeout: () => this.info.wxConfig.networkTimeout?.request || 60000,
        routes: this.routes,
        onRequest: request => this.requests.add(request)
      }),
      ...createAudioApis({ emit: (event, data) => this.emitToService(event, data) }),
      ...createMapApis({ registry: this.api, operations: this.mapOperations }),
      ...createLibFileApis({ windowOf: webviewId => this.pages.get(webviewId)?.win }),
      ...createUiApis({ shell: this.shell, updateNavigation: state => this.updateNavigation(state) }),
      ...createMediaApis({
        showActionSheet: options => this.shell.showActionSheet(options),
        chooseFiles,
        hasUserActivation,
        showImagePreview: (urls, current) => this.shell.showImagePreview(urls, current)
      }),
      ...createPickerApis({
        showPicker: options => this.shell.showPicker(options),
        emitToWebview: (webviewId, event, data) => this.emitToWebview(webviewId, event, data),
        loadRegionData: fetchRegionData
      }),
      ...createWebViewApis({
        documentOf: webviewId => this.pages.get(webviewId)?.win?.document,
        emitToWebview: (webviewId, event, data) => this.emitToWebview(webviewId, event, data)
      }),
      ...createMiscApis(this.info.appid, {
        devtoolsLogin: this.info.devtoolsLogin,
        onDevtoolsLoginFail: (api, reason) => this.shell.showNotice(`wx.${api} 借用开发者工具登录态失败`, reason)
      })
    });
  }
}

/**
 * 旧版 canvas 的绘制指令里，drawImage 用到的临时文件换成根路径。基础库的网页实现把 http(s) 地址
 * 都当成网络图片直接跳过（只放行开发者工具的 http://tmp/ 等），不报错，画布上什么也没有
 */
function withDrawableImages(message: any): unknown {
  const actions = message?.data?.actions;
  if (!Array.isArray(actions)) return message;
  return {
    ...message,
    data: {
      ...message.data,
      actions: actions.map(action => {
        const [src, ...rest] = action.data ?? [];
        return action.method === 'drawImage' && typeof src === 'string'
          ? { ...action, data: [tempFileRootPath(src), ...rest] }
          : action;
      })
    }
  };
}

/** 消息里带了的位置字段 */
function boxOf(data: CanvasMessage): Partial<CanvasBox> {
  const box: Partial<CanvasBox> = {};
  for (const key of ['top', 'left', 'width', 'height'] as const) {
    if (data[key] !== undefined) box[key] = data[key];
  }
  return box;
}

function stripHtml(path: string): string {
  return path.replace(/\.html$/, '');
}
