import { createRequire } from 'module';
import { describe, expect, it, vi } from 'vitest';
import { compileSetup } from '../../../packages/viewer/src/page/compileSetup';
import { downloadPacks, importProject, importProjects, parseEnv, withDefaultPacks } from '../../../packages/viewer/src/page/projects';

const coreRequire = createRequire(new URL('../../../packages/core/package.json', import.meta.url));
const { build } = coreRequire('esbuild');
const { zipSync, strToU8 } = coreRequire('fflate');

function pack(appid = 'wxviewer'): Uint8Array {
  const manifest = {
    format: 1, generator: 'test', createdAt: '2026-10-28', appid,
    baseLib: { version: '3.7.0', hasWorker: false }, isolated: false, setup: false,
    build: { version: 1, wxConfig: {}, modules: [], workerModules: [], pages: ['pages/index/index'], components: [] }
  };
  return zipSync(Object.fromEntries([
    ['manifest.json', strToU8(JSON.stringify(manifest))],
    ...['service-templates', 'service-bootstrap', 'page-frame', 'page-templates', 'page-styles'].map(name => [`code/${name}.js`, strToU8('')])
  ]));
}

async function evaluate(source: string, filename = 'wxa.setup.ts') {
  const code = await compileSetup(source, filename, build);
  return (await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)).default;
}

describe('查看器编译 setup', () => {
  it('setup 的 defineSetup 和 TypeScript 语法编译后保留配置与函数', async () => {
    const setup = await evaluate(`import { defineSetup } from '@open-wxa/wxa-runner-core/setup';
      const count: number = 3;
      export default defineSetup({ storage: { count }, run: ({ env }: any) => env.WXA_TOKEN });`);
    expect(setup.storage).toEqual({ count: 3 });
    expect(setup.run({ env: { WXA_TOKEN: 'secret' } })).toBe('secret');
  });

  it.each(['setup.js', 'setup.mjs'])('setup 文件 %s 可直接导出对象', async filename => {
    expect(await evaluate('export default { storage: { ok: true } };', filename)).toEqual({ storage: { ok: true } });
  });

  it.each(['./helper', 'https://example.com/module.js', 'some-package'])('setup 引用 %s 时说明单文件限制', async dependency => {
    await expect(compileSetup(`import value from '${dependency}'; export default value;`, 'setup.ts', build))
      .rejects.toThrow('查看器里的 setup 只能是单个文件');
  });

  it('setup 动态导入其他文件时同样报错', async () => {
    await expect(compileSetup(`export default { run: () => import('./helper') };`, 'setup.ts', build))
      .rejects.toThrow('查看器里的 setup 只能是单个文件');
  });

  it('setup 用变量动态导入时同样说明单文件限制', async () => {
    await expect(compileSetup(`export default { run: (path) => import(path) };`, 'setup.ts', build))
      .rejects.toThrow('查看器里的 setup 只能是单个文件');
  });

  it('setup 语法错误时返回编译错误', async () => {
    await expect(compileSetup('export default {', 'setup.ts', build)).rejects.toThrow();
  });
});

