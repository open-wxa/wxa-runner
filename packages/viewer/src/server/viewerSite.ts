/**
 * 查看器站点的文件：本机预览（ViewerServer）和导出（exportViewer）都从这里取，两边内容一致
 *
 * 站点是纯静态的，任何静态托管都能直接用，不需要配置响应头或改写规则：
 *   /                       查看页面
 *   /pack-sw.js             Service Worker。放在根目录，默认就能接管整个站点
 *   /viewer.json            查看器提供的基础库版本
 *   /__wxa__/runtime/*      宿主运行时（core）、查看页面脚本、esbuild.wasm
 *   /__baselib__/*          基础库
 *   /__wxa__/preload/*      导出时带上的默认包，viewer.json 的 defaultPacks 列出它们
 * 宿主页面 /__wxa__/host.html 由 Service Worker 生成，不是静态文件：有的托管平台会把 .html 地址改写掉
 */

import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { resolveBaseLib, ResolvedBaseLib } from '@open-wxa/wxa-runner-extractor';
import { version } from '../../package.json';
import { findRuntimeDir } from '@open-wxa/wxa-runner-core';

export interface ViewerSiteOptions {
  /** 不传时使用本机已安装的最新兼容基础库。 */
  baseLibVersion?: string;
  baseLibCacheDir?: string;
  /** 宿主运行时（host.js、frame.js 等）所在目录，默认取 wxa-runner-core 的构建产物 */
  coreRuntimeDir?: string;
}

export interface ResolvedViewerSite {
  /** 都挂在 /__wxa__/runtime/ 下：core 的宿主运行时，和本包的查看页面 */
  runtimeDirs: string[];
  /** 挂在站点根目录 /pack-sw.js */
  serviceWorker: string;
  /** 转发 wx.request 的处理函数（dist/proxy.mjs），导出时一并带上 */
  proxyModule: string;
  baseLib: ResolvedBaseLib;
  wasmPath: string;
  viewerJson: string;
}

export interface ExportViewerOptions extends ViewerSiteOptions {
  /** 输出目录不为空时也写入：重新生成 site/ 和 proxy.mjs，目录里的其他文件不动 */
  force?: boolean;
  /** 默认包：放进 /__wxa__/preload/，浏览器里还没有项目时按顺序导入，最后一个成为当前项目 */
  packs?: string[];
}

/** 随站点提供的包都放在这里，Service Worker 不拦截这个前缀 */
export const PRELOAD_PATH = '/__wxa__/preload/';

/**
 * 校验随站点提供的包（preview 传入的、导出的默认包），返回文件名 → 绝对路径；文件名就是 PRELOAD_PATH 下的地址
 * @throws 文件不存在、不是 .wxapack、有同名包时
 */
export function resolvePackFiles(files: string[] = []): Map<string, string> {
  const packs = new Map<string, string>();
  for (const file of files) {
    const resolved = path.resolve(file);
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) throw new Error(`找不到 wxapack 文件：${resolved}`);
    if (path.extname(resolved).toLowerCase() !== '.wxapack') throw new Error(`不是 .wxapack 文件：${resolved}`);
    const name = path.basename(resolved);
    if (packs.has(name)) throw new Error(`不能同时预加载同名包：${name}`);
    packs.set(name, resolved);
  }
  return packs;
}

export function preloadURL(name: string): string {
  return PRELOAD_PATH + encodeURIComponent(name);
}

