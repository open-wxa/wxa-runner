/**
 * 宿主、逻辑层、渲染层的 HTML，以及 Worker 的入口脚本
 */

import { BuildResult, toJs } from '../project/AppBuilder';
import { AppBuild, PluginCode, pluginScriptUrl } from './plugins';

export function hostHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wxa-runner</title>
</head>
<body>
  <div id="wxa-root"></div>
  <script src="/__wxa__/runtime/host.js"></script>
</body>
</html>`;
}

/**
 * 打开基础库的热更新开关（runtime/host/hmr.ts 依赖它）：Page / Component / 模板注册时登记更新回调。
 * 必须紧跟在基础库之后、业务代码注册之前执行；只在监听文件变化时打开
 */
function enableHotUpdate(hot: boolean): string {
  return hot
    ? `<script>if (typeof __virtualDOM__ !== 'undefined' && __virtualDOM__.enableUpdateWxAppCode) __virtualDOM__.enableUpdateWxAppCode();</script>\n`
    : '';
}

/**
 * isolated：新版基础库（3.7.1 起）。逻辑层 iframe 只是主上下文，业务代码由基础库通过 WeixinJSContext
 * 放进子上下文执行（见 runtime/context.ts），逻辑层就绪的通知也由那边发出
 */
export function appserviceHtml(
  build: AppBuild,
  launch: { path: string; query: Record<string, string> },
  options: { hot: boolean; isolated?: boolean }
): string {
  const wxConfig = {
    ...build.wxConfig,
    appLaunchInfo: { scene: 1001, path: launch.path, query: launch.query },
    ...(options.isolated ? { isIsolateContext: true } : {})
  };
  const v = build.version;
  // 插件在业务代码之前注册：业务代码执行时就能 requirePlugin、跳转插件页面。
  // 插件脚本也排在业务模块的 define 之前，与开发者工具一致：插件初始化时调用 requireMiniProgram() 会因导出模块还没 define 而失败，开发者工具里同样如此
  const pluginUrls = build.plugins.map(plugin => pluginScriptUrl(plugin, 'appservice.js'));
  const moduleUrls = build.modules.map(id => `/__wxa__/module/${encodeURI(id)}?v=${v}`);
  const bootstrapUrl = `/__wxa__/service-bootstrap.js?v=${v}`;

  if (options.isolated) {
    const scripts = [...pluginUrls, ...moduleUrls, bootstrapUrl];
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>appservice</title>
<script>var __wxConfig = ${toJs(wxConfig)};</script>
<script src="/__wxa__/runtime/frame.js" data-kind="service" data-app-service="${escapeHtml(JSON.stringify(scripts))}"${options.hot ? ' data-hot="1"' : ''}></script>
<script src="/__baselib__/WAServiceMainContext.js"></script>
</head>
<body></body>
</html>`;
  }

  const modules = [...pluginUrls, ...moduleUrls].map(src => `<script src="${src}"></script>`).join('\n');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>appservice</title>
<script>var __wxConfig = ${toJs(wxConfig)};</script>
<script src="/__wxa__/runtime/frame.js" data-kind="service"></script>
<script src="/__baselib__/WAService.js"></script>
${enableHotUpdate(options.hot)}<script>
if (typeof define !== 'function') {
  console.error('[wxa-runner] 基础库没有完成初始化（define 不存在），当前基础库版本可能不受支持');
}
</script>
${modules}
<script src="${bootstrapUrl}"></script>
<script>parent.__wxaHost.frameLoaded('service', 0);</script>
</head>
<body></body>
</html>`;
}

/**
 * 主上下文通过 WeixinJSContext 创建的子上下文（runtime/context.ts）。
 * empty 对应 allocEmpty：不预先加载 WASubContext.js，由基础库随后 loadLibFiles
 */
export function subcontextHtml(id: number, empty: boolean): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>subcontext ${id}</title>
<script src="/__wxa__/runtime/frame.js" data-kind="service" data-context-id="${id}"></script>
${empty ? '' : '<script src="/__baselib__/WASubContext.js"></script>\n'}<script>parent.__wxaContexts.loaded(${id});</script>
</head>
<body></body>
</html>`;
}

export function webviewHtml(build: AppBuild, pagePath: string, webviewId: number, options: { hot: boolean }): string {
  const id = Number(webviewId) || 0;
  return `<!DOCTYPE html>
<html>
<head>
${webviewHead(build, pagePath, id)}
${enableHotUpdate(options.hot)}<script src="/__wxa__/page-frame.js?v=${build.version}"></script>
${pageWindow(build, pagePath).disableScroll ? '<style>body{overflow-y:hidden}</style>' : ''}
</head>
<body>
<script>
(function () {
  var path = ${toJs(pagePath)};
  if (typeof __wxAppCode__[path + '.wxss'] === 'function') __wxAppCode__[path + '.wxss']();
  var generateFunc = $gwx('./' + path + '.wxml');
  if (generateFunc) {
    document.dispatchEvent(new CustomEvent('generateFuncReady', { detail: { generateFunc: generateFunc } }));
  } else {
    document.body.innerText = './' + path + '.wxml not found';
    console.error('[wxa-runner] ./' + path + '.wxml not found');
  }
  parent.__wxaHost.frameLoaded('webview', ${id});
})();
</script>
</body>
</html>`;
}

