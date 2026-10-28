import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveBaseLib, usesIsolatedContext } from '../../../packages/extractor/src/baselib';
import { AppBuilder } from '../../../packages/core/src/project/AppBuilder';
import { MiniProgram } from '../../../packages/core/src/project/MiniProgram';
import { createPack } from '../../../packages/viewer/src/pack/createPack';
import { isPackStaticFile, PACK_FORMAT, readPack } from '../../../packages/viewer/src/pack/format';
import { createProject, hasToolchain, REPO_ROOT } from '../../helpers';

const coreRequire = createRequire(path.join(REPO_ROOT, 'packages/core/package.json'));
const viewerRequire = createRequire(path.join(REPO_ROOT, 'packages/viewer/package.json'));
const { zipSync, strToU8 } = viewerRequire('fflate');
const roots: string[] = [];
const projectFiles = {
  'app.json': { pages: ['pages/index/index'], workers: 'workers' },
  'app.js': 'App({});',
  'app.wxss': '',
  'pages/index/index.js': 'Page({ data: { title: "你好" } });',
  'pages/index/index.wxml': '<view>{{title}}</view>',
  'pages/index/index.wxss': 'view { color: red; }',
  'workers/task.js': 'worker.postMessage("ready");'
};

function project(files: Record<string, string | object> = {}): string {
  const root = createProject({ ...projectFiles, ...files });
  roots.push(root);
  return root;
}

afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));

describe('wxapack 静态资源规则', () => {
  it.each(['images/a.png', 'fonts/a.woff2', 'video/a.mp4', 'data.json', 'nested/config.txt', 'miniprogram_npm/ui/icon.svg'])(
    '资源 %s 可以放进 static',
    file => expect(isPackStaticFile(file)).toBe(true)
  );

  it.each([
    'app.js',
    'index.wxml',
    'util.wxs',
    'app.wxss',
    'style.less',
    'style.scss',
    'style.sass',
    'source.ts',
    'project.config.json',
    'project.private.config.json',
    'nested/project.config.json',
    'node_modules/lib/a.png',
    'nested/node_modules/lib/a.png',
    '.git/config',
    'nested/.cache/a.png'
  ])('源码或被忽略的资源 %s 不放进 static', file => expect(isPackStaticFile(file)).toBe(false));
});

describe('wxapack 读取失败', () => {
  it('读取器在内容不是 zip 时说明包已损坏', () => {
    expect(() => readPack(new Uint8Array([1, 2, 3]))).toThrow(/不是.*wxapack.*zip/i);
  });

  it('读取器在 zip 缺少 manifest 时指出缺少的文件', () => {
    expect(() => readPack(zipSync({}))).toThrow('不是 wxapack 包：缺少 manifest.json');
  });

  it('读取器在格式版本未知时提示升级', () => {
    const bytes = zipSync({ 'manifest.json': strToU8(JSON.stringify({ format: 2 })) });
    expect(() => readPack(bytes)).toThrow('wxapack 格式版本 2 不受支持，请升级 wxa-runner');
  });

  it.each(['{', 'null', '{"format":1}'])('读取器在 manifest 内容无效时给出中文原因：%s', manifest => {
    expect(() => readPack(zipSync({ 'manifest.json': strToU8(manifest) }))).toThrow(/manifest.json.*无效/);
  });

  it('读取器能直接打包为浏览器脚本，无需 Node 兼容层', async () => {
    const { build } = coreRequire('esbuild');
    const result = await build({
      entryPoints: [path.join(REPO_ROOT, 'packages/viewer/src/pack/format.ts')],
      bundle: true,
      platform: 'browser',
      format: 'esm',
      write: false,
      logLevel: 'silent'
    });
    expect(result.outputFiles[0].text).toContain('readPack');
  });
});

