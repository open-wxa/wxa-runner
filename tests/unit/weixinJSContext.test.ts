/**
 * 模拟的原生 WeixinJSContext：基础库通过它创建子上下文、执行业务代码，宿主据此得知逻辑层何时就绪
 *
 * 用假的 window 代替 iframe：子上下文页面（subcontext.html）的两个回调由测试按真实顺序调用，
 * 断言落在基础库拿到的返回值和回调、子上下文里执行的脚本、宿主收到的通知上。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installWeixinJSContext } from '../../packages/core/src/runtime/context';
import type { HostApi } from '../../packages/core/src/runtime/types';

interface FakeElement {
  tag: string;
  src?: string;
  async?: boolean;
  style: Record<string, string>;
  text?: string;
  removed?: boolean;
  onload?: () => void;
  remove(): void;
}

/** 记下插入的 iframe 和脚本；外部脚本插入后异步加载完成 */
function fakeWindow(): any {
  const appended: FakeElement[] = [];
  const loaded: string[] = [];
  const append = (el: FakeElement) => {
    appended.push(el);
    if (el.tag === 'script' && el.src) {
      queueMicrotask(() => {
        loaded.push(el.src!);
        el.onload?.();
      });
    }
  };
  return {
    appended,
    loaded,
    scripts: () => appended.filter(el => el.tag === 'script').map(el => el.src ?? el.text),
    document: {
      createElement: (tag: string): FakeElement => ({ tag, style: {}, remove() { this.removed = true; } }),
      head: { appendChild: append },
      documentElement: { appendChild: append }
    }
  };
}

function fakeHost() {
  return { registerAppContext: vi.fn(), frameLoaded: vi.fn(), reportError: vi.fn() };
}

const flush = () => new Promise<void>(resolve => setTimeout(resolve, 0));

function install(options: { hot?: boolean; appServiceScripts?: string[] } = {}) {
  const main = fakeWindow();
  main.__wxConfig = { appid: 'wx1' };
  const host = fakeHost();
  const dispatchNative = vi.fn();
  installWeixinJSContext(main, host as unknown as HostApi, {
    dispatchNative,
    appServiceScripts: options.appServiceScripts ?? ['/app/a.js', '/app/b.js'],
    hot: options.hot ?? false
  });
  const native = main.WeixinJSContext;
  /** 子上下文页面加载：先 prepare（基础库执行前），再 loaded（基础库初始化完） */
  const loadSubContext = (id: number) => {
    const win = fakeWindow();
    main.__wxaContexts.prepare(id, win);
    main.__wxaContexts.loaded(id);
    return win;
  };
  return { main, host, dispatchNative, native, loadSubContext };
}

