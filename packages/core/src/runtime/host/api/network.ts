/**
 * 网络 API：wx.request / downloadFile / uploadFile / connectSocket
 *
 * 基础库 3.x 的协议是「创建任务同步返回 taskId，结果通过 on<Type>TaskStateChange 事件推送」。
 * HTTP 请求经开发服务器的 /__wxa__/proxy/ 转发：既绕开 CORS，也能携带浏览器禁止设置的
 * cookie / referer 等请求头。地址的写法见 networkPanel.ts
 *
 * 基础库自己的请求（数据上报、配置拉取等）不发出，只放行 InnerAudioContext 下载音频，见 byCaller。
 */

import type { MockRequest } from '../../../setup';
import { PROXY_PREFIX, toServerPath } from '../../networkPanel';
import { ApiHandler, fail, ok } from './registry';
import type { MockedResponse, RequestRoutes } from './routes';
import { saveTempFile, tempFileType } from './tempFiles';

export interface NetworkApiOptions {
  /** 向逻辑层派发事件 */
  emit: (event: string, data: Record<string, unknown>) => void;
  defaultTimeout: () => number;
  /** 请求拦截，只作用于 wx.request */
  routes?: RequestRoutes;
  /** wx.request 发出时调用，早于拦截和转发 */
  onRequest?: (request: RecordedRequest) => void;
  /** 被拦截的 wx.request 开始生成响应时调用，用来在 Network 面板里显示它（见 mockMirror.ts）；signal 在请求取消、超时时 abort */
  onMocked?: (request: MockRequest, response: Promise<MockedResponse>, signal: AbortSignal) => void;
}

/** 小程序发出的一个 wx.request */
export interface RecordedRequest extends MockRequest {
  /** 拦截它的规则（setup 的 network.routes 或测试 API 的 route），经代理发往网络时为 null */
  routedBy: string | null;
}

/** 最近发出的 wx.request。平时调试不跑测试时也在记录，只保留最近的 limit 个，内存不会一直增长 */
export class RequestLog {
  private items: RecordedRequest[] = [];

  constructor(private readonly limit = 1000) {}

  add(request: RecordedRequest) {
    this.items.push(request);
    if (this.items.length > this.limit) this.items.splice(0, this.items.length - this.limit);
  }

  /** 按发出顺序；返回副本，修改它不影响记录 */
  list(): RecordedRequest[] {
    return this.items.map(request => ({ ...request, header: { ...request.header } }));
  }

  clear() {
    this.items = [];
  }
}

interface ProxyResponse {
  statusCode: number;
  header: Record<string, string>;
  cookies: string[];
  response: Response;
}

let taskSeq = 0;

