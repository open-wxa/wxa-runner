/**
 * 模拟原生 WeixinJSContext（3.7.1 起的基础库需要）
 *
 * 新版基础库把逻辑层分成主上下文和子上下文：逻辑层 iframe 是主上下文，运行 WAServiceMainContext.js，
 * 持有 WeixinJSBridge；App / Page / wx 和业务代码在子上下文里，子上下文由主上下文通过这个接口创建。
 * 与开发者工具一样，每个子上下文是逻辑层 iframe 里的一个同源 iframe（subcontext.html）。
 *
 * 两边的消息不经过这里：子上下文拿到同一个 WeixinJSContext 对象，主上下文初始化时在上面挂了
 * register / subscribeHandler，双方直接互相调用。
 *
 * 交给基础库的 WeixinJSContext 是一次性的门面：基础库初始化时取走上面的方法、再把它们删掉，
 * 所以这里的逻辑都不经过它。
 */

import { readSync, runScript } from './syncScript';
import type { HostApi } from './types';

const MAIN_CONTEXT_ID = 1;
/** 业务代码所在的子上下文 */
const APP_CONTEXT_NAME = 'app';
/** 基础库要执行的业务代码入口，对应构建出的 define 脚本和 bootstrap */
const APP_SERVICE_ENTRY = 'app-service.js';
/** 从基础库开始执行到业务代码执行完的最长时间 */
const BOOT_TIMEOUT = 10000;

type Callback = () => void;

export interface WeixinJSContextOptions {
  /** 向主上下文派发原生事件（WeixinJSBridge.on） */
  dispatchNative: (event: string, data: unknown) => void;
  /** 业务代码的脚本地址，基础库执行 app-service.js 时按顺序加载 */
  appServiceScripts: string[];
  /** 打开基础库的热更新开关（见 server/html.ts 的 enableHotUpdate） */
  hot: boolean;
}

/** 在逻辑层主上下文里提供 window.WeixinJSContext，必须在基础库之前调用 */
export function installWeixinJSContext(main: Window, host: HostApi, options: WeixinJSContextOptions) {
  const contexts = new JsContexts(main, host, options);
  (main as any).WeixinJSContext = contexts.nativeInterface;
  // subcontext.html 通过 parent.__wxaContexts 回调这两个入口
  (main as any).__wxaContexts = {
    prepare: (id: number, win: Window) => contexts.prepare(id, win),
    loaded: (id: number) => contexts.loaded(id)
  };
}

/** 主上下文和它创建的子上下文 */
class JsContexts {
  private readonly boot: AppBoot;
  private readonly mainContext: JsContext;
  private readonly contexts = new Map<number, JsContext>();
  private nextId = MAIN_CONTEXT_ID + 1;

  /** 交给基础库的原生接口。基础库会把方法取下来单独调用，所以都不依赖 this */
  readonly nativeInterface = {
    mainContextId: MAIN_CONTEXT_ID,
    alloc: (name?: string, callback?: Callback) => this.open(name, false).whenReady(callback).id,
    allocEmpty: (name?: string, callback?: Callback) => this.open(name, true).whenReady(callback).id,
    create: (entry: string | undefined, name?: string, callback?: Callback) => {
      const context = this.open(name, false);
      context.whenReady(entry ? () => this.evaluate(context, entry, callback) : callback);
      return context.id;
    },
    evaluateScriptFile: (id: number, file: string, callback?: Callback) =>
      this.withContext(id, context => this.evaluate(context, file, callback)),
    loadJsFiles: (id: number, files: string, callback?: Callback) =>
      this.withContext(id, context => this.evaluateAll(context, JSON.parse(files), callback)),
    /** 基础库自己的文件（如 WARenderContext.js），同步执行 */
    loadLibFiles: (id: number, files: string) =>
      this.withContext(id, context => {
        context.runSync((JSON.parse(files) as string[]).map(file => `/__baselib__/${file}`));
        return 1;
      }),
    destroy: (id: number, callback?: Callback) => this.destroy(id, callback)
  };

  constructor(private readonly main: Window, private readonly host: HostApi, private readonly options: WeixinJSContextOptions) {
    this.boot = new AppBoot(host);
    this.mainContext = new JsContext(MAIN_CONTEXT_ID, 'main', main);
    this.contexts.set(MAIN_CONTEXT_ID, this.mainContext);
  }

  /** 子上下文页面开始执行，基础库之前：交给它基础库需要的全局变量 */
  prepare(id: number, win: Window) {
    const context = this.contexts.get(id);
    if (!context || context === this.mainContext) throw new Error(`[wxa-runner] 未知的子上下文 ${id}`);
    context.win = win;
    Object.assign(win, { WeixinJSContext: this.nativeInterface, WeixinJSContextId: id, __wxConfig: (this.main as any).__wxConfig });
    if (context.isApp) this.host.registerAppContext(win);
  }

  /** 子上下文页面执行完（基础库已初始化） */
  loaded(id: number) {
    const context = this.contexts.get(id);
    if (!context) return;
    context.markReady();
    if (context.isApp) {
      this.boot.reach('entry');
      // 真机上由客户端在主包就绪后派发，基础库收到后才执行业务入口
      this.options.dispatchNative('onSubPackageReady', { moduleName: '__APP__' });
    }
  }

  private open(name: string | undefined, empty: boolean): JsContext {
    const context = openSubContext(this.main, this.nextId++, name, empty);
    this.contexts.set(context.id, context);
    if (context.isApp) this.boot.reach('load');
    return context;
  }

  /** 原生接口的结果码：1 成功，0 失败 */
  private withContext(id: number, action: (context: JsContext) => number): number {
    const context = this.contexts.get(Number(id));
    if (context) return action(context);
    console.warn(`[wxa-runner] 找不到 JS 上下文 ${id}`);
    return 0;
  }