/** 查看器入口；浏览器端 viewer.js 负责导入包和创建宿主 iframe。 */
export function viewerIndexHtml(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>wxa-viewer</title>
</head>
<body>
  <div id="wxa-viewer"></div>
  <script src="/__wxa__/runtime/viewer.js"></script>
</body>
</html>
`;
}

/** 解析 preview 和导出共用的资源；缺少构建产物或基础库时抛出可读错误。 */
export function resolveViewerSite(options: ViewerSiteOptions = {}): ResolvedViewerSite {
  const coreRuntimeDir = findRuntimeDir(options.coreRuntimeDir);
  const dist = [__dirname, path.join(__dirname, '..'), path.join(__dirname, '../../dist')].find(dir =>
    ['runtime/viewer.js', 'runtime/pack-sw.js', 'proxy.mjs'].every(file => fs.existsSync(path.join(dir, file)))
  );
  if (!dist) throw new Error('找不到查看器的构建产物（viewer.js、pack-sw.js、proxy.mjs），请先执行 pnpm build');
  const viewerRuntimeDir = path.join(dist, 'runtime');
  const baseLib = resolveBaseLib({ version: options.baseLibVersion, cacheDir: options.baseLibCacheDir });
  return {
    runtimeDirs: [path.resolve(coreRuntimeDir), path.resolve(viewerRuntimeDir)],
    serviceWorker: path.resolve(viewerRuntimeDir, 'pack-sw.js'),
    proxyModule: path.resolve(dist, 'proxy.mjs'),
    baseLib,
    // ESM 打包产物没有 require.resolve，从当前模块所在目录解析同一份依赖。
    wasmPath: createRequire(path.join(__dirname, 'viewerSite.js')).resolve('esbuild-wasm/esbuild.wasm'),
    viewerJson: JSON.stringify({ baseLibVersion: baseLib.version, generator: `wxa-viewer@${version}` }, null, 2) + '\n'
  };
}

/**
 * 导出查看器，返回输出目录的绝对路径：
 *   site/       纯静态站点，交给任意静态托管
 *   proxy.mjs   转发 wx.request 的处理函数（createProxyHandler），接口都允许跨域、或者请求全部用 setup 拦截时可以不部署
 * @throws 输出目录不为空且没有 force、缺少构建产物或基础库、默认包不可用时
 */
export function exportViewer(outDir: string, options: ExportViewerOptions = {}): string {
  const output = path.resolve(outDir);
  if (fs.existsSync(output)) {
    if (!fs.lstatSync(output).isDirectory()) throw new Error(`输出路径不是目录：${output}`);
    if (!options.force && fs.readdirSync(output).length) throw new Error(`输出目录非空：${output}；使用 --force 覆盖`);
  }
  const packs = resolvePackFiles(options.packs);
  const site = resolveViewerSite(options);
  const siteDir = path.join(output, 'site');
  // force 会先删掉 site/：输出目录不能是构建产物所在的目录，否则会把要复制的源文件一起删了。
  // 按真实路径比较，源文件或它所在的目录是指向 site/ 的符号链接时也能拦住
  const realSiteDir = path.join(fs.existsSync(output) ? fs.realpathSync(output) : output, 'site');
  for (const source of [...site.runtimeDirs, site.baseLib.dir, site.wasmPath, site.proxyModule, ...packs.values()]) {
    const relative = path.relative(realSiteDir, fs.realpathSync(source));
    if (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('输出目录不能包含查看器的构建产物、基础库或要导出的包');
  }
  if (options.force) fs.rmSync(siteDir, { recursive: true, force: true });
  const runtime = path.join(siteDir, '__wxa__/runtime');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(siteDir, 'index.html'), viewerIndexHtml());
  const defaultPacks = [...packs.keys()].map(preloadURL);
  fs.writeFileSync(
    path.join(siteDir, 'viewer.json'),
    defaultPacks.length ? JSON.stringify({ ...JSON.parse(site.viewerJson), defaultPacks }, null, 2) + '\n' : site.viewerJson
  );
  if (packs.size) fs.mkdirSync(path.join(siteDir, PRELOAD_PATH), { recursive: true });
  for (const [name, file] of packs) fs.copyFileSync(file, path.join(siteDir, PRELOAD_PATH, name));
  for (const dir of site.runtimeDirs) {
    for (const file of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!file.isFile() || !/\.(js|map)$/.test(file.name) || file.name.startsWith('pack-sw.')) continue;
      fs.copyFileSync(path.join(dir, file.name), path.join(runtime, file.name));
    }
  }
  fs.copyFileSync(site.serviceWorker, path.join(siteDir, 'pack-sw.js'));
  if (fs.existsSync(site.serviceWorker + '.map')) fs.copyFileSync(site.serviceWorker + '.map', path.join(siteDir, 'pack-sw.js.map'));
  fs.copyFileSync(site.wasmPath, path.join(runtime, 'esbuild.wasm'));
  fs.cpSync(site.baseLib.dir, path.join(siteDir, '__baselib__'), { recursive: true });
  fs.copyFileSync(site.proxyModule, path.join(output, 'proxy.mjs'));
  return output;
}
