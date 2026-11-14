/**
 * web-view 地址改写规则（setup 里声明）
 *
 * 规则在 web-view 真正加载前依次执行：返回字符串就替换地址，返回空值保持原样。
 * 单条规则抛错时只警告并跳过，不影响页面加载——调试工具不该因为一条写错的规则让 H5 白屏。
 */

import type { WebViewRewriteContext, WebViewUrlRewrite } from '../../setup';

export class WebViewUrlHooks {
  private readonly rewrites: WebViewUrlRewrite[] = [];
  /** 同一个 web-view 用同样的地址重复更新时不再重复打印 */
  private readonly logged = new Set<string>();

  add(rewrite: WebViewUrlRewrite) {
    this.rewrites.push(rewrite);
  }

  get size(): number {
    return this.rewrites.length;
  }

  /** 依次套用所有规则；非 http(s) 地址原样返回 */
  rewrite(url: string, context: WebViewRewriteContext): string {
    if (!this.rewrites.length || !/^https?:/i.test(url)) return url;
    let current = url;
    for (const rewrite of this.rewrites) {
      try {
        const next = rewrite(current, context);
        if (typeof next === 'string' && next && next !== current) current = next;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[wxa-runner] web-view 地址改写失败，已跳过这条规则：${message}`);
      }
    }
    if (current !== url) this.log(context, url, current);
    return current;
  }

  private log(context: WebViewRewriteContext, from: string, to: string) {
    const key = `${context.webviewId}-${context.htmlId}:${from}`;
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.info(`[wxa-runner] web-view 地址被改写：${from} → ${to}`);
  }
}