/**
 * Worker 的入口（/__wxa__/worker.js?id=），由逻辑层的原生 WeixinWorker 创建（runtime/workers.ts）。
 * 和开发者工具一样先放 __wxConfig 和原生接口（runtime/worker.ts），再加载 Worker 基础库和 workers 目录下的模块；
 * 模块逐个加载，DevTools 里保留原文件名和行号。
 * Worker 基础库把 console 换成转发给逻辑层的版本，转发时对象被转成文本；开发者工具加载完基础库后换回原来的，日志留在 Worker 里。
 * 基础库目录里没有 WAWorker.js 时（如只放了逻辑层和渲染层文件的旧版内置基础库），直接抛出异常说明缺少的文件，由逻辑层的 Worker 对象记入 errors()（runtime/workers.ts）
 */
export function workerScript(build: BuildResult, baseLib: { version: string; hasWorker: boolean }): string {
  const modules = build.workerModules.map(id => `/__wxa__/module/${encodeURI(id)}?v=${build.version}`);
  const prelude = `var __wxConfig = ${toJs(build.wxConfig)}; __wxConfig.env.USER_DATA_PATH = location.origin + "/__wxa__/usr/" + new URL(location.href).searchParams.get("session");
importScripts('/__wxa__/runtime/worker.js');
`;
  if (!baseLib.hasWorker) {
    const message = `[wxa-runner] 基础库 ${baseLib.version} 里没有 WAWorker.js，Worker 不能运行。换用开发者工具下载的基础库，或升级 wxa-runner 带上新的内置基础库`;
    return `${prelude}throw new Error(${toJs(message)});
`;
  }
  return `${prelude}var __wxaConsole = self.console;
importScripts('/__baselib__/WAWorker.js');
self.console = __wxaConsole;
importScripts(${modules.map(url => toJs(url)).join(', ')});
`;
}

/**
 * 插件页面：只加载插件自己的模板和样式（pageframe.js），不加载小程序的，与开发者工具一致。
 * 页面 html 是插件包里编译好的片段，自己注入样式、取模板并派发 generateFuncReady
 */
export function pluginWebviewHtml(build: AppBuild, plugin: PluginCode, innerPath: string, pagePath: string, webviewId: number): string {
  const id = Number(webviewId) || 0;
  const page = plugin.files.get(`/${innerPath}.html`)?.toString('utf8') ?? `<script>console.error(${JSON.stringify(`[wxa-runner] 插件 ${plugin.alias} 里没有页面 ${innerPath}`)})</script>`;
  return `<!DOCTYPE html>
<html>
<head>
${webviewHead(build, pagePath, id)}
<script src="${pluginScriptUrl(plugin, 'pageframe.js')}"></script>
${pageWindow(build, pagePath).disableScroll ? '<style>body{overflow-y:hidden}</style>' : ''}
</head>
<body>
${page}
<script>parent.__wxaHost.frameLoaded('webview', ${id});</script>
</body>
</html>`;
}

function pageWindow(build: AppBuild, pagePath: string): Record<string, any> {
  return { ...build.wxConfig.global?.window, ...build.wxConfig.page?.[pagePath + '.html']?.window };
}

/** 渲染层公共的 head：页面配置、桥和基础库 */
function webviewHead(build: AppBuild, pagePath: string, id: number): string {
  const wxConfig = { ...build.wxConfig, window: pageWindow(build, pagePath) };
  return `<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<title>${escapeHtml(pagePath)}</title>
<!-- 小程序渲染层的默认字号是 16px；不声明的话会继承浏览器设置里的默认字号。放在最前面，基础库和页面样式都能覆盖它 -->
<style>html{font-size:16px}</style>
<!-- 真机的滚动条是不占布局的浮层；桌面浏览器的常规滚动条和自定义 ::-webkit-scrollbar 会挤窄页面，一律隐藏。
     scrollbar-width 优先于 ::-webkit-scrollbar，页面样式不会再把滚动条加回来 -->
<style>*{scrollbar-width:none}::-webkit-scrollbar{display:none}</style>
<!-- 逻辑层建的 2d、webgl 画布搬进 wx-canvas 后铺满它（见 frame.ts 的 moveCanvasesIntoPages）。
     基础库还会按逻辑层里的布局改它的位置和显隐，这里一律压住；触摸照常交给 wx-canvas 自己的 canvas -->
<style>.wxa-service-canvas{position:absolute!important;left:0!important;top:0!important;width:100%!important;height:100%!important;visibility:inherit!important;pointer-events:none}</style>
<script>var __wxConfig = ${toJs(wxConfig)};</script>
<script src="/__wxa__/runtime/frame.js" data-kind="webview" data-webview-id="${id}"></script>
<script src="/__baselib__/WAWebview.js"></script>`;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]!));
}
