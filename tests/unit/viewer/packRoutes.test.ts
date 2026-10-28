import fs from 'fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPack } from '../../../packages/viewer/src/pack/createPack';
import { readPack } from '../../../packages/viewer/src/pack/format';
import { createPackRequestContext, handlePackRequest } from '../../../packages/viewer/src/sw/packRoutes';
import type { ViewerProject } from '../../../packages/viewer/src/store';
import { DEFAULT_DEVICE, routeApp } from '../../../packages/core/src/server/appRoutes';
import { hostHtml } from '../../../packages/core/src/server/html';
import { createProject, hasToolchain } from '../../helpers';

const ORIGIN = 'https://viewer.example.com';
const request = (pathname: string, init?: RequestInit) => new Request(new URL(pathname, ORIGIN), init);
const context = () =>
  createPackRequestContext({
    origin: ORIGIN,
    getActiveProject: async () => null,
    getViewerConfig: async () => ({ baseLibVersion: '3.7.0' })
  });
const call = async (pathname: string, ctx = context(), init?: RequestInit) => (await handlePackRequest(request(pathname, init), ctx))!;
const operation = (name: string, args: object) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ operation: name, args })
});

describe('查看器请求分流', () => {
  it.each([
    '/',
    '/index.html',
    '/viewer.json',
    '/favicon.ico',
    '/__baselib__/WAService.js',
    '/__wxa__/runtime/host.js',
    '/__wxa__/proxy/https/api.example.com/a',
    '/pack-sw.js',
    '/__wxa__/preload/app.wxapack',
    'https://other.example.com/image.png'
  ])('查看器把 %s 直接交给网络，不读取项目存储', async pathname => {
    const ctx = createPackRequestContext({
      origin: ORIGIN,
      getActiveProject: async () => {
        throw new Error('不应读取');
      }
    });
    expect(await handlePackRequest(request(pathname), ctx)).toBeNull();
  });

  it('宿主页面由 Service Worker 生成，不依赖静态站点，也不读取项目存储', async () => {
    const ctx = createPackRequestContext({
      origin: ORIGIN,
      getActiveProject: async () => {
        throw new Error('不应读取');
      }
    });
    const response = (await handlePackRequest(request('/__wxa__/host.html'), ctx))!;
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(await response.text()).toBe(hostHtml());
  });

  it('查看器尚未导入项目时返回可供宿主显示的错误信息', async () => {
    const res = await call('/__wxa__/app-info.json');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      version: 0,
      pages: [],
      wxConfig: {},
      device: DEFAULT_DEVICE,
      buildError: '还没有导入 wxapack',
      liveReload: false,
      externalServiceWorker: true
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('查看器拒绝行政区划和未知路径', async () => {
    expect((await call('/__wxa__/region/districts')).status).toBe(404);
    expect((await call('/missing.png')).status).toBe(404);
  });

  it('查看器通过注入的镜像回调返回原始 mock 响应', async () => {
    const ctx = context();
    ctx.mockResponse = async (clientId, id) => new Response(JSON.stringify({ clientId, id }), { status: 201 });
    const res = await handlePackRequest(
      request('/__wxa__/mock/https/api.example.com/a', {
        method: 'POST',
        headers: { 'x-wxa-mock-id': 'request-1' }
      }),
      ctx,
      'client-1'
    );
    expect(res!.status).toBe(201);
    expect(await res!.json()).toEqual({ clientId: 'client-1', id: 'request-1' });
  });
});

describe('查看器的文件会话', () => {
  it('文件系统写入后可以按 usr 地址读取，其他会话互不影响', async () => {
    const ctx = context();
    const filePath = '/__wxa__/usr/session-a/note.txt';
    const written = await call('/__wxa__/fs/session-a', ctx, operation('writeFile', { filePath, data: '你好' }));
    expect(await written.json()).toEqual({ result: {} });
    const read = await call(filePath, ctx);
    expect(read.status).toBe(200);
    expect(read.headers.get('content-type')).toContain('text/plain');
    expect(await read.text()).toBe('你好');
    const result = await call('/__wxa__/fs/session-a', ctx, operation('readFile', { filePath, encoding: 'utf8' }));
    expect(await result.json()).toEqual({ result: { data: '你好' } });
    const other = await call('/__wxa__/fs/session-b', ctx, operation('readFile', { filePath, encoding: 'utf8' }));
    expect(await other.json()).toEqual({ error: expect.stringContaining('no such file') });
  });

  it('临时上传返回完整地址，支持 HEAD、DELETE 与字节读取', async () => {
    const ctx = context();
    const uploaded = await call('/__wxa__/tmp/session-a?type=mp4', ctx, { method: 'POST', body: new Uint8Array([0, 255, 128, 42]) });
    const { url } = await uploaded.json();
    expect(url).toMatch(/^https:\/\/viewer.example.com\/__wxa__\/tmp\/session-a\/.+\.mp4$/);
    const read = await call(url, ctx);
    expect(read.headers.get('content-type')).toBe('video/mp4');
    expect(new Uint8Array(await read.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128, 42]));
    const head = await call(url, ctx, { method: 'HEAD' });
    expect(head.headers.get('content-length')).toBe('4');
    expect(head.headers.get('etag')).toBe(read.headers.get('etag'));
    expect(await head.text()).toBe('');
    expect((await call(url, ctx, { method: 'DELETE' })).status).toBe(204);
    expect((await call(url, ctx)).status).toBe(404);
    expect((await call(url, ctx, { method: 'DELETE' })).status).toBe(404);
  });

  it.each<[string, number, string, string | null]>([
    ['bytes=1-3', 206, '123', 'bytes 1-3/6'],
    ['bytes=3-', 206, '345', 'bytes 3-5/6'],
    ['bytes=-2', 206, '45', 'bytes 4-5/6'],
    ['bytes=1-99', 206, '12345', 'bytes 1-5/6'],
    ['bytes=99-', 416, '', 'bytes */6'],
    ['bytes=3-1', 416, '', 'bytes */6'],
    ['bytes=0-0,3-3', 200, '012345', null],
    ['invalid', 200, '012345', null],
    ['items=0-1', 200, '012345', null]
  ])('文件资源按 Range %s 返回与开发服务器相同的范围', async (range, status, body, contentRange) => {
    const ctx = context();
    const filePath = '/__wxa__/usr/session-a/video.mp4';
    await call('/__wxa__/fs/session-a', ctx, operation('writeFile', { filePath, data: '012345' }));
    const response = await call(filePath, ctx, { headers: { range: range! } });
    expect(response.status).toBe(status);
    expect(response.headers.get('content-range')).toBe(contentRange);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(await response.text()).toBe(body);
  });

  it('文件追加后 ETag 变化，HEAD Range 返回相同的长度但不返回响应体', async () => {
    const ctx = context();
    const filePath = '/__wxa__/usr/session-a/a.txt';
    await call('/__wxa__/fs/session-a', ctx, operation('writeFile', { filePath, data: 'abc' }));
    const old = await call(filePath, ctx);
    await call('/__wxa__/fs/session-a', ctx, operation('appendFile', { filePath, data: 'def' }));
    const head = await call(filePath, ctx, { method: 'HEAD', headers: { range: 'bytes=1-3' } });
    expect(head.status).toBe(206);
    expect(head.headers.get('content-length')).toBe('3');
    expect(head.headers.get('etag')).not.toBe(old.headers.get('etag'));
    expect(await head.text()).toBe('');
  });

  it('文件系统拒绝非法会话和文件类型，普通操作失败仍返回 200', async () => {
    const ctx = context();
    expect((await call('/__wxa__/fs/bad_session', ctx, operation('access', { path: '/' }))).status).toBe(400);
    expect((await call('/__wxa__/tmp/bad_session', ctx, { method: 'POST' })).status).toBe(400);
    expect((await call('/__wxa__/tmp/session-a?type=../js', ctx, { method: 'POST' })).status).toBe(400);
    const failed = await call('/__wxa__/fs/session-a', ctx, operation('readFile', { filePath: '/missing' }));
    expect(failed.status).toBe(200);
    expect(await failed.json()).toEqual({ error: expect.stringContaining('no such file') });
  });
});

describe.skipIf(!hasToolchain())('查看器的包路由', () => {
  let root: string;
  let project: ViewerProject;
  let bytesWithoutSetup: Uint8Array;

  beforeAll(async () => {
    root = createProject({
      'project.config.json': { appid: 'wxviewer' },
      'app.json': { pages: ['pages/index/index'], workers: 'workers' },
      'app.js': 'App({});',
      'pages/index/index.js': 'Page({});',
      'pages/index/index.wxml': '<view>Hello</view>',
      'workers/a.js': 'worker.postMessage("ready");',
      'wxa.setup.ts': 'export default { storage: { source: "pack" } };',
      'images/图片.png': Buffer.from([0, 255, 128])
    });
    const { bytes } = await createPack({ projectPath: root });
    bytesWithoutSetup = (await createPack({ projectPath: root, setup: false })).bytes;
    project = {
      id: 'project-a',
      name: '示例',
      appid: 'wxviewer',
      pack: bytes,
      importedAt: 1,
      updatedAt: 1,
      setupSource: null,
      setupFileName: null,
      setupScript: null,
      env: { WXA_TOKEN: 'local-token' }
    };
  });
  afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

  function activeContext() {
    let active: ViewerProject | null = { ...project };
    const ctx = createPackRequestContext({
      origin: ORIGIN,
      getActiveProject: async () => active,
      getViewerConfig: async () => ({ baseLibVersion: readPack(project.pack).manifest.baseLib.version })
    });
    return {
      ctx,
      setActive: (value: ViewerProject | null) => {
        active = value;
      }
    };
  }

  it('宿主读取 app-info 时获得构建信息、setup 环境和外部 Service Worker 标识', async () => {
    const { ctx } = activeContext();
    const pack = readPack(project.pack);
    const info = await (await call('/__wxa__/app-info.json', ctx)).json();
    expect(info).toEqual({
      version: pack.build.version,
      appid: 'wxviewer',
      baseLibVersion: pack.manifest.baseLib.version,
      wxConfig: pack.build.wxConfig,
      pages: pack.build.pages,
      device: DEFAULT_DEVICE,
      setup: { env: { WXA_TOKEN: 'local-token' } },
      liveReload: false,
      externalServiceWorker: true
    });
  });

  it('宿主每次读取 app-info 都能看到当前项目和环境的变化', async () => {
    const { ctx, setActive } = activeContext();
    await call('/__wxa__/app-info.json', ctx);
    setActive({ ...project, updatedAt: 2, env: { WXA_TOKEN: 'new-token' } });
    expect((await (await call('/__wxa__/app-info.json', ctx)).json()).setup.env).toEqual({ WXA_TOKEN: 'new-token' });
    setActive(null);
    expect((await (await call('/__wxa__/app-info.json', ctx)).json()).buildError).toBe('还没有导入 wxapack');
  });

  it('宿主在包和查看器基础库不一致时获得两个版本及修复方法', async () => {
    const { ctx } = activeContext();
    ctx.getViewerConfig = async () => ({ baseLibVersion: '0.0.1' });
    const info = await (await call('/__wxa__/app-info.json', ctx)).json();
    expect(info.buildError).toContain(readPack(project.pack).manifest.baseLib.version);
    expect(info.buildError).toContain('0.0.1');
    expect(info.buildError).toMatch(/build.*导出/);
  });

  it('宿主优先使用项目 setup，清除覆盖后恢复包内 setup，无 setup 时返回 404', async () => {
    const { ctx, setActive } = activeContext();
    // 查看页面改了项目后会重载宿主，宿主先请求 app-info，再请求 setup.js
    const relaunch = async () => (await call('/__wxa__/app-info.json', ctx)).json();
    await relaunch();
    expect(await (await call('/__wxa__/setup.js', ctx)).text()).toContain('pack');
    setActive({ ...project, updatedAt: 2, setupScript: 'export default { storage: { source: "override" } };' });
    await relaunch();
    expect(await (await call('/__wxa__/setup.js', ctx)).text()).toContain('override');
    setActive({ ...project, updatedAt: 3, pack: bytesWithoutSetup });
    expect((await relaunch()).setup).toBeUndefined();
    expect((await call('/__wxa__/setup.js', ctx)).status).toBe(404);
    setActive({ ...project, updatedAt: 4, pack: bytesWithoutSetup, setupScript: '' });
    expect((await relaunch()).setup).toEqual({ env: project.env });
    expect((await call('/__wxa__/setup.js', ctx)).status).toBe(200);
  });

  it('同一地址换成开发服务器（没有 viewer.json）后，旧的 pack-sw 注销自己，所有请求交给网络', async () => {
    const { ctx } = activeContext();
    let notified = 0;
    ctx.getViewerConfig = async () => null;
    ctx.onNotViewer = () => notified++;
    expect(await call('/__wxa__/app-info.json', ctx)).toBeNull();
    expect(await call('/__wxa__/page-frame.js', ctx)).toBeNull();
    expect(notified).toBe(1);
  });

  it('宿主启动之后的请求沿用 app-info 时读到的项目，不再每次读 IndexedDB', async () => {
    const { ctx } = activeContext();
    let reads = 0;
    const read = ctx.getActiveProject;
    ctx.getActiveProject = () => {
      reads++;
      return read();
    };
    await call('/__wxa__/app-info.json', ctx);
    await call('/__wxa__/page-frame.js', ctx);
    await call('/__wxa__/setup.js', ctx);
    expect(reads).toBe(1);
  });

  it.each([
    '/__wxa__/appservice.html?path=pages/index/index',
    '/__wxa__/subcontext.html?id=2',
    '/__wxa__/webview/pages/index/index.html?id=1',
    '/__wxa__/module/app.js',
    '/__wxa__/module/workers/a.js',
    '/__wxa__/worker.js',
    '/__wxa__/service-bootstrap.js',
    '/__wxa__/service-templates.js',
    '/__wxa__/page-frame.js',
    '/__wxa__/page-templates.js',
    '/__wxa__/page-styles.js'
  ])('宿主的 %s 使用共用路由且关闭热更新', async pathname => {
    const { ctx } = activeContext();
    const pack = readPack(project.pack);
    const expected = routeApp(
      {
        build: { ...pack.build, plugins: [] },
        moduleScript: id => pack.moduleScript(id)!,
        baseLib: pack.manifest.baseLib,
        isolated: pack.manifest.isolated,
        hot: false
      },
      new URL(pathname, ORIGIN)
    )!;
    const response = await call(pathname, ctx);
    expect(response.status).toBe(expected.status);
    expect(await response.text()).toBe(expected.body);
  });

  it('资源在根路径和 webview 相对路径下可读，HEAD 仅返回头', async () => {
    const { ctx } = activeContext();
    for (const pathname of ['/images/图片.png', '/__wxa__/webview/images/图片.png']) {
      const res = await call(pathname, ctx);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([0, 255, 128]));
      const head = await call(pathname, ctx, { method: 'HEAD' });
      expect(head.headers.get('content-length')).toBe('3');
      expect(await head.text()).toBe('');
    }
    expect((await call('/missing.png', ctx)).status).toBe(404);
    expect((await call('/__wxa__/region/districts', ctx)).status).toBe(404);
    expect((await call('/__wxa__/webview/missing.html', ctx)).status).toBe(404);
  });

  it('包缓存仅在项目 id 或更新时间变化时重新解析，损坏包的错误交给宿主', async () => {
    const { ctx, setActive } = activeContext();
    const initial = await (await call('/__wxa__/app-info.json', ctx)).json();
    setActive({ ...project, pack: new Uint8Array([1, 2, 3]) });
    expect(await (await call('/__wxa__/app-info.json', ctx)).json()).toEqual(initial);
    setActive({ ...project, updatedAt: 2, pack: new Uint8Array([1, 2, 3]) });
    expect((await (await call('/__wxa__/app-info.json', ctx)).json()).buildError).toMatch(/wxapack/);
    setActive({ ...project, id: 'project-b', pack: bytesWithoutSetup });
    expect((await (await call('/__wxa__/app-info.json', ctx)).json()).setup).toBeUndefined();
  });
});
