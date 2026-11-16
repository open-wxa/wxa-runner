import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DevServer } from '../../packages/core/src/server/DevServer';
import { createProject, hasToolchain, REPO_ROOT } from '../helpers';

const APPID = 'wx0000000000000001';
const EXT_APPID = 'wx0000000000000002';
const RUNTIME_DIR = path.join(REPO_ROOT, 'packages/core/dist/runtime');
const ready = hasToolchain() && fs.existsSync(path.join(RUNTIME_DIR, 'host.js'));
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };

/**
 * 走真实的 AppBuilder 构建，确认 ext.json 的合并没有漏在某一步（单测里的 buildConfig 是手拼的流程）
 */
describe.skipIf(!ready)('DevServer 里的三方平台代开发（ext.json）', () => {
  let server: DevServer;
  let base = '';

  beforeAll(async () => {
    const projectPath = createProject({
      'project.config.json': { appid: APPID, miniprogramRoot: '' },
      'app.json': { pages: ['pages/a/a'], window: { navigationBarTitleText: '普通标题' } },
      'app.js': 'App({})',
      'pages/a/a.json': {},
      'pages/a/a.wxml': '<view>a</view>',
      'pages/a/a.js': 'Page({})',
      'ext.json': {
        extEnable: true,
        extAppid: EXT_APPID,
        ext: { theme: 'dark' },
        extPages: { 'pages/a/a': { navigationBarTitleText: '授权方标题' } }
      }
    });
    server = new DevServer({ projectPath, port: 0, watch: false, runtimeDir: RUNTIME_DIR, logger: quiet });
    base = await server.start();
  });

  afterAll(async () => {
    await server.close();
  });

  it('app-info 的 appid、__wxConfig、extPages 都按授权方', async () => {
    const info = (await (await fetch(base + '/__wxa__/app-info.json')).json()) as any;

    expect(info.buildError).toBeUndefined();
    expect(info.appid).toBe(EXT_APPID);
    // 基础库的 wx.getAccountInfoSync / wx.getExtConfig 读这里
    expect(info.wxConfig.appname).toBe(EXT_APPID);
    expect(info.wxConfig.accountInfo.appId).toBe(EXT_APPID);
    expect(info.wxConfig.extAppid).toBe(EXT_APPID);
    expect(info.wxConfig.extEnable).toBe(true);
    expect(info.wxConfig.ext).toEqual({ theme: 'dark' });
    expect(info.wxConfig.page['pages/a/a.html'].window.navigationBarTitleText).toBe('授权方标题');
  });
});

describe.skipIf(!ready)('ext.json 只存了半成品时', () => {
  let server: DevServer;
  let base = '';
  let projectPath = '';

  beforeAll(async () => {
    projectPath = createProject({
      'project.config.json': { appid: APPID, miniprogramRoot: '' },
      'app.json': { pages: ['pages/a/a'] },
      'app.js': 'App({})',
      'pages/a/a.json': {},
      'pages/a/a.wxml': '<view>a</view>',
      'pages/a/a.js': 'Page({})',
      'ext.json': { extEnable: true, extAppid: EXT_APPID }
    });
    server = new DevServer({ projectPath, port: 0, watch: false, runtimeDir: RUNTIME_DIR, logger: quiet });
    base = await server.start();
  });

  afterAll(async () => {
    await server.close();
  });

  it('app-info 返回 buildError，不会一直不响应', async () => {
    fs.writeFileSync(path.join(projectPath, 'ext.json'), '{ "extEnable": true, ');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(base + '/__wxa__/app-info.json', { signal: controller.signal }).finally(() => clearTimeout(timer));
    const info = (await response.json()) as any;

    expect(info.buildError).toContain('ext.json');
    // 构建失败时仍给宿主一个可用的 appid，回退到 project.config.json
    expect(info.appid).toBe(APPID);
  });
});
