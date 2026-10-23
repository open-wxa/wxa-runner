/**
 * 逻辑层的原生 WeixinWorker：基础库的 wx.createWorker 用它创建 Worker、收发消息，Worker 那一端见 runtime/worker.ts
 *
 * 和开发者工具一样，每个 Worker 是一个浏览器的 Web Worker，加载 /__wxa__/worker.js（server/html.ts 的 workerScript）。
 * create 收到的脚本名总是 workers.js（整个 workers 目录），业务指定的入口随后由基础库发消息让 Worker 去 require。
 * 基础库加载时把全局的 WeixinWorker 换成自己的包装，原始对象留给自己调用；Worker 发来的消息交给包装上的 workerMsgHandler
 */

import { fileSession } from './fileSession';
import type { FromWorkerMessage, HostApi, ToWorkerMessage } from './types';

interface CreateOptions {
  /** Worker 里允许调用的原生接口 */
  APIList?: string[];
}

/** 必须在基础库之前调用：基础库加载后会从全局的 __wxConfig 里删掉 workers */
export function createWeixinWorker(win: Window, host: HostApi) {
  const g = win as any;
  const configured = !!g.__wxConfig?.workers;
  const workers = new Map<number, Worker>();
  let nextId = 1;

  const send = (worker: Worker, message: ToWorkerMessage) => worker.postMessage(message);

  const reportError = (id: number, error: { message: string; stack?: string }) => {
    host.reportError('service', 0, error);
    // 基础库收到后交给业务的 worker.onError，没有注册时打印到逻辑层的控制台
    g.WeixinWorker.workerMsgHandler(id, { __cmd__: 'workerUncaughtError', __data__: error });
  };

  // Worker 以逻辑层的身份调用宿主：结果先复制到逻辑层，接口的事件也只发给逻辑层。现在能用的都是只有回调的接口，
  // 带事件的（request、connectSocket、音频）建任务要用同步接口，已在 Worker 里直接失败。
  // 支持它们之前先把 Host.invoke 的「执行接口」和「交付结果、派发事件」拆开，让宿主知道调用方是哪个 Worker，不要在这里加 Worker 的特例
  const invoke = (worker: Worker, allowed: Set<string>, { api, args, callbackId }: Extract<FromWorkerMessage, { type: 'invoke' }>) => {
    const reply = (result: unknown) => send(worker, { type: 'callback', callbackId, result });
    if (!allowed.has(api)) reply({ errMsg: `${api}:fail not support` });
    else host.invoke('service', win, api, args, reply);
  };

  return {
    /** 返回 Worker 的编号；没有配置 workers 时返回 -1，基础库报告 Worker 不存在 */
    create(_script: string, options: CreateOptions = {}): number {
      if (!configured) return -1;
      const id = nextId++;
      const url = `/__wxa__/worker.js?id=${id}&session=${fileSession()}`;
      const worker = new Worker(url);
      const allowed = new Set(options.APIList || []);
      worker.addEventListener('message', ({ data }: MessageEvent<FromWorkerMessage>) => {
        if (data.type === 'message') g.WeixinWorker.workerMsgHandler(id, data.data);
        else if (data.type === 'invoke') invoke(worker, allowed, data);
        else reportError(id, { message: data.message, stack: data.stack });
      });
      // 冒泡到这里的只有 Worker 基础库加载前的异常（入口或基础库加载失败等），之后的由基础库处理，见 runtime/worker.ts。
      // 入口加载失败时是没有 message 的普通 Event。不取消的话，浏览器会把它当作逻辑层的未捕获异常再报告一次
      worker.addEventListener('error', event => {
        event.preventDefault();
        reportError(id, { message: event.message || `[wxa-runner] Worker 启动失败：加载 ${url} 失败` });
      });
      workers.set(id, worker);
      return id;
    },
    /** 基础库内部的消息（如 setSharedBuffer、readCompressedFile 的结果）不序列化，直接给对象 */
    postMsgToWorker(id: number, message: unknown) {
      const worker = workers.get(id);
      if (worker) send(worker, { type: 'message', data: typeof message === 'string' ? JSON.parse(message) : message });
    },
    terminate(id: number) {
      workers.get(id)?.terminate();
      workers.delete(id);
    }
  };
}
