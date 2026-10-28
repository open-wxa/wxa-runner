/**
 * wxa-runner-core（Node 端入口）
 *
 * 浏览器端运行时单独打包为 dist/runtime/host.js 与 dist/runtime/frame.js；不依赖 Node 的接口见 web.ts。
 */

export { DevServer, DEFAULT_DEVICE, findRuntimeDir, listen, LOCAL_HOST_OF_ANY_ADDRESS } from './server/DevServer';
export { bundleSetup, findSetupFile } from './server/setup';
export { handleProxy } from './server/proxy';
export type { DevServerMiddleware, DevServerOptions, WebviewScript } from './server/DevServer';
export type { DevServerExtension, ExtensionContext, ExtensionEntry, ExtensionSetup } from './server/extensions';
export { AppBuilder } from './project/AppBuilder';
export type { AppBuilderOptions, BuildResult } from './project/AppBuilder';
export { MiniProgram } from './project/MiniProgram';
export type { AppJson, UnitJson } from './project/MiniProgram';
export { createWxConfig } from './project/wxConfig';
export type { AppInfo, DeviceProfile, ForwardConsole } from './runtime/types';
export type { ApiContext, ApiHandler, ApiResult } from './runtime/host/api/registry';
export type { FrameError } from './runtime/host/Host';
export type { PageSnapshot, RecordedRequest, WxaTestApi } from './runtime/host/testApi';
export type {
  MockConfig, MockRequest, MockResponse, MockValue, NetworkConfig, RouteHandler,
  SetupApi, SetupConfig, SetupContext, SetupDefinition
} from './setup';
