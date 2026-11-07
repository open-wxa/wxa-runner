/**
 * 基础库脚本的浏览器运行时兼容补丁（见 packages/core/src/server/baselibCompat.ts）
 */

import { describe, expect, it } from 'vitest';
import { patchBaseLibScript } from '../../packages/core/src/server/baselibCompat';

const FATAL = 'if(!Get)throw new Error("Fatal: unexpected loadSdkSubPackage case");';

describe('baselibCompat', () => {
  it('把 loadSdkSubPackage 的 Fatal 换成提示并返回 undefined', () => {
    const code = `var Zet=(e,t)=>{var r=t.globalName;if(2===P.isEmptyContext){${FATAL}return void console.warn("modal")}`;
    const patched = patchBaseLibScript(code);
    expect(patched).not.toContain('throw new Error("Fatal: unexpected loadSdkSubPackage case")');
    expect(patched).toContain('return void console.warn("[wxa-runner]');
    // 行数不变，DevTools 的报错行号才能对上
    expect(patched.split('\n').length).toBe(code.split('\n').length);
  });

  it('没有这段代码的脚本原样下发', () => {
    const code = 'console.log("WAWebview.js");';
    expect(patchBaseLibScript(code)).toBe(code);
  });

  it('重复应用是幂等的', () => {
    const code = `var a=1;${FATAL}`;
    expect(patchBaseLibScript(patchBaseLibScript(code))).toBe(patchBaseLibScript(code));
  });
});
