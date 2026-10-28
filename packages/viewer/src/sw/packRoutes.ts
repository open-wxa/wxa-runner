/**
 * 查看器的 Service Worker 怎么应答请求：从 IndexedDB 里当前项目的 wxapack 生成 app-info、页面和代码，
 * 提供文件接口和静态资源（packSw.ts 只负责事件接线，这里可以直接在 vitest 里测）
 */

import { DEFAULT_DEVICE, extname, FileStore, hostHtml, mimeType, MOCK_ID_HEADER, MOCK_PREFIX, routeApp } from '@open-wxa/wxa-runner-core/web';
import type { AppInfo } from '@open-wxa/wxa-runner-core/web';
import { readPack } from '../pack/format';
import type { WxaPack } from '../pack/format';
import { getActiveProject } from '../store';
import type { ViewerProject } from '../store';

export interface PackRequestContext {
  origin: string;
  getActiveProject(): Promise<ViewerProject | null>;
  /** null：这个地址已经不是查看器站点（如同一端口换成了开发服务器），见 notViewer */
  getViewerConfig(): Promise<{ baseLibVersion: string } | null>;
  /** 发现不是查看器站点时调用一次，Service Worker 借此注销自己 */
  onNotViewer?(): void;
  fileSessions: Map<string, FileStore>;
  mockResponse?(clientId: string, id: string): Promise<Response>;
}

/**
 * 当前项目和解析好的包。IndexedDB 每次读出的都是整个包的拷贝，只在宿主启动（请求 app-info）或 Service Worker 重启后读一次，
 * 其余请求都用这里的：查看页面切换项目、改 setup 后会重载宿主，那时 app-info 会重新读
 */
const cachedPacks = new WeakMap<PackRequestContext, { project: ViewerProject; pack: WxaPack }>();
/**
 * 同一个地址先开过查看器、后来换成开发服务器时，旧的 pack-sw 还接管着页面，会拿 IndexedDB 里的包冒充开发服务器的应答。
 * 宿主启动时发现没有 /viewer.json 就记在这里，之后的请求一律走网络
 */
const notViewer = new WeakSet<PackRequestContext>();
const NETWORK_PATHS = new Set(['/', '/index.html', '/viewer.json', '/favicon.ico', '/pack-sw.js']);
const NETWORK_PREFIXES = ['/__baselib__/', '/__wxa__/runtime/', '/__wxa__/proxy/', '/__wxa__/preload/'];

/** 创建一个 Worker 生命周期内复用的上下文；测试可替换存储、站点配置与镜像响应。 */
export function createPackRequestContext(options: { origin: string } & Partial<PackRequestContext>): PackRequestContext {
  return {
    getActiveProject,
    getViewerConfig: async () => {
      const response = await fetch(new URL('/viewer.json', options.origin), { cache: 'no-store' });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`无法读取 viewer.json（${response.status}）`);
      return response.json();
    },
    fileSessions: new Map(),
    ...options
  };
}

/** 返回 true 的请求由浏览器直接访问网络，不需要读取 IndexedDB。 */
export function isPackNetworkRequest(request: Request, origin: string): boolean {
  const url = new URL(request.url);
  return url.origin !== origin || NETWORK_PATHS.has(url.pathname) || NETWORK_PREFIXES.some(prefix => url.pathname.startsWith(prefix));
}

