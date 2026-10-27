/**
 * 机型预设：开发服务器的 device 选项可以写预设名，也可以在默认机型上改个别字段
 */

import { describe, expect, it } from 'vitest';
import { DEVICE_PRESETS, resolveDevice } from '../../packages/core/src/server/devices';

describe('机型预设', () => {
  it('不指定时模拟 iPhone X', () => {
    expect(resolveDevice(undefined)).toEqual(DEVICE_PRESETS.ios);
    expect(DEVICE_PRESETS.ios).toMatchObject({ brand: 'iPhone', model: 'iPhone X', platform: 'ios', statusBarHeight: 44, safeAreaBottom: 34, cutout: 'notch' });
  });

  it('按预设名选 Android、鸿蒙：尺寸与开发者工具模拟时一致，底部没有 iPhone 的安全区', () => {
    const size = { screenWidth: 375, screenHeight: 812, pixelRatio: 3, statusBarHeight: 47, safeAreaBottom: 0 };
    expect(resolveDevice('android')).toMatchObject({ ...size, platform: 'android', system: expect.stringMatching(/^Android /), cutout: 'punch-hole' });
    expect(resolveDevice('harmony')).toMatchObject({ ...size, platform: 'ohos', system: expect.stringMatching(/^HarmonyOS /), cutout: 'punch-hole' });
  });

  it('给出字段时在默认机型上覆盖', () => {
    expect(resolveDevice({ screenWidth: 414 })).toEqual({ ...DEVICE_PRESETS.ios, screenWidth: 414 });
  });

  it('自定义机型没写 cutout 时按状态栏和平台推断：传统机型没有开口，全面屏 iPhone 是刘海，其他是挖孔', () => {
    expect(resolveDevice({ model: 'iPhone 8', statusBarHeight: 20, safeAreaBottom: 0 }).cutout).toBe('none');
    expect(resolveDevice({ platform: 'android', brand: 'OPPO' }).cutout).toBe('punch-hole');
    expect(resolveDevice({ statusBarHeight: 20, cutout: 'notch' }).cutout).toBe('notch');
  });

  it('不认识的预设名报错并列出可选的', () => {
    expect(() => resolveDevice('pixel' as never)).toThrow(/未知机型 pixel[\s\S]*ios、android、harmony/);
  });
});
