/**
 * 开发服务器给开发工具的扩展点：webviewScripts、middlewares、wxmlTransform
 */

import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppBuilder } from '../../packages/core/src/project/AppBuilder';
import { MiniProgram } from '../../packages/core/src/project/MiniProgram';
import { DevServer, DevServerOptions } from '../../packages/core/src/server/DevServer';
import { pluginWebviewHtml } from '../../packages/core/src/server/html';
import type { AppBuild, PluginCode } from '../../packages/core/src/server/plugins';
import { createProject, EXAMPLES, hasToolchain, REPO_ROOT } from '../helpers';

const RUNTIME_DIR = path.join(REPO_ROOT, 'packages/core/dist/runtime');
const ready = hasToolchain() && fs.existsSync(path.join(RUNTIME_DIR, 'host.js'));
const silent = { log: () => undefined, warn: () => undefined, error: () => undefined };

function createServer(options: Partial<DevServerOptions>): DevServer {
  return new DevServer({ projectPath: path.join(EXAMPLES, 'showcase'), port: 0, watch: false, runtimeDir: RUNTIME_DIR, logger: silent, ...options });
}

describe.skipIf(!ready)('webviewScripts', () => {
  let server: DevServer;
  let base = '';
  const pageHtml = async () => (await fetch(`${base}/__wxa__/webview/pages/index/index.html?id=1`)).text();

  beforeAll(async () => {
    vi.stubEnv('WXA_BASELIB', '');
    server = createServer({
      webviewScripts: [
        { src: '/__tool__/early.js', position: 'head' },
        { content: 'window.__late = "</script>";' }
      ]
    });
    base = await server.start();
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await server.close();
  });

  it('position: head 的脚本在桥之后、基础库之前执行', async () => {
    const html = await pageHtml();
    const early = html.indexOf('<script src="/__tool__/early.js"></script>');
    expect(early).toBeGreaterThan(html.indexOf('/__wxa__/runtime/frame.js'));
    expect(early).toBeLessThan(html.indexOf('/__baselib__/WAWebview.js'));
  });

  it('默认放在 body 末尾、页面开始渲染之后；内联内容里的 </script> 不会提前结束标签', async () => {
    const html = await pageHtml();
    const late = html.indexOf('<script>window.__late = "<\\/script>";</script>');
    expect(late).toBeGreaterThan(html.indexOf("parent.__wxaHost.frameLoaded('webview', 1)"));
    expect(late).toBeLessThan(html.indexOf('</body>'));
  });

  it('插件页面同样注入', () => {
    const build = { version: 1, wxConfig: { page: {} }, pages: [] } as unknown as AppBuild;
    const plugin = { alias: 'demo', provider: 'wx1', version: '1.0.0', files: new Map([['/pages/a.html', Buffer.from('<div></div>')]]) } as unknown as PluginCode;
    const html = pluginWebviewHtml(build, plugin, 'pages/a', 'plugin-private://wx1/pages/a', 2, {
      scripts: [{ src: '/__tool__/early.js', position: 'head' }, { src: '/__tool__/late.js' }]
    });
    expect(html.indexOf('/__tool__/early.js')).toBeLessThan(html.indexOf('/__baselib__/WAWebview.js'));
    expect(html.indexOf('/__tool__/late.js')).toBeGreaterThan(html.indexOf("frameLoaded('webview', 2)"));
  });
});

describe.skipIf(!ready)('middlewares', () => {
  it('按前缀挂载，handler 收到去掉前缀的地址；不处理时交给 runner', async () => {
    const seen: string[] = [];
    const server = createServer({
      middlewares: [{
        path: '/__tool__',
        handler: (req, res, next) => {
          seen.push(req.url!);
          if (req.url === '/pass') return next();
          res.end('tool');
        }
      }]
    });
    const base = await server.start();
    try {
      expect(await (await fetch(`${base}/__tool__/a?b=1`)).text()).toBe('tool');
      expect((await fetch(`${base}/__tool__/pass`)).status).toBe(404);
      expect(seen).toEqual(['/a?b=1', '/pass']);
      expect(await (await fetch(`${base}/`)).text()).toContain('/__wxa__/runtime/host.js');
    } finally {
      await server.close();
    }
  });

  it.each(['/', 'tool', '/__wxa__', '/__wxa__/tool', '/__baselib__', '/__plugin__/x'])('不能挂在 %s', mountPath => {
    expect(() => createServer({ middlewares: [{ path: mountPath, handler: () => undefined }] })).toThrow(/中间件路径/);
  });
});