beforeEach(() => {
  vi.stubGlobal('location', { href: 'http://localhost:3000/__wxa__/service.html' });
  vi.stubGlobal('XMLHttpRequest', class {
    status = 200;
    responseText = '';
    open(_method: string, url: string) {
      this.responseText = `/* ${url} */`;
    }
    send() {}
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('WeixinJSContext 启动业务代码', () => {
  it('业务子上下文拿到基础库需要的全局变量，宿主得到它的窗口', () => {
    const { main, host, native } = install();
    const id = native.alloc('app');
    const win = fakeWindow();
    main.__wxaContexts.prepare(id, win);

    expect(win).toMatchObject({ WeixinJSContext: native, WeixinJSContextId: id, __wxConfig: { appid: 'wx1' } });
    expect(host.registerAppContext).toHaveBeenCalledWith(win);
  });

  it('每个子上下文有自己的 id，不与主上下文冲突', () => {
    const { native } = install();
    const ids = [native.alloc('app'), native.allocEmpty('worker'), native.create(undefined, 'other')];
    expect(new Set([native.mainContextId, ...ids]).size).toBe(4);
    expect(ids.every(id => id > 0)).toBe(true);
  });

  it('allocEmpty 创建的子上下文页面不加载基础库（empty=1），alloc 和 create 的加载', () => {
    const { main, native } = install();
    native.alloc('a');
    native.allocEmpty('b');
    native.create(undefined, 'c');
    const pages = main.appended.filter((el: FakeElement) => el.tag === 'iframe').map((el: FakeElement) => el.src);
    expect(pages).toEqual([
      expect.not.stringContaining('empty=1'),
      expect.stringContaining('empty=1'),
      expect.not.stringContaining('empty=1')
    ]);
  });

  it('业务子上下文加载完后派发 onSubPackageReady，其他子上下文不派发', () => {
    const { native, dispatchNative, loadSubContext } = install();
    loadSubContext(native.alloc('worker'));
    expect(dispatchNative).not.toHaveBeenCalled();

    loadSubContext(native.alloc('app'));
    expect(dispatchNative).toHaveBeenCalledWith('onSubPackageReady', { moduleName: '__APP__' });
  });

  it('执行 app-service.js 时按顺序加载业务脚本，全部执行完才回调基础库，并通知宿主逻辑层就绪', async () => {
    const { native, host, loadSubContext } = install();
    const id = native.alloc('app');
    const win = loadSubContext(id);
    let loadedWhenDone: string[] = [];
    const done = vi.fn(() => (loadedWhenDone = [...win.loaded]));

    expect(native.evaluateScriptFile(id, '/app-service.js', done)).toBe(1);
    expect(done).not.toHaveBeenCalled();
    await flush();

    // 外部脚本 async = false 时浏览器按插入顺序执行
    expect(win.appended.map((el: FakeElement) => [el.src, el.async])).toEqual([['/app/a.js', false], ['/app/b.js', false]]);
    expect(loadedWhenDone).toEqual(['/app/a.js', '/app/b.js']);
    expect(done).toHaveBeenCalledTimes(1);
    expect(host.frameLoaded).toHaveBeenCalledTimes(1);
    expect(host.frameLoaded).toHaveBeenCalledWith('service', 0);
  });

  it('没有业务脚本时立即回调基础库', () => {
    const { native, host, loadSubContext } = install({ appServiceScripts: [] });
    const id = native.alloc('app');
    loadSubContext(id);
    const done = vi.fn();

    native.evaluateScriptFile(id, 'app-service.js', done);
    expect(done).toHaveBeenCalledTimes(1);
    expect(host.frameLoaded).toHaveBeenCalledTimes(1);
  });

  it('子上下文还没加载完时收到的执行请求，等加载完再执行', async () => {
    const { native, loadSubContext } = install();
    const done = vi.fn();
    const id = native.create('app-service.js', 'app', done);
    await flush();
    expect(done).not.toHaveBeenCalled();

    const win = loadSubContext(id);
    await flush();
    expect(win.scripts()).toEqual(['/app/a.js', '/app/b.js']);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('不带回调时同步读取业务脚本并内联执行', () => {
    const { native, host, loadSubContext } = install();
    const id = native.alloc('app');
    const win = loadSubContext(id);

    expect(native.evaluateScriptFile(id, 'app-service.js')).toBe(1);
    expect(win.scripts()).toEqual([
      expect.stringContaining('/* /app/a.js */'),
      expect.stringContaining('/* /app/b.js */')
    ]);
    expect(host.frameLoaded).toHaveBeenCalledTimes(1);
  });

  it('打开热更新时，在业务代码执行前打开基础库的热更新开关', async () => {
    const { native, loadSubContext } = install({ hot: true });
    const id = native.alloc('app');
    const win = loadSubContext(id);
    const enable = vi.fn(() => win.scripts());
    win.__virtualDOM__ = { enableUpdateWxAppCode: enable };

    native.evaluateScriptFile(id, 'app-service.js', () => {});
    await flush();

    expect(enable).toHaveBeenCalledTimes(1);
    // 打开开关时还没有插入任何业务脚本
    expect(enable).toHaveReturnedWith([]);
    expect(win.scripts()).toHaveLength(2);
  });

  it('打开热更新但基础库没有热更新接口时照常执行业务代码', async () => {
    const { native, loadSubContext } = install({ hot: true });
    const id = native.alloc('app');
    const win = loadSubContext(id);
    const done = vi.fn();

    native.evaluateScriptFile(id, 'app-service.js', done);
    win.__virtualDOM__ = {};
    native.evaluateScriptFile(id, 'app-service.js', done);
    await flush();
    expect(done).toHaveBeenCalledTimes(2);
  });

  it('loadJsFiles 等列表里的文件都执行完才回调，列表为空时立即回调', async () => {
    const { native, loadSubContext } = install();
    const id = native.alloc('app');
    const win = loadSubContext(id);
    let loadedWhenDone: string[] = [];
    const done = vi.fn(() => (loadedWhenDone = [...win.loaded]));

    expect(native.loadJsFiles(id, JSON.stringify(['app-service.js', 'app-service.js']), done)).toBe(1);
    expect(done).not.toHaveBeenCalled();
    await flush();
    expect(loadedWhenDone).toEqual(['/app/a.js', '/app/b.js', '/app/a.js', '/app/b.js']);
    expect(done).toHaveBeenCalledTimes(1);

    const empty = vi.fn();
    expect(native.loadJsFiles(id, '[]', empty)).toBe(1);
    expect(empty).toHaveBeenCalledTimes(1);
  });

  it('loadJsFiles 不带回调时同步执行，有一个文件失败就返回 0', () => {
    const { native, loadSubContext } = install();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = native.alloc('app');
    const win = loadSubContext(id);

    expect(native.loadJsFiles(id, JSON.stringify(['app-service.js']))).toBe(1);
    expect(win.scripts()).toHaveLength(2);
    expect(native.loadJsFiles(id, JSON.stringify(['app-service.js', 'other.js']))).toBe(0);
    warn.mockRestore();
  });

  it('基础库自己的文件从 /__baselib__/ 同步加载', () => {
    const { native, loadSubContext } = install();
    const id = native.alloc('app');
    const win = loadSubContext(id);

    expect(native.loadLibFiles(id, JSON.stringify(['WARenderContext.js']))).toBe(1);
    expect(win.scripts()).toEqual([expect.stringContaining('/* /__baselib__/WARenderContext.js */')]);
  });
});

describe('WeixinJSContext 的失败结果', () => {
  it('未知脚本、未知上下文返回 0，基础库据此判断失败', () => {
    const { native, loadSubContext } = install();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const id = native.alloc('worker');
    loadSubContext(id);

    expect(native.evaluateScriptFile(id, 'app-service.js')).toBe(0);
    expect(native.evaluateScriptFile(99, 'app-service.js')).toBe(0);
    expect(native.loadJsFiles(id, JSON.stringify(['other.js']), () => {})).toBe(0);
    warn.mockRestore();
  });

  it('子上下文没加载完就要求同步执行时报错', () => {
    const { native } = install();
    const id = native.alloc('app');
    expect(() => native.loadLibFiles(id, '["a.js"]')).toThrow(/尚未加载完/);
  });

  it('子上下文页面带着未知 id 回调时报错', () => {
    const { main } = install();
    expect(() => main.__wxaContexts.prepare(42, fakeWindow())).toThrow(/未知的子上下文 42/);
    expect(() => main.__wxaContexts.prepare(1, fakeWindow())).toThrow(/未知的子上下文 1/);
  });

  it('逻辑层 10 秒内没有就绪时报告停在哪一步，照常通知宿主就绪', () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { native, host, loadSubContext } = install();
    const id = native.alloc('app');
    loadSubContext(id);

    vi.advanceTimersByTime(10000);
    expect(host.reportError).toHaveBeenCalledWith('service', 0, expect.objectContaining({
      message: expect.stringContaining('没有执行业务代码入口 app-service.js')
    }));
    expect(host.frameLoaded).toHaveBeenCalledTimes(1);

    // 超时之后业务代码才执行完，不再重复通知
    native.evaluateScriptFile(id, 'app-service.js');
    expect(host.frameLoaded).toHaveBeenCalledTimes(1);
    expect(host.reportError).toHaveBeenCalledTimes(1);
    error.mockRestore();
  });
});

describe('WeixinJSContext 销毁子上下文', () => {
  it('销毁业务子上下文时移除 iframe、宿主注销它的窗口并回调', () => {
    const { main, native, host, loadSubContext } = install();
    const id = native.alloc('app');
    loadSubContext(id);
    const iframe = main.appended.find((el: FakeElement) => el.tag === 'iframe');
    const done = vi.fn();

    native.destroy(id, done);
    expect(iframe.removed).toBe(true);
    expect(host.registerAppContext).toHaveBeenLastCalledWith(null);
    expect(done).toHaveBeenCalled();
    expect(native.evaluateScriptFile(id, 'app-service.js')).toBe(0);
  });

  it('销毁时可以不带回调', () => {
    const { native } = install();
    const id = native.alloc('worker');
    expect(() => native.destroy(id)).not.toThrow();
  });

  it('主上下文和不存在的上下文不能销毁', () => {
    const { native } = install();
    const done = vi.fn();
    native.destroy(native.mainContextId, done);
    native.destroy(99, done);
    expect(done).not.toHaveBeenCalled();
  });
});
