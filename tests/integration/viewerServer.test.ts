import fs from 'fs';
import http from 'http';
import path from 'path';
import { pathToFileURL } from 'url';
import type { AddressInfo } from 'net';
import { spawnSync } from 'child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { ViewerServer } from '../../packages/viewer/src/server/ViewerServer';
import { exportViewer, resolveViewerSite, viewerIndexHtml } from '../../packages/viewer/src/server/viewerSite';
import { createProject, hasToolchain, REPO_ROOT } from '../helpers';

const VIEWER_DIST = path.join(REPO_ROOT, 'packages/viewer/dist');
const ready =
  hasToolchain() &&
  fs.existsSync(path.join(REPO_ROOT, 'packages/core/dist/runtime/host.js')) &&
  fs.existsSync(path.join(VIEWER_DIST, 'runtime/viewer.js')) &&
  fs.existsSync(path.join(VIEWER_DIST, 'proxy.mjs'));
const roots: string[] = [];
const servers: ViewerServer[] = [];
const upstreams: http.Server[] = [];
const temp = (files: Record<string, string> = {}) => {
  const root = createProject(files);
  roots.push(root);
  return root;
};
const start = async (packs: string[] = []) => {
  const server = new ViewerServer({ port: 0, host: '127.0.0.1', packs });
  servers.push(server);
  await server.start();
  return server;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(
    upstreams.splice(0).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    )
  );
  roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

