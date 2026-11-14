/**
 * 执行 setup：在逻辑层创建之前预置存储、覆盖原生 API
 *
 * 必须早于小程序启动：基础库会把读过的存储缓存在内存里，启动后再从宿主写入，
 * wx.getStorageSync 读不到新值。
 */

import type { MockValue, RouteHandler, SetupApi, SetupConfig, SetupEnv, WebViewUrlRewrite } from '../../setup';
import { proxyFetch } from './api/network';
import type { ApiRegistry } from './api/registry';
import type { RequestRoutes } from './api/routes';
import { decodeStorageValue, encodeStorageValue, MiniProgramStorage } from './api/storage';
import type { WebViewUrlHooks } from './webViewUrlHooks';

export interface SetupTarget {
  storage: MiniProgramStorage;
  api: ApiRegistry;
  routes: RequestRoutes;
  webViews: WebViewUrlHooks;
}

export interface SetupSummary {
  storage: string[];
  mock: string[];
  network: string[];
  webView: number;
}

const CONFIG_KEYS = ['storage', 'mock', 'network', 'webView', 'run'];
const NETWORK_KEYS = ['routes'];
const WEBVIEW_KEYS = ['rewriteUrl'];
const STORAGE_NAMESPACE = 's0';

/** 基础库里这些 API 不经同名 invoke 实现，按 wx 的名字 mock 不会生效 */
export const TASK_APIS = new Set(['request', 'downloadFile', 'uploadFile', 'connectSocket']);
const STORAGE_API = /^(get|set|remove|clear)Storage(Info)?(Sync)?$/;

/**
 * @param definition setup 文件的默认导出
 * @param env 暴露给 setup 的环境变量
 * @throws 配置写错或 setup 自身执行出错时；此时已应用的部分不会回滚，调用方不应继续启动小程序
 */
export async function applySetup(definition: unknown, target: SetupTarget, env: SetupEnv): Promise<SetupSummary> {
  const summary: SetupSummary = { storage: [], mock: [], network: [], webView: 0 };
  const record = (list: string[], name: string) => {
    if (!list.includes(name)) list.push(name);
  };

  const setStorage = (key: string, value: unknown, label = key) => {
    let encoded;
    try {
      encoded = encodeStorageValue(value);
    } catch (error) {
      throw new Error(`storage.${label}：${(error as Error).message}`);
    }
    target.storage.set(STORAGE_NAMESPACE, key, encoded.data, encoded.dataType);
    record(summary.storage, key);
  };

  const mock = (api: string, impl: MockValue) => {
    checkMock(api, impl);
    target.api.mock(api, impl);
    record(summary.mock, api);
  };

  const route = (pattern: string, handler: RouteHandler) => {
    try {
      target.routes.add(pattern, handler);
    } catch (error) {
      throw new Error(`network.routes[${JSON.stringify(pattern)}]：${(error as Error).message}`);
    }
    record(summary.network, pattern);
  };

  const rewriteWebViewUrl = (rewrite: WebViewUrlRewrite) => {
    if (typeof rewrite !== 'function') throw new Error('rewriteWebViewUrl 需要传入函数');
    target.webViews.add(rewrite);
    summary.webView = target.webViews.size;
  };

  const config = await resolveConfig(definition, env);

  for (const [key, value] of Object.entries(config.storage || {})) setStorage(key, value);
  for (const [api, impl] of Object.entries(config.mock || {})) mock(api, impl);
  for (const [pattern, handler] of Object.entries(config.network?.routes || {})) route(pattern, handler);
  if (config.webView?.rewriteUrl) rewriteWebViewUrl(config.webView.rewriteUrl);

  if (config.run) {
    const wxa: SetupApi = {
      env,
      storage: {
        get: key => {
          const item = target.storage.get(STORAGE_NAMESPACE, key);
          return item ? decodeStorageValue(item) : undefined;
        },
        set: (key, value) => setStorage(key, value),
        remove: key => target.storage.remove(STORAGE_NAMESPACE, key),
        clear: () => target.storage.clear(STORAGE_NAMESPACE)
      },
      mock: (api, impl) => mock(api, impl as MockValue),
      route,
      rewriteWebViewUrl,
      fetch: (url, init = {}) => proxyFetch(url, { method: (init.method || 'GET').toUpperCase(), header: init.header, body: init.body })
        .then(res => new Response(NULL_BODY_STATUS.has(res.statusCode) ? null : res.response.body, {
          status: res.statusCode,
          headers: res.header
        }))
    };
    await config.run(wxa);
  }

  return summary;
}