/** 处理包内页面、代码和文件会话；返回 null 时调用方应直接走网络。 */
export async function handlePackRequest(request: Request, context: PackRequestContext, clientId = ''): Promise<Response | null> {
  if (isPackNetworkRequest(request, context.origin) || notViewer.has(context)) return null;
  const url = new URL(request.url);
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return respond(request, '无效的 URL 路径', 400);
  }

  // 宿主页面不放在静态站点里：有的托管平台会把 .html 地址改写成别的，这里自己生成
  if (pathname === '/__wxa__/host.html') return respond(request, hostHtml(), 200, 'html');
  if (pathname.startsWith(MOCK_PREFIX)) {
    const id = request.headers.get(MOCK_ID_HEADER);
    return id && context.mockResponse
      ? context.mockResponse(clientId, id)
      : respond(request, '这个请求只用于显示拦截规则给出的响应，缺少可用的 mock 镜像', 503);
  }
  const fileResponse = await handleFiles(request, context, url, pathname);
  if (fileResponse) return fileResponse;
  if (pathname.startsWith('/__wxa__/region/')) return respond(request, null, 404);
  if (request.method !== 'GET' && request.method !== 'HEAD') return respond(request, null, 404);

  const appInfo = pathname === '/__wxa__/app-info.json';
  const info: AppInfo = {
    version: 0,
    appid: '',
    baseLibVersion: '',
    wxConfig: {},
    pages: [],
    device: DEFAULT_DEVICE,
    liveReload: false,
    externalServiceWorker: true
  };
  try {
    const viewer = appInfo ? await context.getViewerConfig() : null;
    if (appInfo && !viewer) {
      notViewer.add(context);
      context.onNotViewer?.();
      return null;
    }
    const cached = cachedPacks.get(context);
    const project = appInfo || !cached ? await context.getActiveProject() : cached.project;
    if (!project) {
      cachedPacks.delete(context);
      return appInfo ? json(request, { ...info, buildError: '还没有导入 wxapack' }) : respond(request, null, 404);
    }
    info.appid = project.appid;
    const pack = currentPack(context, project);
    const setupScript = project.setupScript ?? pack.setupScript;
    if (appInfo) {
      Object.assign(info, {
        version: pack.build.version,
        appid: pack.manifest.appid,
        baseLibVersion: pack.manifest.baseLib.version,
        wxConfig: pack.build.wxConfig,
        pages: pack.build.pages
      });
      if (setupScript !== null) info.setup = { env: project.env };
      if (viewer!.baseLibVersion !== pack.manifest.baseLib.version) {
        info.buildError =
          `包的基础库版本 ${pack.manifest.baseLib.version} 与查看器的 ${viewer!.baseLibVersion} 不一致。` +
          `请使用基础库 ${viewer!.baseLibVersion} 重新 build，或导出带基础库 ${pack.manifest.baseLib.version} 的查看器`;
      }
      return json(request, info);
    }
    if (pathname === '/__wxa__/setup.js') {
      return setupScript === null ? respond(request, '没有 setup 文件', 404) : respond(request, setupScript, 200, 'js');
    }
    const routed = routeApp(
      {
        build: { ...pack.build, plugins: [] },
        moduleScript: id => pack.moduleScript(id)!,
        baseLib: pack.manifest.baseLib,
        isolated: pack.manifest.isolated,
        hot: false
      },
      url
    );
    if (routed) return respond(request, routed.body, routed.status, routed.type);
    const relPath = pathname.startsWith('/__wxa__/webview/') ? pathname.slice('/__wxa__/webview/'.length) : pathname.slice(1);
    const resource = pack.staticFile(relPath);
    return resource ? respond(request, resource, 200, extname(relPath)) : respond(request, null, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return appInfo ? json(request, { ...info, buildError: message }) : respond(request, message, 500);
  }
}

function currentPack(context: PackRequestContext, project: ViewerProject): WxaPack {
  const cached = cachedPacks.get(context);
  if (cached?.project.id === project.id && cached.project.updatedAt === project.updatedAt) {
    cachedPacks.set(context, { project, pack: cached.pack });
    return cached.pack;
  }
  const pack = readPack(project.pack);
  cachedPacks.set(context, { project, pack });
  return pack;
}

function sessionFiles(context: PackRequestContext, session: string): FileStore | null {
  if (!/^[a-z0-9-]{1,80}$/i.test(session)) return null;
  let files = context.fileSessions.get(session);
  if (!files) {
    files = new FileStore([`/__wxa__/usr/${session}`, `/__wxa__/tmp/${session}`]);
    context.fileSessions.set(session, files);
  }
  return files;
}

