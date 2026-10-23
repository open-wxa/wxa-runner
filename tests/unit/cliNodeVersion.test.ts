/**
 * 命令行在低于要求的 Node.js 上启动时直接退出并说明原因
 *
 * 开发服务器用到 Node.js 18 起才有的全局 fetch 等：不拦下来的话能启动，到借开发者工具登录态、
 * 转发 wx.request 时才报 fetch is not defined，看不出是 Node.js 版本的问题。npm / npx 对 engines 只警告不拦截
 */

import { spawnSync } from 'child_process';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createProject, REPO_ROOT } from '../helpers';

const CLI = path.join(REPO_ROOT, 'packages/cli/bin/wxa-runner.js');

/** 在 CLI 之前执行的脚本把 process.versions.node 改成 version，模拟在这个版本的 Node.js 上运行 */
function runCli(args: string[], version?: string) {
  const preload = version
    ? ['--require', path.join(createProject({ 'fake-node-version.js': `Object.defineProperty(process.versions, 'node', { value: '${version}' });` }), 'fake-node-version.js')]
    : [];
  return spawnSync(process.execPath, [...preload, CLI, ...args], { encoding: 'utf8', env: { ...process.env, FORCE_COLOR: '0' } });
}

describe('wxa-runner：Node.js 版本', () => {
  it('低于 18 时任何命令都直接退出，说明要求的版本、当前版本和怎么切换', () => {
    for (const args of [['dev', '.'], ['--version']]) {
      const result = runCli(args, '16.14.0');
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Node.js 18');
      expect(result.stderr).toContain('16.14.0');
      expect(result.stderr).toContain('nvm use');
    }
  });

  it('18 及以上照常运行', () => {
    const result = runCli(['--version'], '18.0.0');
    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
