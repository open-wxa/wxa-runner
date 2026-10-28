/**
 * wxa-runner-core/web：不依赖 Node 的公开接口，给在浏览器、Service Worker 或其他 Fetch API 运行时里托管小程序的宿主用
 * （如 @open-wxa/wxa-viewer）。开发服务器用的也是同一份实现，两边生成的页面和行为一致。
 */

export { DEFAULT_DEVICE, extname, mimeType, routeApp } from './server/appRoutes';
export type { AppSource, RouteResponse } from './server/appRoutes';
export { hostHtml } from './server/html';
export type { AppBuild, PluginCode } from './server/pluginCode';
export { FileStore } from './server/FileStore';
export { proxyFetch } from './server/proxyFetch';
export { mockedResponse } from './runtime/mockResponse';
export type { MockClient } from './runtime/mockResponse';
export { MOCK_ID_HEADER, MOCK_PREFIX, PROXY_PREFIX } from './runtime/networkPanel';
export { SETUP_MODULE, SETUP_MODULE_SOURCE } from './runtime/setupModule';
export type { BuildResult } from './project/AppBuilder';
export type { AppInfo, DeviceProfile } from './runtime/types';
