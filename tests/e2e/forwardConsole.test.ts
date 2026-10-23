/**
 * 端到端：浏览器里的报错转发到开发服务器的终端
 *
 * 编程助手自己启动开发服务器时只看得到终端输出，页面报错要转发过来它才知道改出了问题。
 * 生命周期、事件处理函数里的错误被基础库捕获后只打印到逻辑层的控制台，不会冒泡成全局的 error 事件，
 * 这类最常见的错误也要转发。
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { DevServerOptions } from '../../packages/core/src/server/DevServer';
import { e2eReady, Runner, startRunner } from './runner';

// onLoad 里 throw 在第 6 行
const PAGE_JS = `
Page({
  onLoad() {
    console.warn('业务代码的 warn', { id: 1 });
    console.error('业务代码的 error');
    throw new Error('onLoad 里出错');
  },
  onTap() { throw new Error('点击时出错'); },
  onTimer() { setTimeout(() => { throw new Error('定时器里出错'); }, 0); },
  onReject() { Promise.reject(new Error('没有处理的 Promise 拒绝')); },
  onUnimplemented() {
    wx.addPhoneContact({ firstName: '张三' });
    wx.addPhoneContact({ firstName: '李四' });
  }
});
`;

const PAGE_WXML = ['tap', 'timer', 'reject', 'unimplemented']
  .map(name => `<button id="${name}" bindtap="on${name[0].toUpperCase()}${name.slice(1)}">${name}</button>`)
  .join('');

interface Terminal {
  runner: Runner;
  /** 开发服务器打印的 warn 和 error */
  output: Array<{ level: 'warn' | 'error'; text: string }>;
  printed(level: 'warn' | 'error', text: string): Array<string>;
}

async function startWithTerminal(forwardConsole: DevServerOptions['forwardConsole']): Promise<Terminal> {
  const output: Terminal['output'] = [];
  const runner = await startRunner(
    {
      'app.json': { pages: ['pages/index/index'] },
      'pages/index/index.json': {},
      'pages/index/index.wxml': PAGE_WXML,
      'pages/index/index.js': PAGE_JS
    },
    {
      forwardConsole,
      logger: {
        log: () => undefined,
        warn: (text: string) => output.push({ level: 'warn', text }),
        error: (text: string) => output.push({ level: 'error', text })
      }
    }
  );
  return {
    runner,
    output,
    printed: (level, text) => output.filter(line => line.level === level && line.text.includes(text)).map(line => line.text)
  };
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!e2eReady)('报错转发到终端（forwardConsole: errors）', () => {
  let terminal: Terminal;

  beforeAll(async () => {
    terminal = await startWithTerminal('errors');
    await terminal.runner.open('/');
  });

  afterAll(async () => {
    await terminal?.runner.close();
  });

  it('生命周期里抛出的错误打印到终端：带上当前页面，栈只留业务代码，路径换成项目里的路径', async () => {
    await vi.waitFor(() => expect(terminal.printed('error', 'onLoad 里出错')).toHaveLength(1));
    const [text] = terminal.printed('error', 'onLoad 里出错');

    expect(text).toContain('pages/index/index');
    expect(text).toMatch(/pages\/index\/index\.js:6:\d+/);
    expect(text).not.toContain('__baselib__');
    expect(text).not.toContain('http://');
  });

  it('事件处理函数里抛出的错误打印到终端', async () => {
    const frame = await terminal.runner.open('/');
    await frame.click('#tap');
    await vi.waitFor(() => expect(terminal.printed('error', '点击时出错')).toHaveLength(1));
  });

  it('定时器里抛出的错误既是全局错误、又被基础库打印，终端里只出现一次', async () => {
    const frame = await terminal.runner.open('/');
    await frame.click('#timer');
    await vi.waitFor(() => expect(terminal.printed('error', '定时器里出错')).toHaveLength(1));
    await sleep(500);
    expect(terminal.printed('error', '定时器里出错')).toHaveLength(1);
  });

  it('没有处理的 Promise 拒绝打印到终端', async () => {
    const frame = await terminal.runner.open('/');
    await frame.click('#reject');
    await vi.waitFor(() => expect(terminal.printed('error', '没有处理的 Promise 拒绝')).toHaveLength(1));
  });

  it('调用了未实现的 wx API 时打印警告，调用多次只打印一次', async () => {
    const frame = await terminal.runner.open('/');
    await frame.click('#unimplemented');
    await vi.waitFor(() => expect(terminal.printed('warn', 'wx.addPhoneContact')).toHaveLength(1));
    await sleep(500);
    expect(terminal.printed('warn', 'wx.addPhoneContact')).toHaveLength(1);
  });

  it('业务代码的 console.warn / console.error 不转发', () => {
    expect(terminal.output.filter(line => line.text.includes('业务代码的'))).toEqual([]);
  });
});

describe.skipIf(!e2eReady)('报错和控制台输出都转发到终端（forwardConsole: all）', () => {
  let terminal: Terminal;

  beforeAll(async () => {
    terminal = await startWithTerminal('all');
    await terminal.runner.open('/');
  });

  afterAll(async () => {
    await terminal?.runner.close();
  });

  it('业务代码的 console.warn / console.error 按级别打印到终端，对象参数序列化成 JSON', async () => {
    await vi.waitFor(() => expect(terminal.printed('warn', '业务代码的 warn {"id":1}')).toHaveLength(1));
    await vi.waitFor(() => expect(terminal.printed('error', '业务代码的 error')).toHaveLength(1));
  });

  it('基础库捕获的错误照常打印一次，不会再作为 console.error 重复打印', async () => {
    await vi.waitFor(() => expect(terminal.printed('error', 'onLoad 里出错')).toHaveLength(1));
    await sleep(500);
    expect(terminal.printed('error', 'onLoad 里出错')).toHaveLength(1);
  });
});

describe.skipIf(!e2eReady)('不转发（作为库使用时的默认值）', () => {
  let terminal: Terminal;

  beforeAll(async () => {
    terminal = await startWithTerminal(undefined);
  });

  afterAll(async () => {
    await terminal?.runner.close();
  });

  it('页面出错时终端里什么都不打印', async () => {
    const frame = await terminal.runner.open('/');
    await frame.click('#timer');
    await vi.waitFor(async () => expect(await terminal.runner.page.evaluate(() => window.__wxa_test_api__.errors().length)).toBeGreaterThan(0));
    await sleep(500);
    expect(terminal.output).toEqual([]);
  });
});