export function createNetworkApis(options: NetworkApiOptions): Record<string, ApiHandler> {
  const controllers = new Map<string, AbortController>();
  const sockets = new Map<string, WebSocket>();
  const { emit } = options;

  const startTask = (args: any, run: (signal: AbortSignal, id: string) => Promise<void>): string => {
    const id = String(++taskSeq);
    const controller = new AbortController();
    const timeout = args.timeout || options.defaultTimeout();
    const timer = timeout > 0 ? setTimeout(() => controller.abort(new Error('timeout')), timeout) : null;
    controllers.set(id, controller);
    // 任务 id 先同步返回给基础库，结果事件之后再推送
    setTimeout(() => {
      run(controller.signal, id).finally(() => {
        if (timer) clearTimeout(timer);
        controllers.delete(id);
      });
    }, 0);
    return id;
  };

  const abortTask = (args: any, key: string) => {
    if (args.operationType === 'abort') controllers.get(String(args[key]))?.abort(new Error('abort'));
  };

  const createRequestTask: ApiHandler = (args, { api }) => {
    const request: MockRequest = { url: args.url, method: (args.method || 'GET').toUpperCase(), header: { ...args.header }, data: args.data };
    // 发出时就确定是否拦截：记录里能看到命中的规则，之后增删规则不影响已发出的请求
    const route = options.routes?.match(request);
    options.onRequest?.({ ...request, header: { ...request.header }, routedBy: route ? route.pattern : null });

    const requestTaskId = startTask(args, async (signal, id) => {
      try {
        const mocked = route?.respond(signal);
        if (mocked) options.onMocked?.(request, mocked, signal);
        const res: ProxyResponse = mocked
          ? await mocked.then(({ statusCode, header, body }) => ({ statusCode, header, cookies: [], response: new Response(body) }))
          : await proxyFetch(request.url, { method: request.method, header: args.header, body: args.data, signal });
        emit('onRequestTaskStateChange', {
          requestTaskId: id, state: 'headersReceived', header: res.header, statusCode: res.statusCode, cookies: res.cookies
        });
        // 和真机一样由 responseType 决定拿到文本还是 ArrayBuffer，与响应内容无关，拦截规则给的响应也是
        let data: string | ArrayBuffer;
        if (args.enableChunked && res.response.body) {
          const reader = res.response.body.getReader();
          const chunks: Uint8Array[] = [];
          let length = 0;
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              chunks.push(value);
              length += value.byteLength;
              emit('onRequestTaskStateChange', {
                requestTaskId: id, state: 'chunked', data: value.slice().buffer
              });
            }
          } finally {
            reader.releaseLock();
          }
          // success 仍返回完整响应；先拼字节再解码，避免 UTF-8 字符跨块时被破坏。
          const bytes = new Uint8Array(length);
          let offset = 0;
          for (const chunk of chunks) {
            bytes.set(chunk, offset);
            offset += chunk.byteLength;
          }
          data = args.responseType === 'arraybuffer' ? bytes.buffer : new TextDecoder().decode(bytes);
        } else {
          data = args.responseType === 'arraybuffer' ? await res.response.arrayBuffer() : await res.response.text();
        }
        emit('onRequestTaskStateChange', {
          requestTaskId: id, state: 'success', data, statusCode: res.statusCode, header: res.header, cookies: res.cookies, profile: {}
        });
      } catch (error) {
        emit('onRequestTaskStateChange', { requestTaskId: id, state: 'fail', errMsg: `request:fail ${reason(error)}` });
      }
    });
    return ok(api, { requestTaskId });
  };

  const createDownloadTask: ApiHandler = (args, { api }) => {
    const downloadTaskId = startTask(args, async (signal, id) => {
      try {
        const res = await proxyFetch(args.url, { method: 'GET', header: args.header, signal });
        emit('onDownloadTaskStateChange', { downloadTaskId: id, state: 'headersReceived', header: res.header, cookies: res.cookies });
        const blob = await res.response.blob();
        emit('onDownloadTaskStateChange', {
          downloadTaskId: id, state: 'progressUpdate', progress: 100, totalBytesWritten: blob.size, totalBytesExpectedToWrite: blob.size
        });
        // 不用 blob: 地址：image 组件会把它当成页面相对路径
        const fileName = new URL(args.url).pathname.split('/').pop() || '';
        const tempFilePath = await saveTempFile(blob, tempFileType(fileName, blob.type, 'tmp'));
        emit('onDownloadTaskStateChange', {
          downloadTaskId: id,
          state: 'success',
          tempFilePath,
          statusCode: res.statusCode,
          header: res.header,
          profile: {}
        });
      } catch (error) {
        emit('onDownloadTaskStateChange', { downloadTaskId: id, state: 'fail', errMsg: `downloadFile:fail ${reason(error)}` });
      }
    });
    return ok(api, { downloadTaskId });
  };

  const createUploadTask: ApiHandler = (args, { api }) => {
    const uploadTaskId = startTask(args, async (signal, id) => {
      try {
        const source = await fetch(args.filePath);
        if (!source.ok) throw new Error(`file not exist ${args.filePath}`);
        const file = await source.blob();
        const form = new FormData();
        for (const [key, value] of Object.entries(args.formData || {})) form.append(key, String(value));
        form.append(args.name || 'file', file, String(args.filePath).split('/').pop() || 'file');

        const res = await proxyFetch(args.url, { method: 'POST', header: args.header, body: form, signal });
        const data = await res.response.text();
        emit('onUploadTaskStateChange', {
          uploadTaskId: id, state: 'progressUpdate', progress: 100, totalBytesSent: file.size, totalBytesExpectedToSend: file.size
        });
        emit('onUploadTaskStateChange', { uploadTaskId: id, state: 'success', data, statusCode: res.statusCode, header: res.header });
      } catch (error) {
        emit('onUploadTaskStateChange', { uploadTaskId: id, state: 'fail', errMsg: `uploadFile:fail ${reason(error)}` });
      }
    });
    return ok(api, { uploadTaskId });
  };

  const createSocketTask: ApiHandler = (args, { api }) => {
    const socketTaskId = String(++taskSeq);
    let socket: WebSocket;
    try {
      socket = new WebSocket(args.url, args.protocols && args.protocols.length ? args.protocols : undefined);
    } catch (error) {
      return fail(api, reason(error));
    }
    socket.binaryType = 'arraybuffer';
    sockets.set(socketTaskId, socket);
    socket.onopen = () => emit('onSocketTaskStateChange', { socketTaskId, state: 'open', header: {}, profile: {} });
    socket.onmessage = event => emit('onSocketTaskStateChange', { socketTaskId, state: 'message', data: event.data });
    socket.onerror = () => emit('onSocketTaskStateChange', { socketTaskId, state: 'error', errMsg: 'connectSocket:fail' });
    socket.onclose = event => {
      sockets.delete(socketTaskId);
      emit('onSocketTaskStateChange', { socketTaskId, state: 'close', code: event.code, reason: event.reason });
    };
    return ok(api, { socketTaskId });
  };

  const operateSocketTask: ApiHandler = (args, { api }) => {
    const socket = sockets.get(String(args.socketTaskId));
    if (!socket) return fail(api, 'socket task not found');
    if (args.operationType === 'send') {
      if (socket.readyState !== WebSocket.OPEN) return fail(api, 'socket is not open');
      socket.send(args.data);
    } else if (args.operationType === 'close') {
      socket.close(args.code || 1000, args.reason);
    }
    return ok(api);
  };

  /** 不是小程序的 wx.request：不记录，也不经拦截规则 */
  const downloadAudio: ApiHandler = (args, { api }) => {
    const requestTaskId = startTask(args, async (signal, id) => {
      try {
        const res = await proxyFetch(args.url, { method: 'GET', header: args.header, signal });
        const meta = { requestTaskId: id, statusCode: res.statusCode, header: res.header, cookies: res.cookies };
        emit('onRequestTaskStateChange', { ...meta, state: 'headersReceived' });
        emit('onRequestTaskStateChange', { ...meta, state: 'success', data: await res.response.arrayBuffer(), profile: {} });
      } catch (error) {
        emit('onRequestTaskStateChange', { requestTaskId: id, state: 'fail', errMsg: `request:fail ${reason(error)}` });
      }
    });
    return ok(api, { requestTaskId });
  };

  // 基础库自己的请求只放行下载音频
  const requestTask = byCaller(createRequestTask, (args, context) => (isAudioDownload(args)
    ? downloadAudio(args, context)
    : rejectBaseLib(args, context)));
  const downloadTask = byCaller(createDownloadTask);
  const uploadTask = byCaller(createUploadTask);

  return {
    createRequestTask: requestTask,
    createRequestTaskAsync: requestTask,
    createDownloadTask: downloadTask,
    createDownloadTaskAsync: downloadTask,
    createUploadTask: uploadTask,
    createUploadTaskAsync: uploadTask,
    createSocketTask: byCaller(createSocketTask),
    operateRequestTask: args => abortTask(args, 'requestTaskId'),
    operateDownloadTask: args => abortTask(args, 'downloadTaskId'),
    operateUploadTask: args => abortTask(args, 'uploadTaskId'),
    operateSocketTask
  };
}

