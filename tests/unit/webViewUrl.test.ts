/**
 * web-view 地址改写：setup 注册的规则要落到真正加载的地址上
 *
 * iframe 内嵌和新窗口两种模式的接口都在这里测；新窗口真正打开网页要真浏览器，由 tests/e2e/webView.test.ts 覆盖。
 */

import { describe, expect, it } from 'vitest';
import { createWebViewApis } from '../../packages/core/src/runtime/host/api/webView';
import { WebViewUrlHooks } from '../../packages/core/src/runtime/host/webViewUrlHooks';

const context = { pagePath: 'pages/webview/container/container', webviewId: 3, htmlId: 1 };

function fakeFrame() {
  const frame: any = { dataset: {}, style: {}, listeners: {} as Record<string, () => void> };
  let src = '';
  Object.defineProperty(frame, 'src', {
    get: () => src,
    set: (value: string) => {
      src = value;
    }
  });
  frame.addEventListener = (event: string, listener: () => void) => {
    frame.listeners[event] = listener;
  };
  frame.remove = () => {
    frame.removed = true;
  };
  return frame;
}

function createApis(rewrite?: (url: string, ctx: typeof context) => string) {
  const frame = fakeFrame();
  const doc: any = {
    body: { appendChild: () => undefined },
    createElement: () => frame,
    querySelector: () => frame
  };
  const handlers = createWebViewApis({
    documentOf: () => doc,
    emitToWebview: () => undefined,
    windows: null,
    rewriteUrl: rewrite,
    pagePathOf: () => 'pages/webview/container/container'
  });
  const update = (src: string) =>
    handlers.updateHTMLWebView({ htmlId: 1, src }, { api: 'updateHTMLWebView', from: 'view', webviewId: 3 } as any);
  return { frame, update };
}

describe('web-view 地址改写钩子', () => {
  it('没有规则时原样返回', () => {
    const hooks = new WebViewUrlHooks();
    expect(hooks.rewrite('https://h5.example/a?b=1', context)).toBe('https://h5.example/a?b=1');
  });

  it('多条规则按注册顺序串行生效，返回空值的规则跳过', () => {
    const hooks = new WebViewUrlHooks();
    hooks.add(url => `${url}&one=1`);
    hooks.add(() => undefined);
    hooks.add((url, ctx) => `${url}&page=${ctx.pagePath}`);

    const result = hooks.rewrite('https://h5.example/a', context);
    expect(result).toBe('https://h5.example/a&one=1&page=pages/webview/container/container');
  });

  it('单条规则抛错不影响后面的规则', () => {
    const hooks = new WebViewUrlHooks();
    hooks.add(() => {
      throw new Error('写错了');
    });
    hooks.add(url => `${url}&ok=1`);

    expect(hooks.rewrite('https://h5.example/a', context)).toBe('https://h5.example/a&ok=1');
  });

  it('非 http(s) 地址不改写', () => {
    const hooks = new WebViewUrlHooks();
    hooks.add(url => `${url}&x=1`);

    expect(hooks.rewrite('about:blank', context)).toBe('about:blank');
  });
});

describe('iframe 模式的 web-view 接口', () => {
  it('加载前把改写后的地址写到 iframe 上', () => {
    const { frame, update } = createApis((url, ctx) => `${url}&wxa_sim=runner&page=${ctx.pagePath}`);

    update('https://h5.example/a?b=1');

    expect(frame.src).toBe('https://h5.example/a?b=1&wxa_sim=runner&page=pages/webview/container/container');
    expect(frame.dataset.wxaSrc).toBe(frame.src);
    expect(frame.dataset.wxaLoading).toBe(frame.src);
  });

  it('没配置规则时用原地址', () => {
    const { frame, update } = createApis();

    update('https://h5.example/a?b=1');

    expect(frame.src).toBe('https://h5.example/a?b=1');
  });
});

describe('新窗口模式的 web-view 接口', () => {
  it('打开/更新窗口前同样按规则改写', () => {
    const calls: string[] = [];
    const windows = {
      update: (webviewId: number, _htmlId: number, _position: unknown, src?: string) => {
        if (src) calls.push(src);
        return true;
      }
    };
    const handlers = createWebViewApis({
      documentOf: () => ({}) as any,
      emitToWebview: () => undefined,
      windows: windows as any,
      rewriteUrl: url => `${url}&wxa_sim=runner`,
      pagePathOf: () => 'pages/webview/container/container'
    });

    handlers.updateHTMLWebView(
      { htmlId: 1, src: 'https://h5.example/a?b=1' },
      { api: 'updateHTMLWebView', from: 'view', webviewId: 3 } as any
    );

    expect(calls).toEqual(['https://h5.example/a?b=1&wxa_sim=runner']);
  });
});