describe.skipIf(!hasToolchain())('wxmlTransform', () => {
  const mark = (code: string) => code.replace(/<view/g, '<view data-mark="1"');

  function project(files: Record<string, string | object> = {}): string {
    return createProject({
      'app.json': { pages: ['pages/index/index'] },
      'pages/index/index.json': {},
      'pages/index/index.wxml': '<view>\n  <text>hi</text>\n</view>\n',
      'pages/index/index.js': 'Page({})',
      'utils/fmt.wxs': 'module.exports = { a: "<view>" };',
      ...files
    });
  }

  it('转换结果进入编译产物，源文件不变，.wxs 原样复制', async () => {
    const root = project();
    const builder = new AppBuilder(new MiniProgram(root), { wxmlTransform: mark });
    const build = await builder.build();
    expect(build.pageTemplates).toContain("'data-mark'");
    expect(fs.readFileSync(path.join(root, 'pages/index/index.wxml'), 'utf8')).not.toContain('data-mark');
    expect(fs.readFileSync(path.join(builder.wxmlMirrorDir!, 'utils/fmt.wxs'), 'utf8')).toBe('module.exports = { a: "<view>" };');
    builder.dispose();
  });

  it('只转换内容变化的文件', async () => {
    const root = project({ 'pages/index/other.wxml': '<view/>' });
    const transformed: string[] = [];
    const builder = new AppBuilder(new MiniProgram(root), { wxmlTransform: (code, file) => (transformed.push(file), mark(code)) });
    await builder.build();
    expect(transformed.sort()).toEqual(['pages/index/index.wxml', 'pages/index/other.wxml']);

    transformed.length = 0;
    fs.writeFileSync(path.join(root, 'pages/index/index.wxml'), '<view id="changed"/>\n');
    builder.invalidate(['pages/index/index.wxml']);
    await builder.build();
    expect(transformed).toEqual(['pages/index/index.wxml']);
    builder.dispose();
  });

  it('删掉的文件同时从镜像目录删除，不会被引用它的模板编译进去', async () => {
    const root = project({
      'pages/index/index.wxml': '<include src="part.wxml"/>\n',
      'pages/index/part.wxml': '<view>included-text</view>\n'
    });
    const builder = new AppBuilder(new MiniProgram(root), { wxmlTransform: mark });
    expect((await builder.build()).pageTemplates).toContain('included-text');

    fs.rmSync(path.join(root, 'pages/index/part.wxml'));
    builder.invalidate(['pages/index/part.wxml']);
    // wcc 找不到 include 的文件时不报错，只是没有内容；镜像目录里留着旧文件的话会被编译进去
    expect((await builder.build()).pageTemplates).not.toContain('included-text');
    expect(fs.existsSync(path.join(builder.wxmlMirrorDir!, 'pages/index/part.wxml'))).toBe(false);
    builder.dispose();
  });

  it('编译错误指向源文件的路径', async () => {
    const builder = new AppBuilder(new MiniProgram(project({ 'pages/index/index.wxml': '<view>\n<text>{{ a </text>\n</view>\n' })), { wxmlTransform: mark });
    await expect(builder.build()).rejects.toThrow(/pages\/index\/index\.wxml/);
    builder.dispose();
  });

  it('没有设置转换时直接编译项目目录，不建镜像目录', async () => {
    const builder = new AppBuilder(new MiniProgram(project()));
    await builder.build();
    expect(builder.wxmlMirrorDir).toBeNull();
  });

  it.skipIf(!ready)('开发服务器关闭时删除镜像目录', async () => {
    vi.stubEnv('WXA_BASELIB', '');
    const server = createServer({ wxmlTransform: mark });
    const base = await server.start();
    const mirror = server.builder.wxmlMirrorDir!;
    try {
      expect(await (await fetch(`${base}/__wxa__/page-templates.js`)).text()).toContain("'data-mark'");
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
    expect(fs.existsSync(mirror)).toBe(false);
  });
});
