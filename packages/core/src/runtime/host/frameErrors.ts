/**
 * 小程序的运行时错误从两路报来：没处理的错误触发 iframe 的全局 error、unhandledrejection 事件；
 * 生命周期、事件处理函数、wx API 回调、定时器里抛出的错误多被基础库捕获，只用 console.error 打印，不触发全局事件。
 * 两路都要收集，errors() 才不漏；同一个错误可能两路都报来（如 3.7.0 定时器里抛出的），只记一次
 */

import type { FrameKind } from '../types';

/** 这段时间内来源、错误信息和栈都相同的错误当作同一个 */
const DEDUPE_MS = 1000;
/** 基础库捕获业务代码的错误后打印的开头；未处理的 Promise 拒绝打印成字符串时前面还有 (in promise) */
const MINI_PROGRAM_ERROR = /^(\(in promise\) )?MiniProgramError\n/;
const STACK_FRAME = /^\s*at /;

/** 错误对象可能来自 iframe，跨 realm 的 instanceof Error 不成立 */
export function isErrorLike(value: unknown): value is Error {
  return typeof value === 'object' && value !== null && typeof (value as Error).message === 'string';
}

/**
 * 基础库捕获后打印的业务代码错误，console.error 的第一个参数不是时返回 null。
 * 开发者工具平台是 Error 对象，其他平台是拼好的字符串 `${message}\n${stack}`，
 * V8 的栈开头又重复一遍 `Error: ${message}`，错误信息可能有多行
 */
export function caughtError(value: unknown): { message: string; stack?: string } | null {
  if (isErrorLike(value) && MINI_PROGRAM_ERROR.test(value.message)) {
    // 基础库把原错误的栈抄到打印的 Error 上；原错误没有栈时（如 DOMException）留下的是它自己的，开头是 MiniProgramError，不是出错的位置
    const ownStack = typeof value.stack === 'string' && /^[^\n]*MiniProgramError\n/.test(value.stack);
    return { message: value.message.replace(MINI_PROGRAM_ERROR, ''), stack: ownStack ? undefined : value.stack };
  }
  if (typeof value === 'string' && MINI_PROGRAM_ERROR.test(value)) {
    const text = value.replace(MINI_PROGRAM_ERROR, '');
    const firstFrame = text.search(/^\s*at /m);
    const head = (firstFrame < 0 ? text : text.slice(0, firstFrame)).replace(/\n$/, '');
    const message = /^([\s\S]*)\n[^\n]*?: \1$/.exec(head)?.[1] ?? head;
    return { message, stack: firstFrame < 0 ? undefined : text.slice(firstFrame) };
  }
  return null;
}

export class RecentErrors {
  private readonly recent = new Map<string, number>();

  /**
   * 比较栈里的各帧而不是整个栈：基础库打印成字符串时，栈开头的 `TypeError: …` 那行拆不出来。
   * 不同位置抛出的同名错误帧不同，各记各的
   */
  isRepeated(kind: FrameKind, webviewId: number, message: string, stack?: string): boolean {
    const frames = (stack || '').split('\n').filter(line => STACK_FRAME.test(line)).map(line => line.trim()).join('\n');
    const key = `${kind}:${webviewId}:${message}\n${frames}`;
    const now = Date.now();
    for (const [recent, time] of this.recent) {
      if (now - time >= DEDUPE_MS) this.recent.delete(recent);
    }
    if (this.recent.has(key)) return true;
    this.recent.set(key, now);
    return false;
  }
}
