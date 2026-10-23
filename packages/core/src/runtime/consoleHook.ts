/**
 * 包装 iframe 里的 console：照常打印，同时交给宿主转发到终端
 *
 * 开发服务器把这个文件列入 frame.js 的 source map 的忽略列表，DevTools 跳过这层包装，
 * 控制台里的来源链接仍指向调用 console 的业务代码
 */

export type ConsoleLevel = 'warn' | 'error';

export function hookConsole(levels: ConsoleLevel[], report: (level: ConsoleLevel, args: unknown[]) => void) {
  for (const level of levels) {
    const original = console[level];
    console[level] = function (this: Console, ...args: unknown[]) {
      original.apply(this, args);
      try {
        report(level, args);
      } catch {
        // 转发出错不能影响业务代码
      }
    };
  }
}
