/**
 * @open-wxa/wxa-viewer（Node 端入口）：把小程序打成 .wxapack、在本机预览、导出静态站点
 *
 * 浏览器端的查看页面和 Service Worker 单独打包为 dist/runtime/viewer.js 与 dist/runtime/pack-sw.js；
 * 转发 wx.request 的处理函数不依赖 Node，单独打包为 dist/proxy.mjs（@open-wxa/wxa-viewer/proxy）。
 */

export { createPack } from './pack/createPack';
export type { CreatePackOptions, CreatePackResult } from './pack/createPack';
export { isPackStaticFile, PACK_FORMAT, readPack } from './pack/format';
export type { PackManifest, WxaPack } from './pack/format';
export { ViewerServer } from './server/ViewerServer';
export type { ViewerServerOptions } from './server/ViewerServer';
export { exportViewer } from './server/viewerSite';
export type { ExportViewerOptions, ResolvedViewerSite, ViewerSiteOptions } from './server/viewerSite';
