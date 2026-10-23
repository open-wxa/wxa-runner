/**
 * wxa-runner-core（Node 端入口）
 *
 * 浏览器端运行时单独打包为 dist/runtime/host.js 与 dist/runtime/frame.js。
 */

export { DevServer, DEFAULT_DEVICE } from './server/DevServer';
export type { DevServerOptions } from './server/DevServer';
export { AppBuilder } from './project/AppBuilder';
export type { BuildResult } from './project/AppBuilder';
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
