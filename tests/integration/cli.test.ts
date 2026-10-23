/**
 * 命令行 dev：是否把浏览器里的 console.warn / console.error 转发到终端
 *
 * 编程助手自己启动开发服务器时，只看得到终端输出，所以检测到编程助手时默认转发；
 * 人在自己的终端里启动时用浏览器的开发者工具看，默认只转发报错。
 */

import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { EXAMPLES, hasToolchain, REPO_ROOT } from '../helpers';

const CLI = path.join(REPO_ROOT, 'packages/cli/bin/wxa-runner.js');
const ready = hasToolchain() && fs.existsSync(path.join(REPO_ROOT, 'packages/core/dist/runtime/host.js'));

/** 编程助手会设置的环境变量（见 @vercel/detect-agent）：测试本身可能就跑在编程助手里，先去掉 */
const AGENT_ENV = /^(AI_AGENT|CLAUDECODE|CLAUDE_CODE|CODEX_|CURSOR_|GEMINI_CLI|OPENCODE|AUGMENT_AGENT|ANTIGRAVITY_AGENT|REPL_ID|COPILOT_)/;

const running: ChildProcess[] = [];

/** 启动 dev，返回启动信息（打印到基础库那一行为止） */
function startDev(args: string[], env: Record<string, string> = {}): Promise<string> {
  const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !AGENT_ENV.test(key)));
  const child = spawn(process.execPath, [CLI, 'dev', path.join(EXAMPLES, 'showcase'), '--no-watch', '--port', '0', ...args], {
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
