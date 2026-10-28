/**
 * wxa-runner viewer 子命令：pack 打包、preview 本机预览、export 导出查看器
 */

import { ChildProcess, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readPack } from '../../packages/viewer/src/pack/format';
import { createProject, hasToolchain, REPO_ROOT } from '../helpers';

const CLI = path.join(REPO_ROOT, 'packages/cli/bin/wxa-runner.js');
const viewerBuilt = fs.existsSync(path.join(REPO_ROOT, 'packages/viewer/dist/index.js')) && fs.existsSync(path.join(REPO_ROOT, 'packages/viewer/dist/runtime/viewer.js'));
const ready = hasToolchain() && fs.existsSync(path.join(REPO_ROOT, 'packages/core/dist/runtime/host.js'));

const running: ChildProcess[] = [];

function startPreview(args: string[] = []): Promise<string> {
  const child = spawn(process.execPath, [CLI, 'viewer', 'preview', '--port', '0', ...args], { env: { ...process.env, FORCE_COLOR: '0' } });
  running.push(child);
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('基础库')) resolve(output);
    });
    child.stderr.on('data', chunk => (output += chunk));
    child.on('error', reject);
    child.on('exit', code => reject(new Error(`preview 退出了（${code}）：\n${output}`)));
  });
}

const buildRoots: string[] = [];

function buildProject(files: Record<string, string | object> = {}): string {
  const root = createProject({
    'app.json': { pages: ['pages/index/index'] },
    'app.js': 'App({});',
    'pages/index/index.js': 'Page({});',
    'pages/index/index.wxml': '<view>Hello</view>',
    ...files
  });
  buildRoots.push(root);
  return root;
}

function runBuild(projectPath: string, args: string[] = [], cwd = projectPath) {
  return spawnSync(process.execPath, [CLI, 'viewer', 'pack', projectPath, ...args], {
    cwd, encoding: 'utf8', timeout: 30000, env: { ...process.env, FORCE_COLOR: '0' }
  });
}

afterEach(() => {
  running.splice(0).forEach(child => child.kill());
  buildRoots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true }));
});

describe.skipIf(!hasToolchain() || !viewerBuilt)('wxa-runner viewer pack', () => {
  it('用户构建项目时默认在当前目录生成以 appid 命名的包并显示摘要', () => {
    const root = buildProject({ 'project.config.json': { appid: 'wxcli' } });
    const cwd = buildProject();
    const result = runBuild(root, [], cwd);
    const output = path.join(cwd, 'wxcli.wxapack');

    expect(result.status, result.stderr).toBe(0);
    expect(readPack(fs.readFileSync(output)).manifest.appid).toBe('wxcli');
    expect(result.stdout).toContain(output);
    expect(result.stdout).toMatch(/大小\s+\d/);
    expect(result.stdout).toMatch(/页面\s+1/);
    expect(result.stdout).toMatch(/基础库\s+\d/);
  });

  it('用户构建无 appid 的项目时默认使用目录名', () => {
    const root = buildProject();
    const result = runBuild(root);

    expect(result.status, result.stderr).toBe(0);
    expect(fs.existsSync(path.join(root, path.basename(root) + '.wxapack'))).toBe(true);
  });

  it('用户指定输出文件和禁用 setup 时得到对应的包及插件警告', () => {
    const root = buildProject({
      'wxa.setup.ts': 'invalid setup syntax!',
      'app.json': { pages: ['pages/index/index'], plugins: { demo: { version: '1.0.0', provider: 'wxplugin' } } }
    });
    const result = runBuild(root, ['-o', 'custom.wxapack', '--no-setup']);

    expect(result.status, result.stderr).toBe(0);
    expect(readPack(fs.readFileSync(path.join(root, 'custom.wxapack'))).manifest.setup).toBe(false);
    expect(result.stdout + result.stderr).toMatch(/不支持插件.*demo/);
  });

  it('用户指定 setup 和基础库版本时写入包的清单', () => {
    const root = buildProject({ 'custom.ts': 'export default { storage: { cli: true } };' });
    const initial = runBuild(root, ['-o', 'first.wxapack']);
    expect(initial.status, initial.stderr).toBe(0);
    const version = readPack(fs.readFileSync(path.join(root, 'first.wxapack'))).manifest.baseLib.version;
    const result = runBuild(root, ['--out', 'second.wxapack', '--setup', 'custom.ts', '-b', version]);

    expect(result.status, result.stderr).toBe(0);
    const pack = readPack(fs.readFileSync(path.join(root, 'second.wxapack')));
    expect(pack.manifest.baseLib.version).toBe(version);
    expect(pack.setupScript).toContain('cli');
  });

  it('用户构建无效项目时收到原因并以 1 退出，不写输出包', () => {
    const root = buildProject({ 'app.json': { pages: [] } });
    const result = runBuild(root, ['-o', 'failed.wxapack']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/打包失败.*app.json.*pages/);
    expect(fs.existsSync(path.join(root, 'failed.wxapack'))).toBe(false);
  });
});

describe.skipIf(!ready || !viewerBuilt)('wxa-runner viewer preview / export', () => {
  it('用户启动 preview 后能读取基础库信息和命令行传入的包', async () => {
    const root = buildProject({ 'demo.wxapack': 'pack-content' });
    const banner = await startPreview([path.join(root, 'demo.wxapack'), '--host', '127.0.0.1']);
    const url = new URL(/地址\s+(\S+)/.exec(banner)![1]);
    const info = await (await fetch(new URL('/viewer.json', url))).json();
    expect(banner).toContain(info.baseLibVersion);
    expect(await (await fetch(new URL(url.searchParams.get('pack')!, url))).text()).toBe('pack-content');
  });

  it('用户导出时得到静态站点和转发处理函数，提示下一步，并拒绝无 force 的覆盖', () => {
    const root = buildProject();
    const out = path.join(root, 'viewer-export');
    const runExport = (extra: string[] = []) => spawnSync(process.execPath, [CLI, 'viewer', 'export', out, ...extra], { encoding: 'utf8', timeout: 30000 });
    const result = runExport();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain(path.join(out, 'site'));
    expect(result.stdout).toContain(path.join(out, 'proxy.mjs'));
    expect(fs.existsSync(path.join(out, 'site/index.html'))).toBe(true);
    const refused = runExport();
    expect(refused.status).toBe(1);
    expect(refused.stderr).toContain('非空');
    expect(runExport(['--force']).status).toBe(0);
  });
});

describe('wxa-runner viewer：没装查看器', () => {
  it('执行查看器命令时提示安装 @open-wxa/wxa-viewer，以 1 退出', () => {
    // 预加载脚本让 @open-wxa/wxa-viewer 解析失败，模拟只装了 wxa-runner 的用户
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-no-viewer-'));
    const block = path.join(dir, 'block-viewer.cjs');
    fs.writeFileSync(
      block,
      `const Module = require('module');
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === '@open-wxa/wxa-viewer') {
    const error = new Error("Cannot find module '@open-wxa/wxa-viewer'");
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return resolve.call(this, request, ...rest);
};`
    );
    const result = spawnSync(process.execPath, ['-r', block, CLI, 'viewer', 'export', path.join(dir, 'out')], { encoding: 'utf8', timeout: 30000 });
    fs.rmSync(dir, { recursive: true, force: true });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('npm i -D @open-wxa/wxa-viewer');
  });

  it('wxa-runner --help 列出 viewer 命令并说明需要查看器包', () => {
    const result = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8', timeout: 30000 });
    expect(result.stdout).toMatch(/^\s+viewer\b[\s\S]*@open-wxa\/wxa-viewer/m);
  });
});
