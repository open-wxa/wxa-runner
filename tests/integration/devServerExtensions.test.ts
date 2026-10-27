/**
 * 开发服务器给开发工具的扩展点：webviewScripts、middlewares、wxmlTransform，以及把它们打包在一起的扩展（extensions）
 */

import fs from 'fs';
import path from 'path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { AppBuilder } from '../../packages/core/src/project/AppBuilder';
import { MiniProgram } from '../../packages/core/src/project/MiniProgram';
import { DevServer, DevServerOptions } from '../../packages/core/src/server/DevServer';
import type { DevServerExtension } from '../../packages/core/src/server/extensions';
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

  it('默认放在 body 开头、页面开始渲染之前；内联内容里的 </script> 不会提前结束标签', async () => {
    const html = await pageHtml();
    const late = html.indexOf('<script>window.__late = "<\\/script>";</script>');
    expect(late).toBeGreaterThan(html.indexOf('<body>'));
    expect(late).toBeLessThan(html.indexOf("$gwx('./' + path + '.wxml')"));
  });

  it('插件页面同样注入', () => {
    const build = { version: 1, wxConfig: { page: {} }, pages: [] } as unknown as AppBuild;
    const plugin = { alias: 'demo', provider: 'wx1', version: '1.0.0', files: new Map([['/pages/a.html', Buffer.from('<div></div>')]]) } as unknown as PluginCode;
    const html = pluginWebviewHtml(build, plugin, 'pages/a', 'plugin-private://wx1/pages/a', 2, {
      scripts: [{ src: '/__tool__/early.js', position: 'head' }, { src: '/__tool__/late.js' }]
    });
    expect(html.indexOf('/__tool__/early.js')).toBeLessThan(html.indexOf('/__baselib__/WAWebview.js'));
    expect(html.indexOf('/__tool__/late.js')).toBeGreaterThan(html.indexOf('<body>'));
    expect(html.indexOf('/__tool__/late.js')).toBeLessThan(html.indexOf('<div></div>'));
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

  // Express 匹配路径不区分大小写，还支持通配符和参数：'/__WXA__' 会截走 /__wxa__ 下的请求，'/*'、'/:tool?' 连首页也会截走
  it.each(['/', 'tool', '/__wxa__', '/__wxa__/tool', '/__WXA__', '/__Baselib__/x', '/__plugin__/x', '/*', '/:tool?', '/tool/*', '/tool(.*)'])('不能挂在 %s', mountPath => {
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

describe.skipIf(!ready)('extensions', () => {
  const text = (handlerText: string) => ({ handler: (_req: unknown, res: { end(body: string): void }) => res.end(handlerText) });

  it('setup 收到项目目录和小程序根目录；中间件、脚本按顺序合并在直接给出的选项之后；入口按扩展的顺序', async () => {
    const contexts: unknown[] = [];
    const extension = (name: string): DevServerExtension => ({
      name,
      setup: context => {
        contexts.push(context);
        return {
          webviewScripts: [{ src: `/__${name}__/runtime.js` }],
          middlewares: [{ path: `/__${name}__`, ...text(name) }, { path: '/__shared__', ...text(name) }],
          entry: { label: name, path: `/__${name}__/` }
        };
      }
    });
    vi.stubEnv('WXA_BASELIB', '');
    const server = createServer({
      webviewScripts: [{ src: '/__base__/runtime.js' }],
      middlewares: [{ path: '/__shared__', ...text('base') }],
      extensions: [extension('one'), extension('two')]
    });
    const base = await server.start();
    try {
      const showcase = path.join(EXAMPLES, 'showcase');
      expect(contexts).toEqual([{ projectPath: showcase, root: showcase }, { projectPath: showcase, root: showcase }]);
      expect(await (await fetch(`${base}/__two__/`)).text()).toBe('two');
      // 同一路径先挂的先处理
      expect(await (await fetch(`${base}/__shared__/`)).text()).toBe('base');
      const html = await (await fetch(`${base}/__wxa__/webview/pages/index/index.html?id=1`)).text();
      const order = ['/__base__/', '/__one__/', '/__two__/'].map(prefix => html.indexOf(`${prefix}runtime.js`));
      expect(order).toEqual([...order].sort((a, b) => a - b));
      expect(order[0]).toBeGreaterThan(0);
      expect(server.extensionEntries).toEqual([
        { name: 'one', label: 'one', path: '/__one__/' },
        { name: 'two', label: 'two', path: '/__two__/' }
      ]);
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });

  it('wxml 转换按顺序串起来：后面的转换拿到前面的结果', async () => {
    const seen: string[] = [];
    const builder = createServer({
      wxmlTransform: code => code.replace(/<view/g, '<view data-a="1"'),
      extensions: [{
        name: 'second',
        setup: () => ({
          wxmlTransform: (code, file) => {
            if (file === 'pages/index/index.wxml') seen.push(code);
            return code.replace(/data-a="1"/g, 'data-a="1" data-b="2"');
          }
        })
      }]
    }).builder;
    const build = await builder.build();
    expect(seen[0]).toContain('data-a="1"');
    expect(build.pageTemplates).toContain("'data-b'");
    builder.dispose();
  });

  it('扩展的中间件路径同样校验；setup 出错时报出是哪个扩展', () => {
    expect(() => createServer({ extensions: [{ name: 'bad', setup: () => ({ middlewares: [{ path: '/__wxa__/x', ...text('') }] }) }] }))
      .toThrow(/中间件路径/);
    expect(() => createServer({ extensions: [{ name: 'broken', setup: () => { throw new Error('缺少配置'); } }] }))
      .toThrow('扩展 broken 初始化失败：缺少配置');
  });
});

/** 开发工具（如 wxa-inspector 的页面）靠这两项显示编译错误，见 PROJECT_DESIGN.md 的「开发工具扩展点」 */
describe.skipIf(!ready)('开发工具依赖的编译状态', () => {
  const project = (wxml: string) => createProject({
    'app.json': { pages: ['pages/index/index'] },
    'pages/index/index.json': {},
    'pages/index/index.wxml': wxml,
    'pages/index/index.js': 'Page({})'
  });
  const BROKEN = '<view>\n<text>{{ a </text>\n</view>\n';

  it('编译失败时 /__wxa__/app-info.json 带 buildError，说明出错的文件', async () => {
    vi.stubEnv('WXA_BASELIB', '');
    const server = createServer({ projectPath: project(BROKEN) });
    const base = await server.start();
    try {
      const info = await (await fetch(`${base}/__wxa__/app-info.json`)).json();
      expect(info.buildError).toMatch(/pages\/index\/index\.wxml/);
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  });

  it('/__wxa__/ws：重新编译失败时广播 { type: error, message }，修好后广播 hot 或 reload', async () => {
    vi.stubEnv('WXA_BASELIB', '');
    const root = project('<view>ok</view>\n');
    const server = createServer({ projectPath: root, watch: true });
    const base = await server.start();
    const socket = new WebSocket(`${base.replace('http', 'ws')}/__wxa__/ws`);
    const messages: Array<{ type: string; message?: string }> = [];
    socket.on('message', data => messages.push(JSON.parse(String(data))));
    // 开发服务器不暴露文件监听何时就绪，就绪前的改动会被忽略：每次写入的内容略有不同，没收到就再写一次
    const writeUntil = (file: string, content: string, type: (t: string) => boolean) => vi.waitFor(() => {
      const found = messages.find(m => type(m.type));
      if (found) return found;
      fs.writeFileSync(file, `${content}<!-- ${Date.now()} -->\n`);
      throw new Error(`还没收到，已收到：${JSON.stringify(messages)}`);
    }, { timeout: 15000, interval: 1000 });
    try {
      await new Promise(resolve => socket.once('open', resolve));
      const file = path.join(root, 'pages/index/index.wxml');
      expect((await writeUntil(file, BROKEN, t => t === 'error')).message).toMatch(/pages\/index\/index\.wxml/);
      messages.length = 0;
      await writeUntil(file, '<view>fixed</view>\n', t => t === 'hot' || t === 'reload');
    } finally {
      socket.close();
      await server.close();
      vi.unstubAllEnvs();
    }
  });
});
