/**
 * 小程序页面与代码的路由：逻辑层、子上下文、渲染层的 HTML，业务模块、模板、样式和插件代码
 *
 * 开发服务器和查看器（wxapack）的 Service Worker 共用这一份，两边生成的页面才不会走样，所以不依赖 Node。
 * app-info、setup、静态资源、文件接口等和运行环境有关的路由各自实现。
 */

import type { DeviceProfile } from '../runtime/types';
import type { WebviewScript } from './DevServer';
import { appserviceHtml, pluginWebviewHtml, subcontextHtml, webviewHtml, workerScript } from './html';
import { AppBuild, findPluginPage } from './pluginCode';

export const DEFAULT_DEVICE: DeviceProfile = {
  model: 'iPhone X',
  screenWidth: 375,
  screenHeight: 812,
  pixelRatio: 3,
  statusBarHeight: 44,
  safeAreaBottom: 34,
  system: 'iOS 16.0',
  platform: 'devtools'
};

export interface AppSource {
  build: AppBuild;
  /** 业务模块的 define 脚本，id 已确认在 modules 或 workerModules 里 */
  moduleScript(id: string): string;
  baseLib: { version: string; hasWorker: boolean };
  /** 新版基础库的隔离上下文，见 html.ts 的 appserviceHtml */
  isolated: boolean;
  /** 打开基础库的热更新开关 */
  hot: boolean;
  webviewScripts?: WebviewScript[];
}

export interface RouteResponse {
  status: number;
  /** express 的 res.type() 能识别的写法：'html'、'js'、'text' 或带点的扩展名；在 Service Worker 里用 mimeType() 换成 Content-Type */
  type: string;
  body: string | Uint8Array;
}

const PLUGIN_SCRIPT = /^\/__wxa__\/plugin\/([^/]+)\/([^/]+)\/(appservice\.js|pageframe\.js)$/;

/** @returns 不归这里管、或请求的页面和文件不存在时为 null，交给后面的路由 */
export function routeApp(source: AppSource, url: URL): RouteResponse | null {
  const { build } = source;
  const pathname = safeDecode(url.pathname);
  if (pathname === null) return null;
  const query = url.searchParams;

  switch (pathname) {
    case '/__wxa__/appservice.html': {
      const launchPath = (query.get('path') || '').replace(/^\//, '');
      const launch = build.pages.includes(launchPath)
        ? { path: launchPath, query: Object.fromEntries(new URLSearchParams(query.get('query') || '')) }
        : { path: build.pages[0], query: {} };
      return html(appserviceHtml(build, launch, { hot: source.hot, isolated: source.isolated }));
    }
    case '/__wxa__/subcontext.html': {
      const id = Number(query.get('id'));
      if (!Number.isInteger(id) || id <= 0) return { status: 400, type: 'text', body: '子上下文 id 无效' };
      return html(subcontextHtml(id, query.get('empty') === '1'));
    }
    case '/__wxa__/worker.js':
      return js(workerScript(build, source.baseLib));
    case '/__wxa__/service-bootstrap.js':
      return js(build.serviceBootstrap);
    case '/__wxa__/service-templates.js':
      return js(build.serviceTemplates);
    case '/__wxa__/page-templates.js':
      return js(build.pageTemplates);
    case '/__wxa__/page-styles.js':
      return js(build.pageStyles);
    case '/__wxa__/page-frame.js':
      return js(build.pageFrame);
  }

  const webview = /^\/__wxa__\/webview\/(.+)\.html$/.exec(pathname);
  if (webview) {
    const pagePath = webview[1];
    if (!build.pages.includes(pagePath)) return null;
    const webviewId = Number(query.get('id'));
    const pluginPage = findPluginPage(build, pagePath);
    return html(pluginPage
      ? pluginWebviewHtml(build, pluginPage.plugin, pluginPage.innerPath, pagePath, webviewId, { scripts: source.webviewScripts })
      : webviewHtml(build, pagePath, webviewId, { hot: source.hot, scripts: source.webviewScripts }));
  }

  // 插件的逻辑层、渲染层代码
  const pluginScript = PLUGIN_SCRIPT.exec(pathname);
  if (pluginScript) {
    const [, provider, version, file] = pluginScript;
    const code = build.plugins.find(plugin => plugin.provider === provider && plugin.version === version)?.files.get(`/${file}`);
    return code ? { status: 200, type: 'js', body: code } : null;
  }
  // 插件页面里的图片等资源：基础库把插件里的相对路径和 / 开头的路径都改写成站点根下的 /__plugin__/<插件 appid>/…
  const pluginFile = /^\/__plugin__\/([^/]+)(\/.+)$/.exec(pathname);
  if (pluginFile) {
    const file = build.plugins.find(plugin => plugin.provider === pluginFile[1])?.files.get(pluginFile[2]);
    return file ? { status: 200, type: extname(pluginFile[2]) || 'application/octet-stream', body: file } : null;
  }

  const module = /^\/__wxa__\/module\/(.+\.js)$/.exec(pathname);
  if (module) {
    const id = module[1];
    if (!build.modules.includes(id) && !build.workerModules.includes(id)) {
      return { status: 404, type: 'js', body: `console.error(${JSON.stringify(`[wxa-runner] 模块 ${id} 不存在`)})` };
    }
    return js(source.moduleScript(id));
  }
  return null;
}

const MIME_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  js: 'application/javascript; charset=utf-8',
  text: 'text/plain; charset=utf-8',
  json: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  wxss: 'text/plain; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm'
};

/** RouteResponse.type 或文件扩展名对应的 Content-Type；认不出的按二进制处理 */
export function mimeType(type: string): string {
  if (type.includes('/')) return type;
  return MIME_TYPES[type.replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream';
}

/** 带点的扩展名，没有时为空串 */
export function extname(filePath: string): string {
  const match = /\.[^./]+$/.exec(filePath);
  return match ? match[0] : '';
}

function html(body: string): RouteResponse {
  return { status: 200, type: 'html', body };
}

function js(body: string): RouteResponse {
  return { status: 200, type: 'js', body };
}

/** 地址里有单独的 %（如 /discount/50%）时 decodeURIComponent 会抛错，这种地址不归这里管 */
function safeDecode(pathname: string): string | null {
  try {
    return decodeURIComponent(pathname);
  } catch {
    return null;
  }
}
