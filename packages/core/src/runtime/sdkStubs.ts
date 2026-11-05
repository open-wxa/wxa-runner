/**
 * 基础库伴生 SDK 子包能力的占位实现
 *
 * WAService.js 不是自包含的。广告、云开发、米大师支付等能力放在一组伴生文件里
 * （WAAppAd.js / WACloud.js / WAMidasSDK.js 等），真机和开发者工具由原生层调用
 * loadMainContextLibFile 把它们同步加载进同一个上下文，再把导出挂到约定的全局名上
 * （WAAppAd.js → globalThis.AD → 基础库读作 ADSDK）。运行时没有这套加载机制。
 *
 * 缺失不会直接抛到业务代码：基础库把内部异常包成 appServiceSDKScriptError 自己吞掉，
 * 于是 wx.createRewardedVideoAd() 返回 undefined。真正崩的是下一行业务代码
 * ——`ad.onError(...)`，Cannot read properties of undefined。所以占位放在 wx 这一层，
 * 不管基础库内部走的是哪条失败路径（3.7.0 上 createRewardedVideoAd 栽在
 * loadSdkSubPackage，createInterstitialAd 栽在 ADSDK 未定义）都能接住。
 *
 * 不在 ADSDK / __cloudSDKMain__ 这些全局上打桩：基础库 init 时会按子包注册表回写
 * 这些全局，占位会被覆盖掉；而 SkylineGlobal / NativeGlobal / xrFrame 等是基础库会
 * typeof 检测的能力开关，补上反而会让它走进依赖更多的分支，比缺失更糟。
 */

const UNSUPPORTED = '浏览器运行时不支持广告';

type Listener = (...args: unknown[]) => void;

/** 没人接的占位调用不该变成 unhandledrejection，但返回的 promise 仍然可以被 catch */
function rejected(reason: unknown): Promise<never> {
  const promise = Promise.reject(reason);
  promise.catch(() => undefined);
  return promise;
}

class StubAd {
  private listeners: Record<string, Listener[]> = {};

  constructor(private readonly hideable: boolean) {}

  load() { return this.fail(); }
  show() { return this.fail(); }
  destroy() { this.listeners = {}; }

  onLoad(callback: Listener) { this.add('load', callback); }
  offLoad(callback?: Listener) { this.remove('load', callback); }
  onError(callback: Listener) { this.add('error', callback); }
  offError(callback?: Listener) { this.remove('error', callback); }
  onClose(callback: Listener) { this.add('close', callback); }
  offClose(callback?: Listener) { this.remove('close', callback); }

  /** 只有原生模板广告（createCustomAd）有这组接口 */
  hide() { return this.hideable ? Promise.resolve() : undefined; }
  isShow() { return this.hideable ? false : undefined; }
  onHide(callback: Listener) { if (this.hideable) this.add('hide', callback); }
  offHide(callback?: Listener) { if (this.hideable) this.remove('hide', callback); }

  private add(event: string, callback: Listener) {
    (this.listeners[event] = this.listeners[event] || []).push(callback);
  }

  private remove(event: string, callback?: Listener) {
    if (!this.listeners[event]) return;
    this.listeners[event] = callback ? this.listeners[event].filter(l => l !== callback) : [];
  }

  /** 真机上拉取失败也是先回调 onError 再 reject，这里保持一致 */
  private fail() {
    const error = { errCode: 1000, errMsg: UNSUPPORTED };
    queueMicrotask(() => {
      for (const listener of (this.listeners.error || []).slice()) listener({ ...error });
    });
    return rejected(error);
  }
}

/** 基础库缺少伴生子包时会返回 undefined 的广告接口 */
export const UNSUPPORTED_AD_APIS = [
  'createRewardedVideoAd',
  'createInterstitialAd',
  'createCustomAd',
  'createSkitAd'
] as const;

export interface ApiStubOptions {
  /** 默认 console.warn，测试里可以注入收集 */
  warn?: (message: string) => void;
}

/** 标在占位函数上，重复调用 installApiStubs 时据此跳过 */
const STUB = Symbol.for('wxa-runner.apiStub') as unknown as string;

/** 每次 require 都会重装一遍，提示挂在 wx 上，第一次用到广告时出一次 */
const WARNED = Symbol.for('wxa-runner.apiStubWarned') as unknown as string;

/**
 * 替换掉基础库里这些返回 undefined 的接口。
 * 幂等：装过的不再重装，可以在每次 require 前安全调用。
 * 返回这次实际替换的名字；wx 上的属性个别基础库版本可能不可配置，那种就跳过。
 */
export function installApiStubs(wx: Record<string, any>, options: ApiStubOptions = {}): string[] {
  const warn = options.warn || ((message: string) => console.warn(message));
  const replaced: string[] = [];

  for (const name of UNSUPPORTED_AD_APIS) {
    if (wx[name]?.[STUB]) continue;

    const stub = () => {
      if (!wx[WARNED]) {
        wx[WARNED] = true;
        warn('[wxa-runner] 广告（WAAppAd.js）在浏览器运行时不可用，广告对象的 load/show 会失败，但不会中断页面');
      }
      return new StubAd(name === 'createCustomAd');
    };
    (stub as any)[STUB] = true;

    try {
      Object.defineProperty(wx, name, { value: stub, writable: true, configurable: true, enumerable: true });
      replaced.push(name);
    } catch {
      // 属性不可配置，保持基础库原样（仍会返回 undefined）
    }
  }

  return replaced;
}

/** 单上下文里唯一要照常读取的伴生 SDK 全局：云开发的接口本体在 WAService.js 里，wx.cloud 就是经它取到的 */
const BUILT_IN_SDK_GLOBALS = new Set(['__cloudSDKMain__']);

/**
 * 单上下文的基础库（3.7.0 及以前）把伴生 SDK 挂成全局对象上的懒加载存取器（ADSDK、MidasSDK、__sclEngine__ 等），
 * 第一次读时才加载。这种上下文里它们加载不了（见 context.ts 的 installSingleContextLibLoader），读一次的后果是：
 * - 有的存取器直接抛 TypeError（往 undefined 上写 inject）。业务代码一般不直接读它们，但 Taro 等框架启动时
 *   把全局对象上的属性逐个拷到自己的 window 上，一读就中断 app.js
 * - 不抛错的，基础库也会把这个 SDK 标成已注入，之后自己去用它。如 2.32.3 首屏渲染时调 ADSDK.getPreloadAdUnitIds()，
 *   页面渲染不出来
 *
 * 所以在业务代码执行前，把基础库加上的、可重新定义的存取器换成返回 undefined，不触发加载，等同这个 SDK 不存在。
 * 只看基础库加上的（不在 before 里），不按名字列：各版本的伴生 SDK 不一样。读取不提示，真用到广告时由
 * installApiStubs 的占位提示；基础库之后回写这些全局不受影响。
 *
 * @param before 基础库执行前全局对象上已有的属性名
 * @returns 换掉了的属性名
 */
export function guardSdkGlobals(global: object, before: ReadonlySet<string>): string[] {
  const guarded: string[] = [];
  for (const key of Object.getOwnPropertyNames(global)) {
    if (before.has(key) || BUILT_IN_SDK_GLOBALS.has(key)) continue;
    const descriptor = Object.getOwnPropertyDescriptor(global, key);
    if (!descriptor?.get || !descriptor.configurable) continue;
    Object.defineProperty(global, key, { get: () => undefined, enumerable: descriptor.enumerable, configurable: true });
    guarded.push(key);
  }
  return guarded;
}