async function handleFiles(request: Request, context: PackRequestContext, url: URL, pathname: string): Promise<Response | null> {
  const fs = /^\/__wxa__\/fs\/([^/]+)\/?$/.exec(pathname);
  if (fs && request.method === 'POST') {
    const files = sessionFiles(context, fs[1]);
    if (!files) return json(request, { error: `invalid filesystem session ${fs[1]}` }, 400);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 150 * 1024 * 1024) return respond(request, '请求体过大', 413);
    let body;
    try {
      body = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return json(request, { error: '无效的 JSON 请求体' }, 400);
    }
    try {
      return json(request, { result: files.execute(body.operation, body.args || {}) });
    } catch (error) {
      // 不存在的文件是正常的接口失败，保持 200，避免基础库探测文件时刷满控制台。
      return json(request, { error: (error as Error).message });
    }
  }

  const upload = /^\/__wxa__\/tmp\/([^/]+)\/?$/.exec(pathname);
  if (upload && request.method === 'POST') {
    const type = url.searchParams.get('type') || 'png';
    if (!/^[a-z0-9]+$/i.test(type)) return respond(request, `非法的文件类型 ${type}`, 400);
    const files = sessionFiles(context, upload[1]);
    if (!files) return respond(request, `非法的会话标识 ${upload[1]}`, 400);
    const bytes = await request.arrayBuffer();
    if (bytes.byteLength > 100 * 1024 * 1024) return respond(request, '请求体过大', 413);
    const filePath = `/__wxa__/tmp/${upload[1]}/${crypto.randomUUID()}.${type}`;
    files.write(filePath, new Uint8Array(bytes));
    return json(request, { url: url.origin + filePath });
  }

  const file = /^\/__wxa__\/(usr|tmp)\/([^/]+)\/(.*)$/.exec(pathname);
  if (!file) return null;
  const files = context.fileSessions.get(file[2]);
  if (request.method === 'DELETE' && file[1] === 'tmp') {
    try {
      if (!files) return respond(request, null, 404);
      files.remove(pathname, { dir: false });
      return respond(request, null, 204);
    } catch {
      return respond(request, null, 404);
    }
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') return respond(request, null, 404);
  const node = files?.stat(pathname);
  if (!node || node.dir) return respond(request, null, 404);
  const headers: Record<string, string> = { ETag: `"${node.etag}"`, 'Accept-Ranges': 'bytes' };
  const range = byteRange(request.headers.get('range'), node.data.length);
  if (range === 'unsatisfiable') {
    return respond(request, null, 416, extname(file[3]), { ...headers, 'Content-Range': `bytes */${node.data.length}` });
  }
  if (range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${node.data.length}`;
    return respond(request, node.data.subarray(range.start, range.end + 1), 206, extname(file[3]), headers);
  }
  return respond(request, node.data, 200, extname(file[3]), headers);
}

// 与 DevServer 的 req.range() 一致：忽略非法格式和多段范围；没有可满足的范围时返回 416。
function byteRange(header: string | null, size: number): { start: number; end: number } | 'unsatisfiable' | null {
  if (!header || !header.includes('=')) return null;
  const separator = header.indexOf('=');
  const ranges: Array<{ start: number; end: number }> = [];
  for (const value of header.slice(separator + 1).split(',')) {
    const parts = value.split('-');
    let start = parseInt(parts[0], 10);
    let end = parseInt(parts[1], 10);
    if (Number.isNaN(start)) {
      start = size - end;
      end = size - 1;
    } else if (Number.isNaN(end)) end = size - 1;
    end = Math.min(end, size - 1);
    if (!Number.isNaN(start) && !Number.isNaN(end) && start >= 0 && start <= end) ranges.push({ start, end });
  }
  if (!ranges.length) return 'unsatisfiable';
  return header.slice(0, separator) === 'bytes' && ranges.length === 1 ? ranges[0] : null;
}

function respond(
  request: Request,
  body: string | Uint8Array | null,
  status = 200,
  type = 'text',
  extraHeaders: Record<string, string> = {}
): Response {
  const headers = new Headers({ 'Content-Type': mimeType(type), 'Cache-Control': 'no-store', ...extraHeaders });
  if (body !== null)
    headers.set('Content-Length', String(typeof body === 'string' ? new TextEncoder().encode(body).byteLength : body.byteLength));
  return new Response(request.method === 'HEAD' ? null : body instanceof Uint8Array ? new Uint8Array(body) : body, { status, headers });
}

function json(request: Request, value: unknown, status = 200): Response {
  return respond(request, JSON.stringify(value), status, 'json');
}
