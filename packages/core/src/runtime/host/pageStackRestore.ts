/**
 * wxa-runner 触发的整页刷新（改了无法热更新的文件、热更新失败）保留页面栈：
 * 刷新前记下每一页的路径和参数，启动后依次重新打开
 *
 * 开发者手动刷新不经过这里，只按地址栏恢复当前页——手动刷新通常就是想从头来过。
 * 为此记录在启动时就取出并删掉；恢复完成之前又被 wxa-runner 刷新时，再原样写回去。
 */

import type { Host, LaunchTarget } from './Host';

export class PageStackRestore {
  private readonly key: string;
  /** 本次启动要恢复的页面栈 */
  private saved: LaunchTarget[];
  /** 恢复完成前（包括编译、setup 出错没能启动）自动刷新，要把 saved 原样记回去 */
  private restoring: boolean;

  /** 按 appid 区分：同一个标签页换了项目时不会串用 */
  constructor(appid: string) {
    this.key = `wxa-runner:reload-page-stack:${appid}`;
    this.saved = read(this.key);
    this.restoring = this.saved.length > 0;
  }

  /** 启动页：记下的第一页；记下的页面已经不存在时，从它开始往后都不恢复 */
  launchTarget(pages: string[], fallback: LaunchTarget): LaunchTarget {
    const invalid = this.saved.findIndex(entry => !pages.includes(entry.path));
    if (invalid >= 0) this.saved = this.saved.slice(0, invalid);
    return this.saved[0] ?? fallback;
  }

  /**
   * 在已启动的第一页之上依次 navigateTo 其余页面；某一页打不开就停下
   *
   * 整段放进同一个路由任务：恢复期间开发者点返回、切 tab 会排在恢复完成之后
   */
  async reopen(host: Host) {
    try {
      await host.enqueueRoute(async () => {
        for (const { path, query } of this.saved.slice(1)) {
          const search = new URLSearchParams(query).toString();
          const result = await host.navigateTo(search ? `${path}?${search}` : path, { animate: false });
          if (!String(result.errMsg).endsWith(':ok')) {
            console.warn(`[wxa-runner] 恢复页面栈时打不开 ${path}：${result.errMsg}`);
            return;
          }
        }
      });
    } finally {
      this.restoring = false;
    }
  }

  /** 记下当前页面栈后整页刷新 */
  reload(host: Host | undefined) {
    const stack = this.restoring ? this.saved : host?.pageStack().map(page => ({ path: page.path, query: page.query })) ?? [];
    if (stack.length) {
      try {
        sessionStorage.setItem(this.key, JSON.stringify(stack));
      } catch {
        // 存不了就只恢复当前页
      }
    }
    location.reload();
  }
}

function read(key: string): LaunchTarget[] {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key) || '[]');
    sessionStorage.removeItem(key);
    if (!Array.isArray(saved)) return [];
    return saved
      .filter(entry => entry && typeof entry.path === 'string')
      .map(entry => ({ path: entry.path, query: { ...entry.query } }));
  } catch {
    return [];
  }
}