const rejectBaseLib: ApiHandler = (_args, { api }) => fail(api, '基础库内部的网络请求，wxa-runner 不发出');

/**
 * 小程序（含插件）的请求交给 forApp；基础库自己的网络请求（数据上报、配置拉取等）默认直接按失败返回：不发往网络，也不记入请求记录
 *
 * 它们连的是微信后台，与被测的小程序无关，测试和 CI 里不该因此产生对外请求。基础库通过
 * _requestSkipCheckDomain 一类内部接口发出，带 __skipDomainCheck__ 标记；小程序的 wx.request 不带。
 * 插件的请求也带这个标记（基础库已按插件的域名校验过），但同时带着插件签名头 X-WECHAT-HOSTSIGN
 */
function byCaller(forApp: ApiHandler, forBaseLib = rejectBaseLib): ApiHandler {
  return (args, context) => (args?.__skipDomainCheck__ === true && !hasPluginSign(args) ? forBaseLib(args, context) : forApp(args, context));
}

function hasPluginSign(args: any): boolean {
  return Object.keys(args.header || {}).some(name => name.toLowerCase() === 'x-wechat-hostsign');
}

/**
 * 基础库为 InnerAudioContext 下载音频的请求：用 Web Audio 播放时先把音频地址下载成 ArrayBuffer
 * （3.5.8 起平台是 devtools 时默认用 Web Audio，更早的版本要业务指定 useWebAudioImplement，否则调原生接口，见 audio.ts）。
 * 2.32.3 到 3.17.4 都是这个形状，基础库自己的其他请求不会同时带这两个参数
 */
function isAudioDownload(args: any): boolean {
  return args.responseType === 'arraybuffer' && args.enableCache === true;
}

export async function proxyFetch(
  url: string,
  init: { method: string; header?: Record<string, string>; body?: unknown; signal?: AbortSignal }
): Promise<ProxyResponse> {
  const path = toServerPath(PROXY_PREFIX, url);
  if (!path) throw new Error(`invalid url "${url}"`);

  const response = await fetch(path, {
    method: init.method,
    headers: { 'x-wxa-headers': JSON.stringify(init.header || {}) },
    body: hasRequestBody(init.method, init.body) ? init.body as BodyInit : undefined,
    signal: init.signal
  });

  if (response.headers.get('x-wxa-proxy-error')) {
    throw new Error(await response.text());
  }

  return {
    statusCode: response.status,
    header: JSON.parse(decodeURIComponent(response.headers.get('x-wxa-headers') || '%7B%7D')),
    cookies: JSON.parse(decodeURIComponent(response.headers.get('x-wxa-set-cookie') || '%5B%5D')),
    response
  };
}

/** fetch 不允许 GET、HEAD 带请求体；空字符串也不发，和不带一样 */
export function hasRequestBody(method: string, body: unknown): boolean {
  return body !== undefined && body !== '' && !['GET', 'HEAD'].includes(method);
}

function reason(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'abort';
  return error instanceof Error ? error.message : String(error);
}