  /** 执行基础库要求的脚本文件：带回调时等上下文加载完再异步执行，否则同步执行 */
  private evaluate(context: JsContext, file: string, done?: Callback): number {
    // 基础库只会要求执行业务代码入口
    if (!context.isApp || file.replace(/^\/+/, '') !== APP_SERVICE_ENTRY) {
      console.warn(`[wxa-runner] 基础库要求执行未知脚本 ${file}`);
      return 0;
    }
    const urls = this.options.appServiceScripts;
    if (done) {
      context.whenReady(() => {
        this.startApp(context);
        loadScripts(context.win!, urls, () => {
          done();
          this.boot.finish();
        });
      });
    } else {
      this.startApp(context);
      context.runSync(urls);
      this.boot.finish();
    }
    return 1;
  }

  private startApp(context: JsContext) {
    this.boot.reach('run');
    // 与旧版基础库一样，必须在业务代码注册 Page / Component 之前打开
    if (this.options.hot) (context.win as any).__virtualDOM__?.enableUpdateWxAppCode?.();
  }

  private evaluateAll(context: JsContext, files: string[], done?: Callback): number {
    if (!done) return files.every(file => this.evaluate(context, file) === 1) ? 1 : 0;
    let remaining = files.length;
    if (remaining === 0) done();
    for (const file of files) {
      if (this.evaluate(context, file, () => --remaining === 0 && done()) === 0) return 0;
    }
    return 1;
  }

  private destroy(id: number, callback?: Callback) {
    const context = this.contexts.get(Number(id));
    if (!context || context === this.mainContext) return;
    this.contexts.delete(context.id);
    context.destroy();
    if (context.isApp) this.host.registerAppContext(null);
    callback?.();
  }
}

/** 一个 JS 上下文：主上下文是逻辑层 iframe 本身，子上下文是其中的一个同源 iframe */
class JsContext {
  /** 页面加载完之前收到的任务；加载完后为 null */
  private pending: Callback[] | null;

  constructor(readonly id: number, readonly name: string, public win: Window | null, private readonly iframe?: HTMLIFrameElement) {
    this.pending = win ? null : [];
  }

  get isApp(): boolean {
    return this.name === APP_CONTEXT_NAME;
  }

  /** 加载完后执行，已加载完时立即执行 */
  whenReady(task?: Callback): this {
    if (task) {
      if (this.pending) this.pending.push(task);
      else task();
    }
    return this;
  }

  markReady() {
    const tasks = this.pending || [];
    this.pending = null;
    tasks.forEach(task => task());
  }

  runSync(urls: string[]) {
    if (this.pending) throw new Error(`[wxa-runner] JS 上下文 ${this.id} 尚未加载完，不能同步执行脚本`);
    for (const url of urls) runScript(this.win!, url, readSync(url));
  }

  destroy() {
    this.pending = [];
    this.iframe?.remove();
  }
}

function openSubContext(main: Window, id: number, name: string | undefined, empty: boolean): JsContext {
  const iframe = main.document.createElement('iframe');
  iframe.style.display = 'none';
  iframe.src = `/__wxa__/subcontext.html?id=${id}${empty ? '&empty=1' : ''}`;
  // 基础库在逻辑层页面的 <head> 里执行时就会创建子上下文，那时还没有 body
  main.document.documentElement.appendChild(iframe);
  return new JsContext(id, name || `context${id}`, null, iframe);
}

const BOOT_STAGES = {
  alloc: `基础库没有创建业务子上下文（名为 ${APP_CONTEXT_NAME} 的子上下文）`,
  load: '业务子上下文没有加载完（WASubContext.js 加载或执行出错）',
  entry: `基础库没有执行业务代码入口 ${APP_SERVICE_ENTRY}`,
  run: '业务代码没有加载完'
};

type BootStage = keyof typeof BOOT_STAGES;

/**
 * 业务代码的启动过程，每一步都依赖基础库的内部行为：
 * 创建业务子上下文 → 子上下文加载完 → 派发 onSubPackageReady → 基础库执行业务入口 → 业务代码执行完。
 * 任何一步没发生，宿主都会一直等逻辑层就绪，所以超时后报告停在哪一步，照常结束启动
 */
class AppBoot {
  private stage: BootStage = 'alloc';
  private finished = false;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(private readonly host: HostApi) {
    this.timer = setTimeout(() => {
      this.finish(new Error(`[wxa-runner] 逻辑层 ${BOOT_TIMEOUT}ms 内没有就绪：${BOOT_STAGES[this.stage]}`));
    }, BOOT_TIMEOUT);
  }

  reach(stage: BootStage) {
    this.stage = stage;
  }

  /** 通知宿主逻辑层就绪，只通知一次；出错时先报告错误 */
  finish(error?: Error) {
    if (this.finished) return;
    this.finished = true;
    clearTimeout(this.timer);
    if (error) {
      console.error(error.message);
      this.host.reportError('service', 0, error);
    }
    this.host.frameLoaded('service', 0);
  }
}

/** 按顺序加载外部脚本（保留文件名和行号，便于在 DevTools 里调试），全部执行完后回调 */
function loadScripts(win: Window, urls: string[], done: Callback) {
  let remaining = urls.length;
  if (remaining === 0) {
    done();
    return;
  }
  for (const url of urls) {
    const script = win.document.createElement('script');
    script.async = false;
    script.src = url;
    const settle = () => {
      if (--remaining === 0) done();
    };
    script.onload = settle;
    script.onerror = () => {
      console.error(`[wxa-runner] 加载 ${url} 失败`);
      settle();
    };
    win.document.head.appendChild(script);
  }
}
