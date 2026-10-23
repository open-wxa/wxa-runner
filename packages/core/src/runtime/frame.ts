/**
 * 注入到逻辑层/渲染层 iframe 的脚本，必须在基础库之前执行
 *
 * 1. 准备开发者工具会预置的全局变量（基础库依赖它们）
 * 2. 提供 WeixinJSBridge，把调用转发给宿主
 * 3. 渲染层：模拟手机屏幕尺寸，处理鼠标输入（见 installInput）
 *
 * 新版基础库的逻辑层分主上下文和子上下文（见 context.ts）。逻辑层 iframe 是主上下文；
 * 子上下文页面也加载这个脚本（data-context-id），只准备全局变量，桥由主上下文的基础库交给它。
 */

import { hookConsole } from './consoleHook';
import { installWeixinJSContext } from './context';
import { installApiStubs } from './sdkStubs';
import type { FrameBridge, FrameKind, HostApi } from './types';
import { createWeixinWorker } from './workers';

type Listener = (data: unknown, webviewId?: number) => void;

const script = document.currentScript as HTMLScriptElement;
const kind = (script.dataset.kind || 'webview') as FrameKind;
const webviewId = Number(script.dataset.webviewId || 0);
const subContextId = Number(script.dataset.contextId || 0);
const host = ((subContextId ? window.parent.parent : window.parent) as any).__wxaHost as HostApi;
const g = window as any;

g.__global = g;

if (kind === 'service') {
  Object.assign(g, {
    __wxAppData: {},
    __wxRoute: undefined,
    __wxRouteBegin: undefined,
    __wxAppCode__: {},
    __wxAppCurrentFile__: undefined,
    __vd_version_info__: {},
    global: {},
    __workerVendorCode__: {},
    __workersCode__: {},
    // 创建 Worker 的基础库代码在逻辑层 iframe 里（3.8 起是主上下文），子上下文用不到
    WeixinWorker: subContextId ? {} : createWeixinWorker(window, host),
    $gwx: undefined
  });
  g.__WeixinWorker = g.WeixinWorker;
  // 真机的逻辑层没有 DOM。按全局对象上有没有 MutationObserver 判断是否在浏览器里的库（如 core-js 2 的微任务 polyfill）
  // 看到它就去用 document，而业务代码里的 document 被模块包装屏蔽了（见 AppBuilder 的 MODULE_PARAMS），app.js 执行出错
  delete g.MutationObserver;
  delete g.WebKitMutationObserver;
  // 基础库初始化完成后通过它交出 App/Page/Component/wx/define/require 等全局对象
  g.__passWAServiceGlobal__ = (globals: Record<string, unknown>) => {
    for (const key of Object.keys(globals)) {
      if (key !== 'Protect') g[key] = globals[key];
    }
  };
  hookRequire();
  g.createCustomImage = createCustomImage;
  moveCanvasesIntoPages();
} else {
  emulateDeviceScreen(host.device);
  installInput();
  runLoadCallbacksEarly();
}

overrideUserAgent();

window.addEventListener('error', event => host.reportError(kind, webviewId, event.error || event.message));
window.addEventListener('unhandledrejection', event => host.reportError(kind, webviewId, event.reason));
// 生命周期、事件处理函数里的错误被基础库捕获后只用 console.error 打印，转发报错也要包装它
if (host.forwardConsole) {
  hookConsole(host.forwardConsole === 'all' ? ['warn', 'error'] : ['error'], (level, args) => host.reportConsole(kind, webviewId, level, args));
}

if (subContextId) {
  (window.parent as any).__wxaContexts.prepare(subContextId, window);
} else {
  const bridge = createBridge();
  g.WeixinJSBridge = bridge;
  // 基础库会用自己的包装替换 WeixinJSBridge，宿主始终通过这个引用回调
  g.__wxaBridge = bridge;
  if (script.dataset.appService) {
    installWeixinJSContext(window, host, {
      dispatchNative: bridge.__dispatchOn,
      appServiceScripts: JSON.parse(script.dataset.appService),
      hot: script.dataset.hot === '1'
    });
  }
  host.registerFrame(kind, window, bridge, webviewId);
}

