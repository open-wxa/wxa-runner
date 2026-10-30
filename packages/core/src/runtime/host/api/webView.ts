/**
 * web-view 组件背后的原生网页视图
 *
 * 渲染层的 web-view 组件调 insertHTMLWebView 占位，updateHTMLWebView 设置地址和位置，
 * 销毁时 removeHTMLWebView；加载进度通过渲染层的 onWebviewStartLoad / onWebviewFinishLoad
 * 告诉组件，组件据此触发 bindload。
 *
 * 默认把网页放在所在页面渲染层里的 iframe 中，跟着页面显示、隐藏和关闭。这有两个限制：
 * - 设置了 X-Frame-Options 或 CSP frame-ancestors 的网站不允许被嵌入，这类网页显示不出来
 * - 网页和宿主域名不同时，浏览器按跨站嵌入处理：SameSite 为 Lax、Strict 或没写的 Cookie 存不下、也不发送，
 *   网页的登录态因此失效。微信里 web-view 是独立的原生网页视图，没有这个问题
 *
 * 新窗口模式（--webview-window）把网页放到新窗口里打开，网页是顶层页面，绕开这两个限制，见 WebViewWindows
 */

import type { DeviceProfile } from '../../types';
import { ApiHandler, fail, ok } from './registry';

export interface WebViewApiOptions {
  /** 页面渲染层的 document，页面已关闭时为 undefined */
  documentOf(webviewId: number): Document | undefined;
  /** 派发给渲染层的原生事件（渲染层里 WeixinJSBridge.on 收到） */
  emitToWebview(webviewId: number, event: string, data: unknown): void;
  /** 新窗口模式下网页在这里打开；默认的 iframe 模式为 null */
  windows: WebViewWindows | null;
}

/** web-view 当前显示的网页，供测试 API 查询 */
export interface WebViewInfo {
  src: string;
  /** 新窗口模式下网页所在窗口的 name；iframe 模式为 null */
  windowName: string | null;
}

interface Position {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function createWebViewApis({ documentOf, emitToWebview, windows }: WebViewApiOptions): Record<string, ApiHandler> {
  if (windows) return createWindowApis(documentOf, windows);

  // 三个接口都由网页所在的渲染层调用，到那个文档里按 htmlId 找；不另存引用，页面关闭时随文档一起释放
  const find = (webviewId: number, htmlId: unknown) =>
    documentOf(webviewId)?.querySelector<HTMLIFrameElement>(`iframe[data-wxa-html-id="${Number(htmlId)}"]`) ?? null;

  const reportStart = (webviewId: number, htmlId: number, src: string) =>
    emitToWebview(webviewId, 'onWebviewStartLoad', { htmlId, src, isMainFrame: true });
  const reportFinish = (webviewId: number, htmlId: number, src: string) =>
    emitToWebview(webviewId, 'onWebviewFinishLoad', { htmlId, src });

