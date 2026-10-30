/**
 * fixture 启动 Chrome 时追加的 V8 参数：让 V8 编译时就记下源码位置，Playwright 连着浏览器时基础库初始化不用重新解析大函数
 */

import { describe, expect, it } from 'vitest';
import { withEagerSourcePositions } from '../../packages/playwright/src/launchOptions';

const FLAG = '--no-enable-lazy-source-positions';

describe('fixture 启动 Chrome 的参数', () => {
  it('开发者没传启动参数时，带上让 V8 编译时就记下源码位置的参数', () => {
    expect(withEagerSourcePositions(undefined)).toEqual([`--js-flags=${FLAG}`]);
  });

  it('开发者自己的启动参数保持不变', () => {
    expect(withEagerSourcePositions(['--lang=zh-CN', '--mute-audio'])).toEqual(['--lang=zh-CN', '--mute-audio', `--js-flags=${FLAG}`]);
  });

  it('开发者已经传了 --js-flags 时，合并成一个 --js-flags，开发者的 V8 参数不会被覆盖', () => {
    const args = withEagerSourcePositions(['--js-flags=--max-old-space-size=4096', '--mute-audio']);

    expect(args.filter(arg => arg.startsWith('--js-flags='))).toEqual([`--js-flags=--max-old-space-size=4096 ${FLAG}`]);
    expect(args).toContain('--mute-audio');
  });

  it('开发者自己指定了 V8 怎么记源码位置时，按开发者的来', () => {
    const args = ['--js-flags=--enable-lazy-source-positions'];

    expect(withEagerSourcePositions(args)).toEqual(args);
  });
});
