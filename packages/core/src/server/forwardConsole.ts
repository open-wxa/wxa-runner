/**
 * 把浏览器转发来的报错和控制台输出打印到终端（浏览器端见 runtime/host/ConsoleForwarder.ts）
 *
 * 开了 --host 时局域网里的设备也能连上来发消息：去掉控制字符，免得借转义序列操纵终端；限制长度和频率，免得刷屏
 */

import type { RawData, WebSocket } from 'ws';

const MAX_LENGTH = 4000;
const LIMIT_PER_SECOND = 20;
/** C0、C1 控制字符，保留换行和制表符 */
// oxlint-disable-next-line no-control-regex -- 就是要匹配控制字符
const CONTROL_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;

export function printBrowserReports(socket: WebSocket, logger: Pick<Console, 'warn' | 'error'>) {
  let windowStart = 0;
  let printed = 0;
  let dropped = 0;
  socket.on('message', data => {
    const report = parseReport(data);
    if (!report) return;
    const now = Date.now();
    if (now - windowStart >= 1000) {
      windowStart = now;
      printed = 0;
    }
    if (printed >= LIMIT_PER_SECOND) {
      // 这一秒结束时说明省略了多少条
      if (dropped++ === 0) {
        setTimeout(() => {
          logger.warn(`[wxa-runner] 浏览器 1 秒内转发的报错太多，省略了 ${dropped} 条`);
          dropped = 0;
        }, windowStart + 1000 - now).unref();
      }
      return;
    }
    printed++;
    logger[report.level](`[wxa-runner] ${clean(report.text)}`);
  });
}

function parseReport(data: RawData): { level: 'warn' | 'error'; text: string } | null {
  try {
    const report = JSON.parse(data.toString());
    if (report?.type === 'console' && (report.level === 'warn' || report.level === 'error') && typeof report.text === 'string') return report;
  } catch {
    // 不是 JSON
  }
  return null;
}

function clean(text: string): string {
  const printable = text.replace(CONTROL_CHARS, '');
  return printable.length > MAX_LENGTH ? `${printable.slice(0, MAX_LENGTH)}…（已截断）` : printable;
}

/** frame.js 的 source map 加上忽略列表：包装 console 的代码（consoleHook.ts）不作为控制台输出的来源 */
export function ignoreConsoleHook(sourceMap: string): string {
  const map = JSON.parse(sourceMap);
  map.x_google_ignoreList = map.sources.flatMap((source: string, index: number) => (source.endsWith('consoleHook.ts') ? [index] : []));
  return JSON.stringify(map);
}
