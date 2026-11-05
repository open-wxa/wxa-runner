/**
 * 原生 API 注册表
 *
 * 处理函数返回结果对象（可以是 Promise）。结果能同步得到时同步回调——
 * 基础库在一些非 Sync 结尾的 API（如带 type 参数的 getSystemInfo）上也依赖同步回调。
 * 少数原生接口的结果是字符串，由基础库自己解析（如地图的 private_geolocation），原样交回。
 */

import type { FrameKind } from '../../types';

export type ApiResult = Record<string, any>;

export interface ApiContext {
  api: string;
  from: FrameKind;
  /** 发起调用的渲染层 id，逻辑层调用时为当前页面 */
  webviewId: number;
}

export type ApiHandler = (args: any, context: ApiContext) => ApiResult | string | void | Promise<ApiResult | string | void>;

/** 基础库内部频繁调用、无需提示的 API */
const SILENT_APIS = new Set([
  'reportKeyValue', 'reportIDKey', 'reportRealtimeAction', 'reportPerformance', 'systemLog', 'traceEvent',
  'getPermissionBytes', 'initRenderDone', 'saveInitialRenderingCache',
  'setKeyValue', 'invokeMiniProgramAPI', 'updatePerfData', 'reportSubmitForm',
  'initReady', 'noticePerformanceMetrics'
]);

export class ApiRegistry {
  private handlers = new Map<string, ApiHandler>();
  private mocks = new Map<string, ApiHandler>();
  private warned = new Set<string>();

  /** @param onUnimplemented 调用了没有实现、也没有 mock 的 API 时触发，每次调用都触发；基础库内部的上报类接口不触发 */
  constructor(private readonly onUnimplemented?: (context: ApiContext) => void) {}

  register(handlers: Record<string, ApiHandler>) {
    for (const [name, handler] of Object.entries(handlers)) {
      this.handlers.set(name, handler);
    }
  }

  has(api: string): boolean {
    return this.handlers.has(api) || this.mocks.has(api);
  }

  /** 测试用：覆盖某个 API；传入对象时直接作为结果返回 */
  mock(api: string, impl: ApiHandler | ApiResult) {
    this.mocks.set(api, typeof impl === 'function' ? impl as ApiHandler : () => impl as ApiResult);
  }

  unmock(api?: string) {
    if (api) this.mocks.delete(api);
    else this.mocks.clear();
  }

  invoke(api: string, args: any, context: ApiContext): ApiResult | string | Promise<ApiResult | string> {
    const handler = this.mocks.get(api) || this.handlers.get(api);

    if (!handler) {
      if (!SILENT_APIS.has(api)) {
        this.onUnimplemented?.(context);
        if (!this.warned.has(api)) {
          this.warned.add(api);
          console.warn(`[wxa-runner] wx.${api} 尚未实现，返回默认成功`, args);
        }
      }
      return { errMsg: `${api}:ok` };
    }

    try {
      const result = handler(args || {}, context);
      if (result && typeof (result as Promise<ApiResult>).then === 'function') {
        return (result as Promise<ApiResult | string | void>).then(
          value => normalize(api, value),
          error => failure(api, error)
        );
      }
      return normalize(api, result as ApiResult | string | void);
    } catch (error) {
      return failure(api, error);
    }
  }
}

export function ok(api: string, extra: ApiResult = {}): ApiResult {
  return { ...extra, errMsg: `${api}:ok` };
}

export function fail(api: string, reason: string, extra: ApiResult = {}): ApiResult {
  return { ...extra, errMsg: `${api}:fail ${reason}` };
}

function normalize(api: string, result: ApiResult | string | void): ApiResult | string {
  if (typeof result === 'string') return result;
  if (!result) return { errMsg: `${api}:ok` };
  return result.errMsg ? result : { ...result, errMsg: `${api}:ok` };
}

function failure(api: string, error: unknown): ApiResult {
  const message = error instanceof Error ? error.message : String(error);
  return { errMsg: `${api}:fail ${message}` };
}