describe.skipIf(!ready)('查看器本机服务', () => {
  it('用户能读取查看页、宿主页、基础库和完整运行时，Service Worker 可接管根路径', async () => {
    const server = await start();
    const index = await fetch(server.url);
    expect(await index.text()).toBe(viewerIndexHtml());
    expect(await (await fetch(server.url + '/index.html')).text()).toBe(viewerIndexHtml());
    const info = await (await fetch(server.url + '/viewer.json')).json();
    expect(info).toEqual({ baseLibVersion: server.baseLib.version, generator: expect.stringMatching(/^wxa-viewer@/) });
    // 宿主页面由 Service Worker 生成，服务端没有
    expect((await fetch(server.url + '/__wxa__/host.html')).status).toBe(404);
    for (const name of ['host.js', 'frame.js', 'worker.js', 'viewer.js', 'viewer.js.map']) {
      const response = await fetch(`${server.url}/__wxa__/runtime/${name}`);
      expect(response.status, name).toBe(200);
    }
    // 放在根目录：默认就能接管整个站点，不需要 Service-Worker-Allowed 响应头
    const sw = await fetch(server.url + '/pack-sw.js');
    expect(sw.status).toBe(200);
    expect(sw.headers.get('content-type')).toContain('javascript');
    const wasm = await fetch(server.url + '/__wxa__/runtime/esbuild.wasm');
    expect(wasm.status).toBe(200);
    expect(wasm.headers.get('content-type')).toBe('application/wasm');
    expect(new Uint8Array(await wasm.arrayBuffer()).slice(0, 4)).toEqual(new Uint8Array([0, 97, 115, 109]));
    expect((await fetch(server.url + '/__baselib__/WAWebview.js')).status).toBe(200);
  });

  it('用户打开带中文和空格的包时，地址包含可访问的同源 preload 链接', async () => {
    const root = temp({ '演示 包.wxapack': 'pack-bytes', 'private.txt': 'secret' });
    const server = await start([path.join(root, '演示 包.wxapack')]);
    const url = new URL(server.url);
    const preload = url.searchParams.get('pack')!;
    expect(preload).toBe('/__wxa__/preload/' + encodeURIComponent('演示 包.wxapack'));
    expect(await (await fetch(new URL(preload, url))).text()).toBe('pack-bytes');
    const response = await fetch(url.origin + '/__wxa__/preload/private.txt');
    expect(response.status).toBe(404);
    expect(await response.text()).toContain('Service Worker');
  });

  it('用户传入多个包时每个包都能独立下载，同名包会明确报错', async () => {
    const root = temp({ 'a.wxapack': 'a', 'b.wxapack': 'b' });
    const server = await start([path.join(root, 'a.wxapack'), path.join(root, 'b.wxapack')]);
    const url = new URL(server.url);
    const contents = await Promise.all(url.searchParams.getAll('pack').map(async pack => (await fetch(new URL(pack, url))).text()));
    expect(contents).toEqual(['a', 'b']);
    const other = temp({ 'a.wxapack': 'other' });
    expect(() => new ViewerServer({ packs: [path.join(root, 'a.wxapack'), path.join(other, 'a.wxapack')] })).toThrow(/同名/);
  });

  it('用户的小程序请求通过本机代理发送到上游', async () => {
    const upstream = http.createServer((req, res) => res.end(req.url));
    upstreams.push(upstream);
    await new Promise<void>(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const server = await start();
    const port = (upstream.address() as AddressInfo).port;
    const response = await fetch(`${server.url}/__wxa__/proxy/http/127.0.0.1:${port}/a%2Fb?q=1`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('/a%2Fb?q=1');
  });

  it('用户访问未被 Service Worker 接管的页面时收到明确的 404 提示', async () => {
    const server = await start();
    const response = await fetch(server.url + '/__wxa__/app-info.json');
    expect(response.status).toBe(404);
    expect(await response.text()).toMatch(/Service Worker.*未/);
  });

  it('用户指定已占用的端口时服务启动失败', async () => {
    const first = await start();
    const second = new ViewerServer({ port: Number(new URL(first.url).port), host: '127.0.0.1' });
    servers.push(second);
    await expect(second.start()).rejects.toThrow(/端口.*已被占用/);
  });
});

describe.skipIf(!ready)('查看器导出', () => {
  it('ESM 调用者能解析 WASM 资源并导出站点', () => {
    const output = path.join(temp(), 'esm-site');
    const result = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { ViewerServer, exportViewer } from './packages/viewer/dist/index.mjs';
      const server = new ViewerServer({ port: 0, host: '127.0.0.1' });
      try {
        const url = await server.start();
        const response = await fetch(url + '/__wxa__/runtime/esbuild.wasm');
        if (response.status !== 200) throw new Error('WASM unavailable');
        await response.body.cancel();
        exportViewer(${JSON.stringify(output)});
      } finally { await server.close(); }
    `
      ],
      { cwd: REPO_ROOT, encoding: 'utf8', timeout: 30000 }
    );
    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(output, 'site/__wxa__/runtime/esbuild.wasm'))).toBe(true);
  });

  it('导出的是和 preview 内容相同的纯静态站点，加一个转发请求的处理函数，没有任何平台专用的配置', async () => {
    const out = path.join(temp(), 'export');
    exportViewer(out);
    expect(fs.readdirSync(out).sort()).toEqual(['proxy.mjs', 'site']);
    for (const file of ['_headers', '_redirects', '__wxa__/host.html', '__wxa__/runtime/pack-sw.js']) {
      expect(fs.existsSync(path.join(out, 'site', file)), file).toBe(false);
    }
    const site = resolveViewerSite({});
    const server = await start();
    for (const file of ['index.html', 'viewer.json', 'pack-sw.js', '__wxa__/runtime/host.js', '__wxa__/runtime/viewer.js', '__wxa__/runtime/esbuild.wasm', '__baselib__/WAWebview.js']) {
      const response = await fetch(`${server.url}/${file}`);
      expect(response.status, file).toBe(200);
      expect(Buffer.from(await response.arrayBuffer()).equals(fs.readFileSync(path.join(out, 'site', file))), file).toBe(true);
    }
    expect(JSON.parse(fs.readFileSync(path.join(out, 'site/viewer.json'), 'utf8')).baseLibVersion).toBe(site.baseLib.version);
    const proxy = await import(pathToFileURL(path.join(out, 'proxy.mjs')).href);
    expect(typeof proxy.createProxyHandler).toBe('function');
    expect(proxy.PROXY_PATH).toBe('/__wxa__/proxy/');
  });

  it('导出时带上默认包：包放进站点，viewer.json 列出它们的地址，供首次打开时导入', () => {
    const root = temp({ 'showcase.wxapack': 'showcase-bytes', '演示 包.wxapack': 'demo-bytes' });
    const out = path.join(root, 'export');
    exportViewer(out, { packs: [path.join(root, 'showcase.wxapack'), path.join(root, '演示 包.wxapack')] });
    expect(fs.readFileSync(path.join(out, 'site/__wxa__/preload/showcase.wxapack'), 'utf8')).toBe('showcase-bytes');
    expect(fs.readFileSync(path.join(out, 'site/__wxa__/preload/演示 包.wxapack'), 'utf8')).toBe('demo-bytes');
    expect(JSON.parse(fs.readFileSync(path.join(out, 'site/viewer.json'), 'utf8')).defaultPacks).toEqual([
      '/__wxa__/preload/showcase.wxapack',
      '/__wxa__/preload/%E6%BC%94%E7%A4%BA%20%E5%8C%85.wxapack'
    ]);
  });

  it('默认包不存在、不是 .wxapack 或重名时导出失败，不动输出目录', () => {
    const root = temp({ 'a.wxapack': 'a', 'b/a.wxapack': 'b', 'notes.txt': 'x', 'export/site/index.html': 'existing' });
    const out = path.join(root, 'export');
    expect(() => exportViewer(out, { force: true, packs: [path.join(root, 'missing.wxapack')] })).toThrow(/找不到/);
    expect(() => exportViewer(out, { force: true, packs: [path.join(root, 'notes.txt')] })).toThrow(/不是 .wxapack/);
    expect(() => exportViewer(out, { force: true, packs: [path.join(root, 'a.wxapack'), path.join(root, 'b/a.wxapack')] })).toThrow(/同名/);
    expect(fs.readFileSync(path.join(out, 'site/index.html'), 'utf8')).toBe('existing');
  });

  it('默认包经符号链接指向要覆盖的 site/ 时导出失败，不删除包', () => {
    const root = temp({ 'export/site/demo.wxapack': 'demo-bytes' });
    const out = path.join(root, 'export');
    fs.mkdirSync(path.join(root, 'packs'));
    fs.symlinkSync(path.join(out, 'site/demo.wxapack'), path.join(root, 'packs/demo.wxapack'));
    fs.symlinkSync(path.join(out, 'site'), path.join(root, 'packs/site-link'));
    expect(() => exportViewer(out, { force: true, packs: [path.join(root, 'packs/demo.wxapack')] })).toThrow(/不能包含/);
    expect(() => exportViewer(out, { force: true, packs: [path.join(root, 'packs/site-link/demo.wxapack')] })).toThrow(/不能包含/);
    expect(fs.readFileSync(path.join(out, 'site/demo.wxapack'), 'utf8')).toBe('demo-bytes');
  });

  it('导出到非空目录时被拒绝，force 才覆盖导出的文件，目录里的其他文件不动', () => {
    const root = temp({ 'site/index.html': 'existing', 'notes.txt': 'keep' });
    expect(() => exportViewer(root)).toThrow(/非空/);
    expect(fs.readFileSync(path.join(root, 'site/index.html'), 'utf8')).toBe('existing');
    exportViewer(root, { force: true });
    expect(fs.readFileSync(path.join(root, 'site/index.html'), 'utf8')).toBe(viewerIndexHtml());
    expect(fs.readFileSync(path.join(root, 'notes.txt'), 'utf8')).toBe('keep');
  });
});
