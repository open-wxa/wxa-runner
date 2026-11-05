/**
 * 报错转发：浏览器端把报错整理成发给终端的文字
 *
 * 基础库捕获的错误怎么认出来、两路报来的同一个错误怎么去重，见 frameErrors.test.ts
 */

import { describe, expect, it } from 'vitest';
import { ConsoleForwarder, ConsoleReport } from '../../packages/core/src/runtime/host/ConsoleForwarder';

const ORIGIN = 'http://localhost:3000';

function createForwarder() {
  const sent: ConsoleReport[] = [];
  const forwarder = new ConsoleForwarder('all', report => sent.push(report), (kind, webviewId) =>
    kind === 'service' ? 'pages/index/index' : `pages/page${webviewId}/page${webviewId}`
  );
  return { forwarder, sent };
}

const frame = (fn: string, file: string, line: number) => `    at ${fn} (${ORIGIN}/__wxa__/module/${file}?v=1:${line}:5)`;

describe('ConsoleForwarder', () => {
  it('多行的错误信息完整保留，栈只留业务代码的帧', () => {
    const { forwarder, sent } = createForwarder();
    const stack = ['Error: 请求失败', 'status: 403', frame('onLoad', 'pages/index/index.js', 6), `    at a (${ORIGIN}/__baselib__/WAService.js:1:2)`].join('\n');
    forwarder.error('service', 0, '请求失败\nstatus: 403', stack);

    expect(sent.map(report => report.text)).toEqual(['逻辑层（pages/index/index）报错：请求失败\nstatus: 403\n    at onLoad (pages/index/index.js:6:5)']);
  });

  it('有提示时附在报错的栈后面，每条一行', () => {
    const sent: ConsoleReport[] = [];
    const forwarder = new ConsoleForwarder('errors', report => sent.push(report), () => undefined, kind =>
      kind === 'service' ? ['出错时首页还没创建', '第二条提示'] : []
    );
    const message = "Cannot read properties of undefined (reading 'route')";
    forwarder.error('service', 0, message, `TypeError: ${message}\n${frame('success', 'app.js', 7)}`);
    forwarder.error('webview', 1, message);

    expect(sent.map(report => report.text)).toEqual([
      `逻辑层报错：${message}\n    at success (app.js:7:5)\n  提示：出错时首页还没创建\n  提示：第二条提示`,
      `渲染层报错：${message}`
    ]);
  });

  it('参数很多时整条消息也有长度上限，不会超出开发服务器接收的大小', () => {
    const { forwarder, sent } = createForwarder();
    forwarder.console('service', 0, 'warn', Array.from({ length: 100 }, () => '长'.repeat(1000)));
    forwarder.error('service', 0, '错'.repeat(100000));

    expect(sent).toHaveLength(2);
    for (const report of sent) expect(new TextEncoder().encode(JSON.stringify(report)).length).toBeLessThan(64 * 1024);
  });
});
