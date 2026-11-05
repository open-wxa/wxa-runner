/**
 * 运行时错误的收集：认出基础库捕获后打印的错误，两路报来的同一个错误只记一次
 *
 * 基础库在开发者工具平台（device.platform 为 devtools）用 Error 对象打印业务代码的错误，
 * 其他平台把错误信息和栈拼成字符串打印：`MiniProgramError\n${message}\n${stack}`，V8 的栈开头又重复一遍 `Error: ${message}`
 */

import { describe, expect, it } from 'vitest';
import { caughtError, RecentErrors } from '../../packages/core/src/runtime/host/frameErrors';

const frame = (fn: string, file: string, line: number) => `    at ${fn} (http://localhost:3000/__wxa__/module/${file}?v=1:${line}:5)`;

describe('caughtError', () => {
  it('基础库打印的 Error 对象：去掉开头的 MiniProgramError，栈原样保留', () => {
    const stack = `TypeError: x is undefined\n${frame('success', 'pages/index/index.js', 3)}`;
    const printed = Object.assign(new Error('MiniProgramError\nx is undefined'), { stack });
    expect(caughtError(printed)).toEqual({ message: 'x is undefined', stack });
  });

  it('原错误没有栈时（如 DOMException）不当作有：打印的 Error 上是基础库自己的栈', () => {
    const printed = Object.assign(new Error('MiniProgramError\n请求被取消'), {
      name: 'AbortError',
      stack: 'AbortError: MiniProgramError\n请求被取消\n    at Object.errorReport (http://localhost:3000/__baselib__/WAService.js:1:174030)'
    });
    expect(caughtError(printed)).toEqual({ message: '请求被取消', stack: undefined });
  });

  it('基础库拼成字符串打印时，多行的错误信息完整保留，不重复栈开头的那一遍', () => {
    const at = frame('onLoad', 'pages/index/index.js', 6);
    expect(caughtError(`MiniProgramError\n请求失败\nstatus: 403\nError: 请求失败\nstatus: 403\n${at}`)).toEqual({ message: '请求失败\nstatus: 403', stack: at });
  });

  it('未处理的 Promise 拒绝打印成字符串时前面有 (in promise)', () => {
    expect(caughtError('(in promise) MiniProgramError\n拒绝了\n')?.message).toBe('拒绝了');
  });

  it('业务代码自己打印的 console.error 不算', () => {
    expect(caughtError('加载失败')).toBeNull();
    expect(caughtError(new Error('加载失败'))).toBeNull();
    expect(caughtError(undefined)).toBeNull();
  });
});

describe('RecentErrors', () => {
  it('同一个错误从全局 error 和基础库的 console.error 两路报来，只记一次', () => {
    const recent = new RecentErrors();
    const stack = `Error: 定时器里出错\n${frame('<anonymous>', 'pages/index/index.js', 9)}`;
    expect(recent.isRepeated('service', 0, '定时器里出错', stack)).toBe(false);
    // 拼成字符串打印的栈拆不出开头的 Error: … 那行
    expect(recent.isRepeated('service', 0, '定时器里出错', caughtError(`MiniProgramError\n定时器里出错\n${stack}`)!.stack)).toBe(true);
  });

  it('一秒内不同位置、不同页面抛出的同名错误各记各的', () => {
    const recent = new RecentErrors();
    const message = "Cannot read properties of undefined (reading 'name')";
    expect(recent.isRepeated('service', 0, message, `TypeError: ${message}\n${frame('loadList', 'pages/a/a.js', 10)}`)).toBe(false);
    expect(recent.isRepeated('service', 0, message, `TypeError: ${message}\n${frame('render', 'pages/b/b.js', 20)}`)).toBe(false);
    expect(recent.isRepeated('webview', 2, message)).toBe(false);
    expect(recent.isRepeated('webview', 3, message)).toBe(false);
  });
});
