/**
 * 扩展合并：选项里直接给出的扩展点在前，各扩展按顺序合并在后面（见 packages/core/src/server/extensions.ts）
 */

import { describe, expect, it } from 'vitest';
import { applyExtensions, DevServerExtension } from '../../packages/core/src/server/extensions';

const CONTEXT = { projectPath: '/proj', root: '/proj' };

describe('applyExtensions', () => {
  it('没有扩展和转换时返回空默认值', () => {
    const merged = applyExtensions({}, [], CONTEXT);
    expect(merged).toEqual({ webviewScripts: [], middlewares: [], wxmlTransform: undefined, jsTransform: undefined, entries: [] });
  });

  it('wxml / js 转换按顺序串起来：直接给的在前，扩展的在后', () => {
    const extension: DevServerExtension = {
      name: 'ext',
      setup: () => ({
        wxmlTransform: (code: string) => `${code}w+`,
        jsTransform: (code: string) => `${code}j+`
      })
    };
    const merged = applyExtensions({ wxmlTransform: code => `${code}w0`, jsTransform: code => `${code}j0` }, [extension], CONTEXT);
    expect(merged.wxmlTransform!('x', 'a.wxml')).toBe('xw0w+');
    expect(merged.jsTransform!('x', 'a.js')).toBe('xj0j+');
  });

  it('只有扩展提供转换时也能生效', () => {
    const merged = applyExtensions({}, [{ name: 'ext', setup: () => ({ jsTransform: (code: string) => `${code}!` }) }], CONTEXT);
    expect(merged.wxmlTransform).toBeUndefined();
    expect(merged.jsTransform!('x', 'a.js')).toBe('x!');
  });

  it('扩展初始化抛错时报出扩展名', () => {
    const broken: DevServerExtension = {
      name: 'broken',
      setup: () => {
        throw new Error('boom');
      }
    };
    expect(() => applyExtensions({}, [broken], CONTEXT)).toThrow('扩展 broken 初始化失败：boom');
  });
});