  return {
    insertHTMLWebView: (args, { api, webviewId }) => {
      const doc = documentOf(webviewId);
      if (!doc) return fail(api, 'page not found');

      const htmlId = Number(args.htmlId);
      const frame = doc.createElement('iframe');
      frame.dataset.wxaHtmlId = String(htmlId);
      frame.style.cssText = 'position:fixed;z-index:2147483647;border:0;background:#fff';
      place(frame, args.position);
      frame.addEventListener('load', () => {
        const requested = frame.dataset.wxaLoading;
        if (requested) {
          delete frame.dataset.wxaLoading;
          reportFinish(webviewId, htmlId, requested);
          return;
        }
        // 网页里自己跳转的：同源时报告新地址；跨域读不到地址就不报，免得拿旧地址冒充
        const src = readableUrl(frame);
        if (!src || src === 'about:blank') return;
        reportStart(webviewId, htmlId, src);
        reportFinish(webviewId, htmlId, src);
      });
      doc.body.appendChild(frame);
      return ok(api);
    },

    updateHTMLWebView: (args, { api, webviewId }) => {
      const frame = find(webviewId, args.htmlId);
      if (!frame) return fail(api, 'web-view not found');
      place(frame, args.position);
      if (args.src) {
        const src = String(args.src);
        warnCrossSite(src);
        frame.dataset.wxaLoading = src;
        frame.dataset.wxaSrc = src;
        reportStart(webviewId, Number(args.htmlId), src);
        frame.src = src;
      }
      return ok(api);
    },

    removeHTMLWebView: (args, { api, webviewId }) => {
      find(webviewId, args.htmlId)?.remove();
      return ok(api);
    }
  };
}

/**
 * 新窗口模式的三个接口：渲染层里只放一个占位，网页交给 WebViewWindows 在新窗口里打开。
 * 跨域窗口的加载完成监听不到，不派发 onWebviewStartLoad / onWebviewFinishLoad，bindload 不会触发
 */
function createWindowApis(documentOf: WebViewApiOptions['documentOf'], windows: WebViewWindows): Record<string, ApiHandler> {
  return {
    insertHTMLWebView: (args, { api, webviewId }) => {
      const doc = documentOf(webviewId);
      if (!doc) return fail(api, 'page not found');
      windows.insert(webviewId, Number(args.htmlId), doc, args.position);
      return ok(api);
    },

    updateHTMLWebView: (args, { api, webviewId }) => {
      if (!windows.update(webviewId, Number(args.htmlId), args.position, args.src ? String(args.src) : undefined)) {
        return fail(api, 'web-view not found');
      }
      return ok(api);
    },

    removeHTMLWebView: (args, { api, webviewId }) => {
      windows.remove(webviewId, Number(args.htmlId));
      return ok(api);
    }
  };
}

/** iframe 模式下当前页面里的 web-view，按创建顺序；还没设置 src 的不算 */
export function iframeWebViews(doc: Document | undefined): WebViewInfo[] {
  return Array.from(doc?.querySelectorAll<HTMLIFrameElement>('iframe[data-wxa-src]') ?? [])
    .map(frame => ({ src: frame.dataset.wxaSrc!, windowName: null }));
}

interface WindowRecord {
  webviewId: number;
  name: string;
  placeholder: HTMLElement;
  status: HTMLElement;
  src?: string;
  win: Window | null;
}

/**
 * 新窗口模式：web-view 的网页在新窗口里打开。网页是顶层页面，用真实域名，Cookie 不受跨站嵌入的限制。
 *
 * 窗口跟着 web-view 所在的页面走：小程序里 web-view 铺满整个页面，和页面栈里的其他页面不会同时显示，
 * 所以页面隐藏（跳到下一页、切换 tab）时关闭窗口，重新显示时按最新的 src 重新打开（网页状态会丢失），页面关闭时一起关闭。
 * 宿主不能保证页面关闭前收到 removeHTMLWebView（closePage 直接删掉渲染层），这几个时机由 Host 调用对应的方法；
 * 宿主刷新或离开时用 closeAll 关掉全部窗口，否则它们会一直留着。
 *
 * 被浏览器拦截弹窗（没有用户操作时自动打开）或被用户关掉后，点占位里的按钮重新打开
 */
export class WebViewWindows {
  private readonly records = new Map<string, WindowRecord>();

  /** @param isShown 页面当前是否显示：隐藏的页面先记下地址，显示时再打开窗口 */
  constructor(private readonly device: DeviceProfile, private readonly isShown: (webviewId: number) => boolean) {}

  insert(webviewId: number, htmlId: number, doc: Document, position?: Partial<Position>) {
    // 同一个 htmlId 重新插入（如热更新后组件重新挂载）时沿用已打开的窗口
    const previous = this.records.get(windowName(webviewId, htmlId));
    previous?.placeholder.remove();

    const placeholder = doc.createElement('div');
    placeholder.dataset.wxaHtmlId = String(htmlId);
    placeholder.style.cssText =
      'position:fixed;z-index:2147483647;box-sizing:border-box;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:12px;padding:24px;background:#f7f7f7;color:#666;font:14px/1.6 sans-serif;text-align:center;word-break:break-all';
    const status = doc.createElement('div');
    const button = doc.createElement('button');
    button.textContent = '在新窗口打开 H5';
    button.style.cssText = 'padding:8px 16px;border:0;border-radius:4px;background:#07c160;color:#fff;font-size:14px';
    placeholder.append(status, button);
    place(placeholder, position);
    doc.body.appendChild(placeholder);

    const record: WindowRecord = { webviewId, name: windowName(webviewId, htmlId), placeholder, status, src: previous?.src, win: previous?.win ?? null };
    this.records.set(record.name, record);
    button.addEventListener('click', () => {
      if (record.win && !record.win.closed) record.win.focus();
      else this.open(record);
    });
    this.render(record);
  }

  /** @returns 找不到这个 web-view 时为 false */
  update(webviewId: number, htmlId: number, position?: Partial<Position>, src?: string): boolean {
    const record = this.records.get(windowName(webviewId, htmlId));
    if (!record) return false;
    place(record.placeholder, position);
    // 地址没变就不动窗口：同一个地址再跳一次，网页会重新加载、丢掉状态
    if (src && src !== record.src) {
      record.src = src;
      if (this.isShown(webviewId)) this.open(record);
      else this.render(record);
    }
    return true;
  }

  remove(webviewId: number, htmlId: number) {
    const record = this.records.get(windowName(webviewId, htmlId));
    if (!record) return;
    this.records.delete(record.name);
    close(record);
    record.placeholder.remove();
  }