export function formatSetupSummary(summary: SetupSummary): string {
  const lines = ['[wxa-runner] setup 已应用'];
  if (summary.storage.length) lines.push(`  storage  ${summary.storage.join(', ')}`);
  if (summary.mock.length) lines.push(`  mock     ${summary.mock.join(', ')}`);
  if (summary.network.length) lines.push(`  network  ${summary.network.join(', ')}`);
  if (summary.webView) lines.push(`  webView  ${summary.webView} 条改写规则`);
  return lines.join('\n');
}

const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

async function resolveConfig(definition: unknown, env: SetupEnv): Promise<SetupConfig> {
  const config = typeof definition === 'function' ? await definition({ env }) : definition;
  if (!isPlainObject(config)) {
    throw new Error('setup 文件需要 export default 一个配置对象，或返回配置对象的函数（可用 defineSetup 包一层获得类型提示）');
  }

  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(`未知的配置项 ${unknown.join(', ')}，可用的配置项：${CONFIG_KEYS.join(', ')}`);
  }
  if (config.storage !== undefined && !isPlainObject(config.storage)) throw new Error('storage 需要是 { key: 值 } 形式的对象');
  if (config.mock !== undefined && !isPlainObject(config.mock)) throw new Error('mock 需要是 { API 名: 返回值或函数 } 形式的对象');
  if (config.network !== undefined) {
    if (!isPlainObject(config.network)) throw new Error('network 需要是 { routes: { 规则: 响应 } } 形式的对象');
    const unknownNetwork = Object.keys(config.network).filter(key => !NETWORK_KEYS.includes(key));
    if (unknownNetwork.length) throw new Error(`network 下未知的配置项 ${unknownNetwork.join(', ')}，可用的配置项：${NETWORK_KEYS.join(', ')}`);
    if (config.network.routes !== undefined && !isPlainObject(config.network.routes)) {
      throw new Error('network.routes 需要是 { 规则: 响应 } 形式的对象');
    }
  }
  if (config.webView !== undefined) {
    if (!isPlainObject(config.webView)) throw new Error('webView 需要是 { rewriteUrl: 函数 } 形式的对象');
    const unknownWebView = Object.keys(config.webView).filter(key => !WEBVIEW_KEYS.includes(key));
    if (unknownWebView.length) {
      throw new Error(`webView 下未知的配置项 ${unknownWebView.join(', ')}，可用的配置项：${WEBVIEW_KEYS.join(', ')}`);
    }
    if (config.webView.rewriteUrl !== undefined && typeof config.webView.rewriteUrl !== 'function') {
      throw new Error('webView.rewriteUrl 需要是函数，返回新的地址；不替换时返回 undefined');
    }
  }
  if (config.run !== undefined && typeof config.run !== 'function') throw new Error('run 需要是函数');
  return config as SetupConfig;
}

function checkMock(api: string, impl: unknown) {
  if (TASK_APIS.has(api)) {
    throw new Error(`mock.${api}：wx.${api} 由基础库内部的任务实现，mock 无法覆盖；拦截 wx.request 请用 network.routes（请求拦截）`);
  }
  if (STORAGE_API.test(api)) {
    throw new Error(`mock.${api}：存储数据请用 storage 预置，不要覆盖存储 API`);
  }
  if (typeof impl !== 'function' && !isPlainObject(impl)) {
    throw new Error(`mock.${api}：需要是作为调用结果的对象，或按调用参数返回结果的函数`);
  }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return Object.prototype.toString.call(value) === '[object Object]';
}