/**
 * 基础库初始化完会把广告等缺伴生子包的接口改成「返回 undefined」的函数，占位只有在
 * 业务代码执行前装才留得住 —— bootstrap 里 require 第一个业务模块就是那个时机。
 *
 * 这里用存取器占住 require 再等基础库赋值，而不是事后包装：基础库交出全局的方式按版本
 * 而异（3.7.0 直接写 globalThis，并不调 __passWAServiceGlobal__），事后包装没有可靠的时机。
 * installApiStubs 幂等，每次 require 都查一遍，不赌某一次调用的先后。
 */
function hookRequire() {
  let real: unknown;
  const wrapper = function (this: unknown, ...args: unknown[]) {
    if (g.wx) installApiStubs(g.wx);
    return (real as (...a: unknown[]) => unknown).apply(this, args);
  };
  try {
    Object.defineProperty(g, 'require', {
      configurable: true,
      enumerable: true,
      get: () => (typeof real === 'function' ? wrapper : real),
      set: value => { real = value; }
    });
  } catch {
    // 定义不了就算了，广告接口退回基础库原样（返回 undefined）
  }
}

/**
 * type="2d" 和 webgl 画布：基础库在 devtools 平台把它们建在逻辑层文档的 body 里，开发者工具把逻辑层透明地叠在页面上显示，
 * 画布于是盖住页面里的所有内容；真机上画布和页面元素一样参与层级。所以业务第一次取上下文时（还没开始画），
 * 请宿主把画布搬进页面里对应的 wx-canvas（见 Host.placeCanvas）。之后基础库删除画布时仍从 body 里删，那时元素已经不在这里了
 */
