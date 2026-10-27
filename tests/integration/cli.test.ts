/**
 * 命令行 dev
 *
 * 是否把浏览器里的 console.warn / console.error 转发到终端：编程助手自己启动开发服务器时，只看得到终端输出，
 * 所以检测到编程助手时默认转发；人在自己的终端里启动时用浏览器的开发者工具看，默认只转发报错。
 *
 * --extension 从用户项目里加载开发服务器扩展，CommonJS 和 ES 模块都可以。
 */

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProject, EXAMPLES, hasToolchain, REPO_ROOT } from '../helpers';

const CLI = path.join(REPO_ROOT, 'packages/cli/bin/wxa-runner.js');
const ready = hasToolchain() && fs.existsSync(path.join(REPO_ROOT, 'packages/core/dist/runtime/host.js'));

/** 编程助手会设置的环境变量（见 @vercel/detect-agent）：测试本身可能就跑在编程助手里，先去掉 */
const AGENT_ENV = /^(AI_AGENT|CLAUDECODE|CLAUDE_CODE|CODEX_|CURSOR_|GEMINI_CLI|OPENCODE|AUGMENT_AGENT|ANTIGRAVITY_AGENT|REPL_ID|COPILOT_)/;

const running: ChildProcess[] = [];

/** 启动 dev，返回启动信息（打印到基础库那一行为止） */
function startDev(args: string[], env: Record<string, string> = {}, cwd?: string): Promise<string> {
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !AGENT_ENV.test(key)));
  const child = spawn(process.execPath, [CLI, 'dev', path.join(EXAMPLES, 'showcase'), '--no-watch', '--port', '0', ...args], {
    cwd,
    env: { ...baseEnv, WXA_BASELIB: '', FORCE_COLOR: '0', ...env }
  });
  running.push(child);
  return new Promise((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      if (output.includes('基础库')) resolve(output);
    });
    child.stderr.on('data', chunk => (output += chunk));
    child.on('exit', code => reject(new Error(`dev 退出了（${code}）：\n${output}`)));
  });
}

const consoleLine = (banner: string) => banner.split('\n').find(line => line.trim().startsWith('控制台'));

afterEach(() => {
  running.splice(0).forEach(child => child.kill());
});

describe.skipIf(!ready)('wxa-runner dev：转发浏览器的控制台输出', () => {
  it('在编程助手里启动时转发报错和 console.warn / console.error，启动信息写明检测到的编程助手', async () => {
    const line = consoleLine(await startDev([], { AI_AGENT: 'test-agent' }));
    expect(line).toContain('console.warn');
    expect(line).toContain('test-agent');
  });

  it('没检测到编程助手时只转发报错，提示怎么开启 console 转发', async () => {
    const line = consoleLine(await startDev([]));
    expect(line).toContain('转发报错');
    expect(line).toContain('--forward-console');
  });

  it('--forward-console：没检测到编程助手也转发 console.warn / console.error', async () => {
    const line = consoleLine(await startDev(['--forward-console']));
    expect(line).toContain('console.warn');
    expect(line).not.toContain('--forward-console');
  });

  it('--no-forward-console 优先于检测结果，什么都不转发', async () => {
    const line = consoleLine(await startDev(['--no-forward-console'], { AI_AGENT: 'test-agent' }));
    expect(line).toContain('不转发');
    expect(line).not.toContain('test-agent');
  });
});

describe.skipIf(!ready)('wxa-runner dev --extension', () => {
  /** 一个装在项目 node_modules 里的扩展：默认导出返回扩展的函数，页面上回显 setup 收到的小程序根目录 */
  const projectWithExtension = () => createProject({
    'node_modules/fake-ext/package.json': { name: 'fake-ext', main: 'index.js' },
    'node_modules/fake-ext/index.js': `
      module.exports = () => ({
        name: 'fake-ext',
        setup: ({ root }) => ({
          middlewares: [{ path: '/__fake__', handler: (req, res) => res.end('root=' + root) }],
          entry: { label: '假扩展', path: '/__fake__/' }
        })
      });`,
    'local-ext.js': `exports.default = { name: 'local', setup: () => ({ entry: { label: 'local', path: '/__local__/' } }) };`
  });

  it('从当前目录的项目加载扩展，挂上它的中间件，启动信息给出扩展页面的地址', async () => {
    const banner = await startDev(['--extension', 'fake-ext'], {}, projectWithExtension());
    const url = /假扩展\s+(\S+)/.exec(banner)?.[1];
    expect(url).toMatch(/\/__fake__\/$/);
    expect(await (await fetch(url!)).text()).toBe(`root=${path.join(EXAMPLES, 'showcase')}`);
  });

  it('可以写多次，也可以是文件路径', async () => {
    const banner = await startDev(['--extension', 'fake-ext', '--extension', './local-ext.js'], {}, projectWithExtension());
    expect(banner).toMatch(/假扩展\s+\S+\/__fake__\//);
    expect(banner).toMatch(/local\s+\S+\/__local__\//);
  });

  it('加载 ES 模块写的扩展，包括顶层 await 的', async () => {
    const cwd = createProject({
      'node_modules/esm-ext/package.json': { name: 'esm-ext', type: 'module', exports: './index.js' },
      'node_modules/esm-ext/index.js': `
        const label = await Promise.resolve('ESM 扩展');
        export default { name: 'esm-ext', setup: () => ({ entry: { label, path: '/__esm__/' } }) };`
    });
    expect(await startDev(['--extension', 'esm-ext'], {}, cwd)).toMatch(/ESM 扩展\s+\S+\/__esm__\//);
  });

  it('装了但解析不出入口时报出原因，不提示安装', async () => {
    const cwd = createProject({
      'node_modules/import-only-ext/package.json': { name: 'import-only-ext', exports: { import: './index.mjs' } },
      'node_modules/import-only-ext/index.mjs': 'export default {};'
    });
    const started = startDev(['--extension', 'import-only-ext'], {}, cwd);
    await expect(started).rejects.toThrow(/扩展 import-only-ext 加载失败[\s\S]*require 或 default/);
    await expect(started).rejects.not.toThrow(/npm i -D/);
  });

  it('找不到扩展时说明安装方法并退出', async () => {
    await expect(startDev(['--extension', 'missing-ext'], {}, createProject({}))).rejects.toThrow(/找不到扩展 missing-ext[\s\S]*npm i -D missing-ext/);
  });

  it('模块不是扩展时说明要求', async () => {
    const cwd = createProject({ 'not-ext.js': 'module.exports = { hello: 1 };' });
    await expect(startDev(['--extension', './not-ext.js'], {}, cwd)).rejects.toThrow(/不是 wxa-runner 的扩展/);
  });
});
