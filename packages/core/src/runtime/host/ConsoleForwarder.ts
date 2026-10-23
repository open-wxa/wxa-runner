/**
 * 把浏览器里的报错整理成一行行文字，交给开发服务器打印到终端（见 server/forwardConsole.ts）
 *
 * 编程助手自己启动开发服务器时只看得到终端，页面报错转发过来它才知道改出了问题。
 * 栈只留业务代码的帧，地址换成项目里的路径：基础库和运行时的帧对排查业务问题没有帮助
 */

import type { ConsoleLevel } from '../consoleHook';
import type { ForwardConsole, FrameKind } from '../types';

/** 发给开发服务器的消息 */
export interface ConsoleReport {
  type: 'console';
  level: ConsoleLevel;
  text: string;
}

/** 定时器里抛出的错误既触发全局 error 事件，又被基础库用 console.error 打印：同一条错误这段时间内只转发一次 */
const DEDUPE_MS = 1000;
/** 单个 console 参数的长度上限，大对象不能把终端刷屏 */
const MAX_ARG_LENGTH = 1000;
/** 整条消息的长度上限：开发服务器只接收 64KB 以内的消息，一个字符的 UTF-8 编码最多 3 字节 */
const MAX_TEXT_LENGTH = 8000;
const LAYERS: Record<FrameKind, string> = { service: '逻辑层', webview: '渲染层' };
/** 基础库捕获业务代码的错误后打印的开头；未处理的 Promise 拒绝打印成字符串时前面还有 (in promise) */
const MINI_PROGRAM_ERROR = /^(\(in promise\) )?MiniProgramError\n/;
const MODULE_URL = /\bhttps?:\/\/[^/\s]+\/__wxa__\/module\/([^?\s)]+?)(?:\?[^:\s)]*)?:(\d+):(\d+)/;

export class ConsoleForwarder {
  private readonly recentErrors = new Map<string, number>();

  /** @param pageOf 出错的页面路径，不知道时返回 undefined */
  constructor(
    readonly mode: ForwardConsole,
    private readonly send: (report: ConsoleReport) => void,
    private readonly pageOf: (kind: FrameKind, webviewId: number) => string | undefined
  ) {}

  /** 运行时错误：全局 error、未处理的 Promise 拒绝、基础库捕获的业务代码错误 */
  error(kind: FrameKind, webviewId: number, message: string, stack?: string) {
    const frames = businessFrames(stack);
    if (!this.mode || this.isRepeated(`${kind}:${webviewId}:${message}\n${frames}`)) return;
    this.post('error', `${this.origin(kind, webviewId)}报错：${message}${frames ? `\n${frames}` : ''}`);
  }

  /** 运行时自己的提醒，如调用了未实现的 wx API */
  warn(text: string) {
    if (this.mode) this.post('warn', text);
  }

  /** iframe 里的 console.warn / console.error；基础库捕获业务代码错误后打印的 console.error 按报错转发 */
  console(kind: FrameKind, webviewId: number, level: ConsoleLevel, args: unknown[]) {
    const thrown = level === 'error' ? miniProgramError(args[0]) : null;
    if (thrown) {
      this.error(kind, webviewId, thrown.message, thrown.stack);
    } else if (this.mode === 'all') {
      this.post(level, `${this.origin(kind, webviewId)} console.${level}：${args.map(formatArg).join(' ')}`);
    }
  }

  private post(level: ConsoleLevel, text: string) {
    this.send({ type: 'console', level, text: text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text });
  }

  private origin(kind: FrameKind, webviewId: number): string {
    const page = this.pageOf(kind, webviewId);
    return page ? `${LAYERS[kind]}（${page}）` : LAYERS[kind];
  }

  /** @param key 来源、错误信息和业务代码的帧：两路报来的同一个错误相同，不同位置抛出的同名错误不同 */
  private isRepeated(key: string): boolean {
    const now = Date.now();
    for (const [recent, time] of this.recentErrors) {
      if (now - time >= DEDUPE_MS) this.recentErrors.delete(recent);
    }
    if (this.recentErrors.has(key)) return true;
    this.recentErrors.set(key, now);
    return false;
  }
}

/** 错误对象可能来自 iframe，跨 realm 的 instanceof Error 不成立 */
function isErrorLike(value: unknown): value is Error {
  return typeof value === 'object' && value !== null && typeof (value as Error).message === 'string';
}

/**
 * 基础库打印的业务代码错误：开发者工具平台是 Error 对象，其他平台是拼好的字符串 `${message}\n${stack}`，
 * V8 的栈开头又重复一遍 `Error: ${message}`，错误信息可能有多行
 */
function miniProgramError(value: unknown): { message: string; stack?: string } | null {
  if (isErrorLike(value) && MINI_PROGRAM_ERROR.test(value.message)) {
    return { message: value.message.replace(MINI_PROGRAM_ERROR, ''), stack: value.stack };
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

/** 栈里业务代码的帧，如 at onLoad (pages/index/index.js:6:11) */
function businessFrames(stack: string | undefined): string {
  return (stack || '')
    .split('\n')
    .filter(line => /^\s*at /.test(line) && MODULE_URL.test(line))
    .map(line => `    ${line.trim().replace(MODULE_URL, '$1:$2:$3')}`)
    .join('\n');
}

function formatArg(arg: unknown): string {
  if (typeof arg === 'string') return truncate(arg);
  if (isErrorLike(arg)) {
    const frames = businessFrames(arg.stack);
    return truncate(`${arg.name || 'Error'}: ${arg.message}`) + (frames ? `\n${frames}` : '');
  }
  try {
    const json = JSON.stringify(arg);
    if (json !== undefined) return truncate(json);
  } catch {
    // 循环引用等，退回 String
  }
  return truncate(String(arg));
}

function truncate(text: string): string {
  return text.length > MAX_ARG_LENGTH ? `${text.slice(0, MAX_ARG_LENGTH)}…` : text;
}
