/**
 * 把浏览器里的报错整理成一行行文字，交给开发服务器打印到终端（见 server/forwardConsole.ts）
 *
 * 编程助手自己启动开发服务器时只看得到终端，页面报错转发过来它才知道改出了问题。
 * 栈只留业务代码的帧，地址换成项目里的路径：基础库和运行时的帧对排查业务问题没有帮助
 */

import type { ConsoleLevel } from '../consoleHook';
import type { ForwardConsole, FrameKind } from '../types';
import { isErrorLike } from './frameErrors';

/** 发给开发服务器的消息 */
export interface ConsoleReport {
  type: 'console';
  level: ConsoleLevel;
  text: string;
}

/** 单个 console 参数的长度上限，大对象不能把终端刷屏 */
const MAX_ARG_LENGTH = 1000;
/** 整条消息的长度上限：开发服务器只接收 64KB 以内的消息，一个字符的 UTF-8 编码最多 3 字节 */
const MAX_TEXT_LENGTH = 8000;
const LAYERS: Record<FrameKind, string> = { service: '逻辑层', webview: '渲染层' };
const MODULE_URL = /\bhttps?:\/\/[^/\s]+\/__wxa__\/module\/([^?\s)]+?)(?:\?[^:\s)]*)?:(\d+):(\d+)/;

export class ConsoleForwarder {
  /**
   * @param pageOf 出错的页面路径，不知道时返回 undefined
   * @param hintsOf 附在报错后面的提示，帮开发者认出 wxa-runner 和真机不同造成的错误
   */
  constructor(
    readonly mode: ForwardConsole,
    private readonly send: (report: ConsoleReport) => void,
    private readonly pageOf: (kind: FrameKind, webviewId: number) => string | undefined,
    private readonly hintsOf: (kind: FrameKind) => string[] = () => []
  ) {}

  /** 运行时错误：全局 error、未处理的 Promise 拒绝、基础库捕获的业务代码错误。两路报来的同一个错误由宿主去重（见 frameErrors.ts） */
  error(kind: FrameKind, webviewId: number, message: string, stack?: string) {
    if (!this.mode) return;
    const frames = businessFrames(stack);
    const hints = this.hintsOf(kind).map(hint => `\n  提示：${hint}`).join('');
    this.post('error', `${this.origin(kind, webviewId)}报错：${message}${frames ? `\n${frames}` : ''}${hints}`);
  }

  /** 运行时自己的提醒，如调用了未实现的 wx API */
  warn(text: string) {
    if (this.mode) this.post('warn', text);
  }

  /** iframe 里的 console.warn / console.error；基础库捕获业务代码错误后打印的不经过这里，按报错转发 */
  console(kind: FrameKind, webviewId: number, level: ConsoleLevel, args: unknown[]) {
    if (this.mode === 'all') this.post(level, `${this.origin(kind, webviewId)} console.${level}：${args.map(formatArg).join(' ')}`);
  }

  private post(level: ConsoleLevel, text: string) {
    this.send({ type: 'console', level, text: text.length > MAX_TEXT_LENGTH ? `${text.slice(0, MAX_TEXT_LENGTH)}…` : text });
  }

  private origin(kind: FrameKind, webviewId: number): string {
    const page = this.pageOf(kind, webviewId);
    return page ? `${LAYERS[kind]}（${page}）` : LAYERS[kind];
  }
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
