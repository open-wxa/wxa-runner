/**
 * 开发服务器：下载并提供插件代码
 *
 * 对微信的下载请求（getplugincode）换成模拟的插件代码包，响应格式取自对微信服务器的实测。
 */

import fs from 'fs';
import path from 'path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { TICKET_ENV } from '../../packages/extractor/src/devtools';
import { DevServer } from '../../packages/core/src/server/DevServer';
import { packFakePlugin } from '../fakePlugin';
import { createProject, hasToolchain, REPO_ROOT } from '../helpers';

const RUNTIME_DIR = path.join(REPO_ROOT, 'packages/core/dist/runtime');
const ready = hasToolchain() && fs.existsSync(path.join(RUNTIME_DIR, 'host.js'));

const APPID = 'wxapp000000000001';
const PLUGIN = 'wxplugin00000001';
const PLUGIN_PAGE = `__plugin__/${PLUGIN}/pages/hello/hello`;

describe.skipIf(!ready)('插件代码', () => {
  let server: DevServer | null = null;

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await server?.close();
    server = null;
  });

  let pluginPackage: Buffer;

  beforeAll(async () => {
    pluginPackage = await packFakePlugin(PLUGIN, [{
      name: 'hello', path: 'pages/hello/hello', title: '插件页面', wxml: '<view>{{num}}</view>', js: 'Page({});'
    }]);
  });

  /** 启动用到插件的小程序；wechat 决定微信对下载请求的响应 */
  async function start(options: { devtoolsLogin?: boolean; wechat?: () => Response }) {
    const downloads: Array<{ url: URL; body: any }> = [];
    const realFetch = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
      if (!String(input).startsWith('https://servicewechat.com/')) return realFetch(input, init);
      downloads.push({ url: new URL(String(input)), body: JSON.parse(String(init?.body)) });
      return options.wechat ? options.wechat() : new Response(new Uint8Array(pluginPackage));
    });
    vi.stubEnv(TICKET_ENV, 'dev-ticket');
    const warnings: string[] = [];
    server = new DevServer({
      projectPath: createProject({
        'project.config.json': { appid: APPID, compileType: 'miniprogram' },
        'app.js': 'App({});',
        'app.json': { pages: ['pages/index/index'], plugins: { hello: { version: '1.0.0', provider: PLUGIN } } },
        'pages/index/index.json': {},
        'pages/index/index.wxml': '<view>index</view>',
        'pages/index/index.js': 'Page({});'
      }),
      port: 0,
      watch: false,
      devtoolsLogin: options.devtoolsLogin,
      runtimeDir: RUNTIME_DIR,
      logger: { log: () => undefined, warn: (message: string) => warnings.push(message), error: (message: string) => warnings.push(message) }
    });
    const base = await server.start();
    const get = (url: string) => fetch(base + url);
    return { get, downloads, warnings };
  }

  it('用开发者的登录态向微信下载 app.json 里声明的插件，插件页面和它的窗口配置并入小程序', async () => {
    const { get, downloads } = await start({ devtoolsLogin: true });

    const info = await (await get('/__wxa__/app-info.json')).json();

    expect(info.pages).toEqual(['pages/index/index', PLUGIN_PAGE]);
    expect(info.wxConfig.page[`${PLUGIN_PAGE}.html`].window.navigationBarTitleText).toBe('插件页面');
    expect(downloads).toHaveLength(1);
    expect(downloads[0].url.pathname).toBe('/wxa-dev/getplugincode');
    expect(downloads[0].url.searchParams.get('appid')).toBe(APPID);
    expect(downloads[0].url.searchParams.get('newticket')).toBe('dev-ticket');
    expect(downloads[0].body).toEqual({ plugin_id: PLUGIN, plugin_version: '1.0.0' });
  });

  it('插件代码只下载一次：再次打开小程序不再向微信下载', async () => {
    const { get, downloads } = await start({ devtoolsLogin: true });

    await get('/__wxa__/app-info.json');
    await get('/__wxa__/appservice.html');
    await get(`/__wxa__/webview/${PLUGIN_PAGE}.html?id=2`);

    expect(downloads).toHaveLength(1);
  });

  it('微信拒绝下载时，打开一次小程序只向微信请求一次，每个页面资源都按同一个结果处理；再次打开时重试', async () => {
    let attempts = 0;
    const { get, downloads, warnings } = await start({
      devtoolsLogin: true,
      // 第一次拒绝，之后同意：同一次打开里后来的请求不能用上新结果，否则逻辑层和页面列表对不上
      wechat: () => (++attempts === 1
        ? new Response(JSON.stringify({ baseresponse: { errcode: 85016, errmsg: 'plugin not authorized' } }))
        : new Response(new Uint8Array(pluginPackage)))
    });

    // 打开小程序时宿主先取 app-info，再加载逻辑层、业务模块和渲染层
    const firstInfo = await (await get('/__wxa__/app-info.json')).json();
    const service = await (await get('/__wxa__/appservice.html')).text();
    await get('/__wxa__/module/app.js');
    await get('/__wxa__/page-frame.js');
    await get('/__wxa__/webview/pages/index/index.html?id=1');

    expect(downloads).toHaveLength(1);
    expect(warnings.filter(message => message.includes('85016'))).toHaveLength(1);
    expect(firstInfo.pages).toEqual(['pages/index/index']);
    expect(service).not.toContain('/__wxa__/plugin/');

    const secondInfo = await (await get('/__wxa__/app-info.json')).json();
    expect(downloads).toHaveLength(2);
    expect(secondInfo.pages).toEqual(['pages/index/index', PLUGIN_PAGE]);
  });

  it('逻辑层在业务代码之前加载插件代码，插件页面的渲染层加载插件的模板和样式', async () => {
    const { get } = await start({ devtoolsLogin: true });

    const service = await (await get('/__wxa__/appservice.html')).text();
    const pluginScript = `/__wxa__/plugin/${PLUGIN}/1.0.0/appservice.js`;
    expect(service.indexOf(pluginScript)).toBeGreaterThan(service.indexOf('/__baselib__/'));
    expect(service.indexOf(pluginScript)).toBeLessThan(service.indexOf('/__wxa__/module/app.js'));
    expect(await (await get(pluginScript)).text()).toContain(`definePlugin("plugin://${PLUGIN}"`);

    const webview = await (await get(`/__wxa__/webview/${PLUGIN_PAGE}.html?id=2`)).text();
    const pageFrame = `/__wxa__/plugin/${PLUGIN}/1.0.0/pageframe.js`;
    expect(webview).toContain(pageFrame);
    expect(webview).toContain(`$gwx_${PLUGIN}('./pages/hello/hello.wxml')`);
    expect(await (await get(pageFrame)).text()).toContain(`$gwx_${PLUGIN}`);
  });

  it('没开 --devtools-login 时不下载插件，终端提示怎么开启，小程序自己的页面照常可用', async () => {
    const { get, downloads, warnings } = await start({ devtoolsLogin: false });

    const info = await (await get('/__wxa__/app-info.json')).json();

    expect(info.pages).toEqual(['pages/index/index']);
    expect(downloads).toHaveLength(0);
    expect(warnings.join('\n')).toMatch(/插件 hello（wxplugin00000001@1\.0\.0）.*--devtools-login/);
  });

  it('下载插件时开发者的登录态已失效，终端提示去开发者工具重新登录', async () => {
    const { get, warnings } = await start({
      devtoolsLogin: true,
      wechat: () => new Response(JSON.stringify({ baseresponse: { errcode: 40001, errmsg: 'invalid credential' } }))
    });

    await get('/__wxa__/app-info.json');

    expect(warnings.join('\n')).toMatch(/插件 hello（wxplugin00000001@1\.0\.0）.*40001.*请在微信开发者工具里重新登录/);
  });

  it('微信拒绝下载时（如插件申请还没通过），终端说明是哪个插件和原因，小程序自己的页面照常可用', async () => {
    const { get, warnings } = await start({
      devtoolsLogin: true,
      wechat: () => new Response(JSON.stringify({ baseresponse: { errcode: 85016, errmsg: 'plugin not authorized' } }))
    });

    const info = await (await get('/__wxa__/app-info.json')).json();

    expect(info.pages).toEqual(['pages/index/index']);
    expect(warnings.join('\n')).toMatch(/插件 hello（wxplugin00000001@1\.0\.0）.*85016.*plugin not authorized/);
  });
});