  pageShown(webviewId: number) {
    for (const record of this.recordsOf(webviewId)) {
      if (record.src && !(record.win && !record.win.closed)) this.open(record);
    }
  }

  pageHidden(webviewId: number) {
    for (const record of this.recordsOf(webviewId)) {
      close(record);
      this.render(record);
    }
  }

  /** 页面关闭：渲染层已经或即将被删除，不必再动占位 */
  pageDestroyed(webviewId: number) {
    for (const record of this.recordsOf(webviewId)) {
      this.records.delete(record.name);
      close(record);
    }
  }

  closeAll() {
    for (const record of this.records.values()) close(record);
  }

  /** 页面里的 web-view，按创建顺序；还没设置 src 的不算 */
  list(webviewId: number): WebViewInfo[] {
    return this.recordsOf(webviewId).flatMap(record => record.src ? [{ src: record.src, windowName: record.name }] : []);
  }

  private recordsOf(webviewId: number): WindowRecord[] {
    return [...this.records.values()].filter(record => record.webviewId === webviewId);
  }

  private open(record: WindowRecord) {
    if (!record.src) return;
    if (record.win && !record.win.closed) {
      // 用已有的引用跳转，不靠窗口名：网页可能改了自己的 window.name，按名字找不到时会多开一个窗口
      record.win.location.href = record.src;
    } else {
      const features = `popup,width=${this.device.screenWidth},height=${this.device.screenHeight}`;
      record.win = window.open(record.src, record.name, features);
      if (record.win) notify('open', record.name, record.src);
    }
    this.render(record);
  }

  private render(record: WindowRecord) {
    const opened = record.win && !record.win.closed;
    const [title, detail] = !record.src
      ? ['web-view 还没有设置 src', '']
      : opened
        ? ['H5 已在新窗口打开', record.src]
        : record.win === null && this.isShown(record.webviewId)
          ? ['浏览器拦截了弹出窗口，点下面的按钮打开 H5', record.src]
          : ['H5 在新窗口打开', record.src];
    record.status.textContent = '';
    const heading = record.status.ownerDocument.createElement('div');
    heading.textContent = title;
    heading.style.cssText = 'color:#333;font-size:16px';
    record.status.append(heading);
    if (detail) record.status.append(detail);
  }
}

function windowName(webviewId: number, htmlId: number): string {
  // 不能用 wxa-webview-<id>：那是渲染层 iframe 的 name（PageView），同名的 window.open 会让页面本身跳转到网页
  return `wxa-h5-${webviewId}-${htmlId}`;
}

function close(record: WindowRecord) {
  if (!record.win) return;
  record.win.close();
  record.win = null;
  notify('close', record.name);
}

/**
 * 告诉测试工具宿主打开、关闭了哪个窗口（见 test-api.ts 的 __wxa_webview_window_event__）。
 * 网页设置了 Cross-Origin-Opener-Policy 时宿主拿到的窗口引用会失效、窗口名也被清空，测试工具靠这个对上窗口，替宿主关掉它
 */
function notify(type: 'open' | 'close', name: string, src?: string) {
  const listener = (window as WebViewWindowListenerHost).__wxa_webview_window_event__;
  listener?.(type, name, src)?.catch(() => undefined);
}

type WebViewWindowListenerHost = Window & { __wxa_webview_window_event__?: (type: 'open' | 'close', name: string, src?: string) => Promise<void> | void };

function place(element: HTMLElement, position?: Partial<Position>) {
  if (!position) return;
  for (const side of ['left', 'top', 'width', 'height'] as const) {
    if (typeof position[side] === 'number') element.style[side] = `${position[side]}px`;
  }
}

const warnedOrigins = new Set<string>();

/** iframe 模式下网页和宿主域名不同时提示一次：网页的 Cookie 多半不生效，容易被当成网页自己的问题 */
function warnCrossSite(src: string) {
  let url: URL;
  try {
    url = new URL(src, location.href);
  } catch {
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return;
  if (url.hostname === location.hostname && url.protocol === location.protocol) return;
  if (warnedOrigins.has(url.origin)) return;
  warnedOrigins.add(url.origin);
  console.warn(
    `[wxa-runner] web-view 加载的 ${url.origin} 与模拟器（${location.origin}）不是同一个站点，浏览器按跨站嵌入处理，` +
      `网页的 Cookie 可能不生效（微信里的小程序没有这个问题）。需要 Cookie 时让网页在新窗口打开：` +
      `命令行加 --webview-window，Playwright 用 test.use({ wxaWebView: 'window' })`
  );
}

function readableUrl(frame: HTMLIFrameElement): string | null {
  try {
    return frame.contentWindow?.location.href ?? null;
  } catch {
    return null;
  }
}