describe('查看器项目导入', () => {
  it('拖入同名包始终创建新项目，保留原项目', () => {
    const first = importProject(pack(), 'demo.wxapack', [], false, 10);
    const second = importProject(pack(), 'demo.wxapack', [first], false, 20);
    expect(second.id).not.toBe(first.id);
    expect(second).toMatchObject({ name: 'demo', appid: 'wxviewer', importedAt: 20, updatedAt: 20, env: {}, setupSource: null });
  });

  it('地址栏导入只替换同名同 appid 的包并保留用户配置', () => {
    const first = { ...importProject(pack(), 'demo.wxapack', [], false, 10), env: { WXA_TOKEN: 'keep' }, setupSource: 'source', setupScript: 'script', setupFileName: 'custom.ts' };
    const replacement = importProject(pack(), 'demo.wxapack', [first], true, 10);
    expect(replacement).toMatchObject({ id: first.id, importedAt: 10, updatedAt: 11, env: first.env, setupSource: 'source', setupScript: 'script' });
    expect(importProject(pack('other'), 'demo.wxapack', [first], true).id).not.toBe(first.id);
    expect(importProject(pack(), 'different.wxapack', [first], true).id).not.toBe(first.id);
  });

  it('坏包保留读取器的具体错误', () => {
    expect(() => importProject(new Uint8Array([1, 2]), 'bad.wxapack')).toThrow('不是 wxapack 包：无法读取 zip');
  });

  it('地址栏的同源 pack 下载后给出文件名和移除参数的地址', async () => {
    const bytes = pack();
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response(new Uint8Array(bytes)));
    const result = await downloadPacks('https://viewer.test/?pack=%2F__wxa__%2Fpreload%2Fdemo.wxapack&theme=dark#current', fetcher);
    expect(result!.cleanURL).toBe('https://viewer.test/?theme=dark#current');
    expect(result!.packs).toHaveLength(1);
    expect(result!.packs[0]).toMatchObject({ filename: 'demo.wxapack' });
    expect(result!.packs[0].bytes).toEqual(bytes);
    expect(fetcher.mock.calls[0][0]).toBe('https://viewer.test/__wxa__/preload/demo.wxapack');
  });

  it('地址栏带多个 pack 时按顺序全部下载（preview 传了多个包）', async () => {
    const fetcher = vi.fn(async (url: RequestInfo | URL) => new Response(new Uint8Array(pack(String(url).includes('b.wxapack') ? 'wxb' : 'wxa'))));
    const result = await downloadPacks('https://viewer.test/?pack=/__wxa__/preload/a.wxapack&pack=/__wxa__/preload/b.wxapack', fetcher);
    expect(result!.packs.map(item => item.filename)).toEqual(['a.wxapack', 'b.wxapack']);
    expect(result!.cleanURL).toBe('https://viewer.test/');
  });

  it.each(['https://other.test/a.wxapack', '//other.test/a.wxapack', 'data:text/plain,hello'])('地址栏拒绝非同源 pack：%s', async url => {
    const fetcher = vi.fn();
    await expect(downloadPacks(`https://viewer.test/?pack=${encodeURIComponent(url)}`, fetcher)).rejects.toThrow('同源');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('第一次打开站点（浏览器里没有项目、地址栏不带 pack）时下载站点的默认包，地址栏保持原样', async () => {
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response(new Uint8Array(pack())));
    const result = await downloadPacks(withDefaultPacks('https://viewer.test/?theme=dark', ['/__wxa__/preload/showcase.wxapack'], false), fetcher);
    expect(result!.packs.map(item => item.filename)).toEqual(['showcase.wxapack']);
    expect(result!.cleanURL).toBe('https://viewer.test/?theme=dark');
  });

  it('浏览器里已经有项目，或地址栏指定了 pack 时，不导入默认包', async () => {
    const defaults = ['/__wxa__/preload/showcase.wxapack'];
    expect(await downloadPacks(withDefaultPacks('https://viewer.test/', defaults, true), vi.fn())).toBeNull();
    const fetcher = vi.fn(async (_url: RequestInfo | URL) => new Response(new Uint8Array(pack())));
    const result = await downloadPacks(withDefaultPacks('https://viewer.test/?pack=/__wxa__/preload/mine.wxapack', defaults, false), fetcher);
    expect(result!.packs.map(item => item.filename)).toEqual(['mine.wxapack']);
  });

  it('一批包里有坏包时整批都不导入，修好后刷新还会重试', () => {
    const packs = [{ filename: 'a.wxapack', bytes: pack('wxa') }, { filename: 'b.wxapack', bytes: strToU8('broken') }];
    expect(() => importProjects(packs, [])).toThrow();
    const fixed = importProjects([packs[0], { filename: 'b.wxapack', bytes: pack('wxb') }], []);
    expect(fixed.map(project => project.appid)).toEqual(['wxa', 'wxb']);
  });

  it('地址栏不带 pack 时不下载，下载失败时返回原因', async () => {
    expect(await downloadPacks('https://viewer.test/', vi.fn())).toBeNull();
    await expect(downloadPacks('https://viewer.test/?pack=/missing.wxapack', async () => new Response('', { status: 404 }))).rejects.toThrow('404');
  });
});

describe('查看器环境变量', () => {
  it('环境变量只接受 WXA_ 键并保留值，空白行忽略', () => {
    expect(parseEnv([[' WXA_TOKEN ', ' secret '], ['', '']])).toEqual({ WXA_TOKEN: ' secret ' });
  });

  const invalidRows: Array<[string, string][]> = [[['TOKEN', 'x']], [['', 'x']], [['WXA_TOKEN', 'a'], ['WXA_TOKEN', 'b']]];
  it.each(invalidRows.map(rows => [rows] as const))('环境变量拒绝非法或重复键 %j', rows => {
    expect(() => parseEnv(rows)).toThrow();
  });
});
