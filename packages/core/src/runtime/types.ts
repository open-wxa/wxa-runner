/**
 * 浏览器端运行时共享类型
 *
 * 宿主页面（host）与逻辑层/渲染层 iframe 同源，iframe 内的桥直接调用宿主对象，
 * 不经过 postMessage：同步 API（如 getStorageSync）因此可以同步返回。
 */

export type FrameKind = 'service' | 'webview';

/** 把浏览器里的报错转发到开发服务器的终端：errors 只转发报错，all 再加上 console.warn / console.error，false 不转发 */
export type ForwardConsole = 'errors' | 'all' | false;

/** iframe 内桥对象上供宿主回调的入口 */
export interface FrameBridge {
  /** 系统事件，对应基础库的 WeixinJSBridge.on */
  __dispatchOn(event: string, data: unknown, webviewId?: number): void;
  /** 另一层发布的消息，对应 WeixinJSBridge.subscribe */
  __dispatchSub(event: string, data: unknown, webviewId?: number): void;
}

export type InvokeCallback = (result: Record<string, unknown> | string) => void;

/** 宿主暴露给 iframe 的接口（window.parent.__wxaHost） */
export interface HostApi {
  registerFrame(kind: FrameKind, win: Window, bridge: FrameBridge, webviewId: number): void;
  /** 新版基础库：业务代码所在的子上下文，App / Page / wx 在它上面；销毁时为 null */
  registerAppContext(win: Window | null): void;
  invoke(kind: FrameKind, win: Window, api: string, args: unknown, callback?: InvokeCallback): void;
  publish(kind: FrameKind, win: Window, event: string, data: unknown, webviewIds?: number[]): void;
  frameLoaded(kind: FrameKind, webviewId: number): void;
  reportError(kind: FrameKind, webviewId: number, error: unknown): void;
  /** iframe 里的 console.warn / console.error，开启转发时才会调用 */
  reportConsole(kind: FrameKind, webviewId: number, level: 'warn' | 'error', args: unknown[]): void;
  readonly forwardConsole: ForwardConsole;
  /** 把逻辑层建的 2d、webgl 画布放进页面里对应的 wx-canvas；认不出是哪个画布时（如离屏画布）留在原处。type 是 getContext 的类型 */
  placeCanvas(canvas: HTMLCanvasElement, type: string): void;
  device: DeviceProfile;
}

export interface DeviceProfile {
  model: string;
  screenWidth: number;
  screenHeight: number;
  pixelRatio: number;
  statusBarHeight: number;
  /** 底部安全区高度（Home Indicator），无刘海机型为 0 */
  safeAreaBottom: number;
  system: string;
  platform: string;
}

/** /__wxa__/app-info.json */
export interface AppInfo {
  version: number;
  appid: string;
  baseLibVersion: string;
  wxConfig: Record<string, any>;
  pages: string[];
  device: DeviceProfile;
  /** 开启了 --devtools-login */
  devtoolsLogin?: boolean;
  buildError?: string;
  /** 配置了 setup 文件时存在；error 是 setup 的编译错误 */
  setup?: { env: Record<string, string>; error?: string };
  /** 没有时不转发 */
  forwardConsole?: ForwardConsole;
}

/** 逻辑层发给 Worker 的消息（runtime/workers.ts → runtime/worker.ts） */
export type ToWorkerMessage =
  /** 逻辑层基础库发来的消息，交给 Worker 基础库 */
  | { type: 'message'; data: unknown }
  /** Worker 里调用原生接口的结果 */
  | { type: 'callback'; callbackId: number; result: unknown };

/** Worker 发给逻辑层的消息 */
export type FromWorkerMessage =
  /** Worker 基础库发出的消息，交给逻辑层基础库 */
  | { type: 'message'; data: unknown }
  /** Worker 里调用原生接口 */
  | { type: 'invoke'; api: string; args: unknown; callbackId: number }
  /** Worker 基础库捕获的、业务没有处理的异常 */
  | { type: 'error'; message: string; stack?: string };