function moveCanvasesIntoPages() {
  const { getContext } = HTMLCanvasElement.prototype;
  const { removeChild } = Node.prototype;
  // 宿主认不出的（如离屏画布）只试一次
  const tried = new WeakSet<HTMLCanvasElement>();

  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, ...args: unknown[]) {
    if (this.parentNode === document.body && !tried.has(this)) {
      tried.add(this);
      host.placeCanvas(this, String(args[0]));
    }
    return (getContext as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof getContext;

  HTMLBodyElement.prototype.removeChild = function <T extends Node>(this: HTMLBodyElement, child: T): T {
    if (child.parentNode === this || !(child instanceof HTMLCanvasElement)) return removeChild.call(this, child) as T;
    child.remove();
    return child;
  };
}

/**
 * type="2d" 和 webgl 画布的 createImage，开发者工具提供的原生能力（__global.createCustomImage）。
 * toUrl 把业务设置的 src 转成要加载的地址，代码包里的文件会带上开发者工具的 /__pageframe__/ 前缀；
 * fromUrl 把它还原成业务读 src 时看到的值。
 */
function createCustomImage(toUrl: (src: string) => string, fromUrl: (url: string) => string): HTMLImageElement {
  let url = '';
  return new (class extends Image {
    set src(value: string) {
      url = toUrl(value);
      super.src = loadableImageUrl(url);
    }

    get src() {
      return fromUrl(url);
    }
  })();
}

/**
 * 代码包里的文件由开发服务器在根路径提供。其他域名的图片经代理变成同源：直接加载的话画上去会污染画布，
 * 之后读像素、导出都会失败；加 crossOrigin 又要对方返回 CORS 头，大多数图片服务器不返回。
 * 不解析地址：格式不对的地址照样交给代理，加载失败走 onerror，和原生 Image 一样不在赋值时抛错
 */
function loadableImageUrl(url: string): string {
  if (url.startsWith('/__pageframe__/')) return url.slice('/__pageframe__'.length);
  if (/^https?:\/\//i.test(url) && !url.startsWith(location.origin + '/')) return `/__wxa__/proxy?url=${encodeURIComponent(url)}`;
  return url;
}

function createBridge(): FrameBridge & Record<string, unknown> {
  const onListeners: Record<string, Listener[]> = {};
  const subListeners: Record<string, Listener[]> = {};

  const add = (map: Record<string, Listener[]>, event: string, listener: Listener) => {
    (map[event] = map[event] || []).push(listener);
  };
  const remove = (map: Record<string, Listener[]>, event: string, listener?: Listener) => {
    if (!map[event]) return;
    map[event] = listener ? map[event].filter(l => l !== listener) : [];
  };
  const emit = (map: Record<string, Listener[]>, event: string, data: unknown, id?: number) => {
    for (const listener of (map[event] || []).slice()) {
      try {
        listener(data, id);
      } catch (error) {
        console.error(`[wxa-runner] ${event} 处理出错`, error);
      }
    }
  };

  return {
    invoke(api: string, args: unknown, callback?: (res: any) => void) {
      host.invoke(kind, window, api, args, callback);
    },
    publish(event: string, data: unknown, webviewIds?: number[]) {
      host.publish(kind, window, event, data, webviewIds);
    },
    subscribe(event: string, listener: Listener) {
      add(subListeners, event, listener);
    },
    on(event: string, listener: Listener) {
      add(onListeners, event, listener);
    },
    addEventListener(event: string, listener: Listener) {
      add(onListeners, event, listener);
    },
    removeEventListener(event: string, listener?: Listener) {
      remove(onListeners, event, listener);
    },
    addSubscribeListener(event: string, listener: Listener) {
      add(subListeners, event, listener);
    },
    removeSubscribeListener(event: string, listener?: Listener) {
      remove(subListeners, event, listener);
    },
    __dispatchOn(event: string, data: unknown, id?: number) {
      emit(onListeners, event, data, id);
    },
    __dispatchSub(event: string, data: unknown, id?: number) {
      emit(subListeners, event, data, id);
    }
  };
}

/**
 * wcsc 生成的 rpx 换算读取 window.screen.width，桌面浏览器里那是显示器宽度，
 * 这里改成模拟设备的尺寸。
 */
function emulateDeviceScreen(device: HostApi['device']) {
  const values: Record<string, number> = {
    width: device.screenWidth,
    height: device.screenHeight,
    availWidth: device.screenWidth,
    availHeight: device.screenHeight
  };
  for (const key of Object.keys(values)) {
    try {
      Object.defineProperty(window.screen, key, { get: () => values[key], configurable: true });
    } catch {
      // 个别浏览器不允许重定义，退回到真实值
    }
  }
  // 桌面浏览器报告横屏，基础库会因此改用 screen.height 作为设备宽度换算 rpx
  const portrait = {
    type: 'portrait-primary',
    angle: 0,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent: () => false,
    lock: () => Promise.reject(new Error('not supported')),
    unlock() {}
  };
  try {
    Object.defineProperty(window.screen, 'orientation', { get: () => portrait, configurable: true });
  } catch {
    // 同上
  }
  try {
    Object.defineProperty(window, 'devicePixelRatio', { get: () => device.pixelRatio, configurable: true });
  } catch {
    // 同上
  }
}

/**
 * 基础库在文档没加载完时，把内置组件样式（wx-view 的 display、wx-canvas 的默认尺寸等）推迟到
 * window.onload 再注入。开发者工具在文档加载完后才注入基础库，那边是立即注入；这里基础库随页面
 * 同步加载，首屏渲染早于 onload，canvas 这类挂载时测量尺寸的组件会量到没有样式时的大小。
 * 所以加载完成前赋给 window.onload 的回调改为在当前脚本执行完后立即运行，仍早于首屏渲染。
 * 效果与开发者工具一致：那边每处都直接调用回调，多次赋值各自执行，window.onload 本身始终为空。
 */
function runLoadCallbacksEarly() {
  let owner: object | null = window;
  while (owner && !Object.getOwnPropertyDescriptor(owner, 'onload')) owner = Object.getPrototypeOf(owner);
  const native = owner && Object.getOwnPropertyDescriptor(owner, 'onload');
  if (!native?.get || !native.set) return;
  Object.defineProperty(window, 'onload', {
    configurable: true,
    get: () => native.get!.call(window),
    set(handler: unknown) {
      if (typeof handler === 'function' && document.readyState !== 'complete') {
        queueMicrotask(() => handler.call(window, new Event('load')));
      } else {
        native.set!.call(window, handler);
      }
    }
  });
}

function overrideUserAgent() {
  const ua = `${navigator.userAgent} (iPhone; wxa-runner) MicroMessenger/8.0.50 miniProgram`;
  try {
    Object.defineProperty(navigator, 'userAgent', { get: () => ua, configurable: true });
  } catch {
    // 只影响基础库对平台的判断，失败可以忽略
  }
}

/**
 * 鼠标输入 → 触摸事件
 *
 * 模拟的是手机，页面只应收到触摸事件。基础库在部分版本/平台上会自己把鼠标或 pointer 事件
 * 转换为触摸，和这里的转换叠加会导致一次点击触发两次 tap，所以在 window 捕获阶段
 * （先于基础库注册的任何监听）拦下鼠标类事件。不调用 preventDefault，输入框聚焦等默认行为不受影响。
 *
 * 另外，基础库在元素滚动后 50ms 内会把触摸当作滑动、取消 tap。自动化测试常常是
 * 「滚动到元素 → 立刻点击」，而 scroll 事件要到下一帧才派发，所以按下时先等两帧
 * 让挂起的 scroll 事件派发完，刚滚动过的话再顺延到窗口之后。同一次按压的事件按原顺序派发。
 *
 * 按下后移出 TOUCH_SLOP 之前的 mousemove 不转成 touchmove（类似触屏的 touch slop）。swiper 等组件
 * 按第一个 touchmove 的位移判断手势方向，鼠标刚拖动时常先抖出 1px 的竖向位移，直接转发的话横向拖动
 * 会被判成竖向、整次拖动都被忽略。阈值小于基础库取消 tap 的 10px，点击和长按不受影响。
 * 没移出阈值就松手时，先补一个到松手位置的 touchmove，slider 微调、画短笔画这类小幅拖动不会丢。
 */
function installInput() {
  const SCROLL_TAP_GUARD = 80;
  const TOUCH_SLOP = 8;
  let lastScroll = 0;
  let queue: Promise<void> = Promise.resolve();
  let target: EventTarget | null = null;
  let start: { x: number; y: number } | null = null;

  document.addEventListener('scroll', () => {
    lastScroll = Date.now();
  }, true);

  const nextFrame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

  const fire = (type: 'touchstart' | 'touchmove' | 'touchend', event: MouseEvent, eventTarget: EventTarget) => {
    const point = {
      clientX: event.clientX,
      clientY: event.clientY,
      pageX: event.pageX,
      pageY: event.pageY,
      screenX: event.screenX,
      screenY: event.screenY
    };
    queue = queue.then(async () => {
      if (type === 'touchstart') {
        await nextFrame();
        await nextFrame();
        const wait = lastScroll + SCROLL_TAP_GUARD - Date.now();
        if (wait > 0) await sleep(wait);
      }
      const touch = new Touch({ identifier: 1, target: eventTarget, ...point });
      const active = type === 'touchend' ? [] : [touch];
      eventTarget.dispatchEvent(new TouchEvent(type, {
        bubbles: true,
        cancelable: true,
        composed: true,
        touches: active,
        targetTouches: active,
        changedTouches: [touch]
      }));
    });
  };

  window.addEventListener('mousedown', event => {
    event.stopImmediatePropagation();
    if (event.button !== 0 || !event.target) return;
    target = event.target;
    start = { x: event.clientX, y: event.clientY };
    fire('touchstart', event, target);
  }, true);
  window.addEventListener('mousemove', event => {
    event.stopImmediatePropagation();
    if (!target) return;
    if (start) {
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) < TOUCH_SLOP) return;
      start = null;
    }
    fire('touchmove', event, target);
  }, true);
  window.addEventListener('mouseup', event => {
    event.stopImmediatePropagation();
    if (!target) return;
    if (start && (event.clientX !== start.x || event.clientY !== start.y)) {
      fire('touchmove', event, target);
      // movable-view 等组件在下一帧才应用位移，同一帧里就收到 touchend 的话这段位移会被丢掉
      queue = queue.then(nextFrame);
    }
    fire('touchend', event, target);
    target = null;
  }, true);
  for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel']) {
    window.addEventListener(type, event => {
      if ((event as PointerEvent).pointerType !== 'touch') event.stopImmediatePropagation();
    }, true);
  }
}