describe.skipIf(!hasToolchain())('wxapack 打包往返', () => {
  it('小程序打包后保留清单、构建结果、逻辑层和 Worker 的模块脚本', async () => {
    const root = project({ 'project.config.json': { appid: 'wxpacktest' } });
    const builder = new AppBuilder(new MiniProgram(root));
    try {
      const expected = await builder.build();
      const baseLib = resolveBaseLib();
      const { bytes, manifest, warnings } = await createPack({ projectPath: root, baseLibVersion: baseLib.version });
      const pack = readPack(bytes);

      expect(PACK_FORMAT).toBe(1);
      expect(pack.manifest).toEqual(manifest);
      expect(manifest).toEqual({
        format: 1,
        generator: `wxa-viewer@${viewerRequire('./package.json').version}`,
        createdAt: expect.any(String),
        appid: 'wxpacktest',
        baseLib: { version: baseLib.version, hasWorker: fs.existsSync(path.join(baseLib.dir, 'WAWorker.js')) },
        isolated: usesIsolatedContext(baseLib.version),
        build: {
          version: expected.version,
          wxConfig: expected.wxConfig,
          modules: expected.modules,
          workerModules: expected.workerModules,
          pages: expected.pages,
          components: expected.components
        },
        setup: false
      });
      expect(new Date(manifest.createdAt).toISOString()).toBe(manifest.createdAt);
      expect(pack.build).toEqual({ ...expected, durationMs: 0 });
      for (const id of [...expected.modules, ...expected.workerModules]) {
        expect(pack.moduleScript(id)).toBe(builder.getModuleScript(id));
      }
      expect(pack.moduleScript('missing.js')).toBeNull();
      expect(pack.setupScript).toBeNull();
      expect(warnings).toEqual([]);
    } finally {
      builder.dispose();
    }
  });

  it('小程序使用 miniprogramRoot 时只收集代码根目录中的静态资源', async () => {
    const root = createProject({
      'project.config.json': { appid: 'wxroot', miniprogramRoot: 'src' },
      'outside.txt': 'outside',
      ...Object.fromEntries(Object.entries(projectFiles).map(([file, content]) => ['src/' + file, content])),
      'src/images/pixel.png': Buffer.from([0, 255, 128, 42]),
      'src/data.json': { title: '你好' },
      'src/.cache/hidden.txt': 'ignored',
      'src/node_modules/lib/ignored.txt': 'ignored',
      'src/project.private.config.json': { secret: true }
    });
    roots.push(root);
    const pack = readPack((await createPack({ projectPath: root })).bytes);

    expect(pack.staticFile('images/pixel.png')).toEqual(new Uint8Array([0, 255, 128, 42]));
    expect(new TextDecoder().decode(pack.staticFile('data.json')!)).toBe('{"title":"你好"}');
    for (const file of [
      'outside.txt',
      'app.js',
      'app.wxss',
      'pages/index/index.wxml',
      '.cache/hidden.txt',
      'node_modules/lib/ignored.txt',
      'project.private.config.json',
      'missing.png'
    ]) {
      expect(pack.staticFile(file)).toBeNull();
    }
  });

  it('小程序默认 setup 连同依赖打包成可直接运行的 ES 模块', async () => {
    const root = project({
      'wxa.setup.ts':
        'import { defineSetup } from "@open-wxa/wxa-runner-core/setup"; import { label } from "./label"; export default defineSetup({ storage: { label } });',
      'label.ts': 'export const label: string = "打包 setup";'
    });
    const pack = readPack((await createPack({ projectPath: root })).bytes);
    const setup = await import('data:text/javascript;base64,' + Buffer.from(pack.setupScript!).toString('base64'));

    expect(pack.manifest.setup).toBe(true);
    expect(setup.default).toEqual({ storage: { label: '打包 setup' } });
    expect(pack.staticFile('wxa.setup.ts')).toBeNull();
  });

  it('小程序显式选择 setup 时覆盖默认文件，禁用时不包含 setup', async () => {
    const root = project({
      'wxa.setup.ts': 'invalid setup syntax!',
      'custom.ts': 'export default { storage: { chosen: true } };'
    });
    const selected = readPack((await createPack({ projectPath: root, setup: path.join(root, 'custom.ts') })).bytes);
    const disabled = readPack((await createPack({ projectPath: root, setup: false })).bytes);

    expect(selected.setupScript).toContain('chosen');
    expect(disabled.manifest.setup).toBe(false);
    expect(disabled.setupScript).toBeNull();
    await expect(createPack({ projectPath: root, setup: path.join(root, 'missing.ts') })).rejects.toThrow('找不到 setup 文件');
    await expect(createPack({ projectPath: root })).rejects.toThrow();
  });

  it('小程序声明插件时继续打包，并在结果和日志中说明不支持插件', async () => {
    const root = project({
      'app.json': { pages: ['pages/index/index'], plugins: { demo: { version: '1.0.0', provider: 'wxplugin' } } }
    });
    const logged: string[] = [];
    const { bytes, warnings } = await createPack({ projectPath: root, logger: { warn: message => logged.push(message) } });

    expect(readPack(bytes).build.pages).toEqual(['pages/index/index']);
    expect(warnings).toEqual([expect.stringMatching(/不支持插件.*demo/)]);
    expect(logged).toEqual(warnings);
  });

  it('小程序编译失败时拒绝生成包', async () => {
    const root = project({ 'pages/index/index.wxml': '<view><text></view>' });
    await expect(createPack({ projectPath: root })).rejects.toThrow();
  });
});
