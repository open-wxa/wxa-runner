/**
 * 请求拦截：setup 的 network.routes、测试 API 的 route 声明的接口不发往网络，直接返回给定的响应
 *
 * 规则写法：'[METHOD ]URL'，如 'POST https://api.example.com/login'。URL 里 * 匹配一段路径，
 * ** 匹配任意内容（可以不写域名，按路径匹配）；查询参数和 hash 不参与匹配。
 */

import type { MockRequest, MockResponse, RouteHandler } from '../../../setup';

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS', 'TRACE', 'CONNECT'];

interface Route {
  pattern: string;
  matches: RequestMatcher;
  handler: RouteHandler;
}

type RequestMatcher = (request: Pick<MockRequest, 'url' | 'method'>) => boolean;

/** 拦截规则给出的响应。响应体原样是文本或二进制，小程序拿到哪种由请求的 responseType 决定 */
export interface MockedResponse {
  statusCode: number;
  header: Record<string, string>;
  body: string | BufferSource;
}

export interface MatchedRoute {
  /** 命中的规则，即添加时的写法 */
  pattern: string;
  /** @throws 延迟期间 signal 被 abort 时，抛出 signal.reason */
  respond(signal?: AbortSignal): Promise<MockedResponse>;
}

export class RequestRoutes {
  private routes: Route[] = [];

  /**
   * 后添加的规则优先
   * @throws 规则写法不对时
   */
  add(pattern: string, handler: RouteHandler) {
    const matches = compilePattern(pattern);
    if (typeof handler !== 'function' && (handler === null || typeof handler !== 'object')) {
      throw new Error('拦截规则的值需要是响应对象 { status?, header?, body?, delay? }，或按请求返回响应的函数');
    }
    if (typeof handler === 'object') checkDelay(handler.delay);
    this.routes.unshift({ pattern, matches, handler });
  }

  /** 删除按这个写法添加的规则，不传时删除全部 */
  remove(pattern?: string) {
    this.routes = pattern === undefined ? [] : this.routes.filter(route => route.pattern !== pattern);
  }

  /** 找到匹配的规则，没有时返回 undefined。响应在调用 respond 时才生成 */
  match(request: MockRequest): MatchedRoute | undefined {
    const route = this.routes.find(r => r.matches(request));
    if (!route) return undefined;

    return {
      pattern: route.pattern,
      async respond(signal) {
        console.info(`[wxa-runner] 拦截请求 ${request.method} ${request.url}（${route.pattern}）`);
        const response: MockResponse = typeof route.handler === 'function' ? (await route.handler(request)) || {} : route.handler;
        checkDelay(response.delay);
        if (response.delay) await sleep(response.delay, signal);
        const { body } = response;
        const isJson = body !== undefined && typeof body !== 'string' && !isBinary(body);
        return {
          statusCode: response.status ?? 200,
          header: { ...(isJson ? { 'Content-Type': 'application/json' } : {}), ...response.header },
          body: body === undefined ? '' : isJson ? JSON.stringify(body) : (body as string | BufferSource)
        };
      }
    };
  }
}

/**
 * 把 '[METHOD ]URL' 规则编译成匹配函数，查询参数和 hash 不参与匹配
 * @throws 规则写法不对时
 */
export function compilePattern(pattern: string): RequestMatcher {
  const parts = pattern.trim().split(/\s+/);
  if (parts.length > 2 || (parts.length === 2 && !METHODS.includes(parts[0].toUpperCase()))) {
    throw new Error(`拦截规则应写成 "[请求方法 ]地址"，如 "POST https://api.example.com/login"、"**/auth/login"`);
  }
  const [method, url] = parts.length === 2 ? [parts[0].toUpperCase(), parts[1]] : [null, parts[0]];
  const regexp = globToRegExp(url);
  return request => (!method || method === request.method) && regexp.test(String(request.url).replace(/[?#].*$/, ''));
}

/** ArrayBuffer 和 Uint8Array 等视图（Node 的 Buffer 经 Playwright 传进来也是 Uint8Array），不论属于哪个 iframe */
function isBinary(value: unknown): value is BufferSource {
  return ArrayBuffer.isView(value) || Object.prototype.toString.call(value) === '[object ArrayBuffer]';
}

function checkDelay(delay: unknown) {
  if (delay !== undefined && !(typeof delay === 'number' && delay >= 0 && Number.isFinite(delay))) {
    throw new Error(`delay 需要是不小于 0 的毫秒数，实际是 ${String(delay)}`);
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  });
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .split('**')
    .map(part => part.split('*').map(escapeRegExp).join('[^/]*'))
    .join('.*');
  return new RegExp(`^${source}$`);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}
