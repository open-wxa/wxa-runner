/**
 * 报错转发：浏览器端把报错整理成发给终端的文字
 *
 * 基础库在开发者工具平台（device.platform 为 devtools）用 Error 对象打印业务代码的错误，
 * 其他平台把错误信息和栈拼成字符串打印：`MiniProgramError\n${message}\n${stack}`，V8 的栈开头又重复一遍 `Error: ${message}`
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
  it('基础库把错误拼成字符串打印时，多行的错误信息完整保留，不重复栈开头的那一遍', () => {
    const { forwarder, sent } = createForwarder();
    const stack = ['Error: 请求失败', 'status: 403', frame('onLoad', 'pages/index/index.js', 6)].join('\n');
    forwarder.console('service', 0, 'error', [`MiniProgramError\n请求失败\nstatus: 403\n${stack}`]);

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('请求失败\nstatus: 403\n    at onLoad (pages/index/index.js:6:5)');
    expect(sent[0].text.match(/status: 403/g)).toHaveLength(1);
  });

  it('同一个错误从全局 error 和基础库的 console.error 两路报来，只转发一次', () => {
    const { forwarder, sent } = createForwarder();
    const error = Object.assign(new Error('定时器里出错'), { stack: `Error: 定时器里出错\n${frame('<anonymous>', 'pages/index/index.js', 9)}` });
    forwarder.error('service', 0, error.message, error.stack);
    forwarder.console('service', 0, 'error', [Object.assign(new Error(`MiniProgramError\n${error.message}`), { stack: error.stack })]);

    expect(sent).toHaveLength(1);
  });

  it('一秒内不同位置抛出同名错误时，各自转发', () => {
    const { forwarder, sent } = createForwarder();
    const message = "Cannot read properties of undefined (reading 'name')";
    forwarder.error('service', 0, message, `TypeError: ${message}\n${frame('loadList', 'pages/a/a.js', 10)}`);
    forwarder.error('service', 0, message, `TypeError: ${message}\n${frame('render', 'pages/b/b.js', 20)}`);
    forwarder.error('webview', 2, message, `TypeError: ${message}`);

    expect(sent.map(report => report.text)).toEqual([
      expect.stringContaining('pages/a/a.js:10'),
      expect.stringContaining('pages/b/b.js:20'),
      expect.stringContaining('渲染层（pages/page2/page2）')
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
