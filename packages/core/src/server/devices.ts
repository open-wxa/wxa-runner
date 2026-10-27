/**
 * 模拟的机型：开发服务器的 device 选项、命令行的 --device
 */

import type { DeviceProfile } from '../runtime/types';

/**
 * 尺寸取自开发者工具模拟对应平台时 wx.getWindowInfo 的结果。
 * 安卓、鸿蒙没有 iPhone 的 Home Indicator，底部安全区按真机取 0（开发者工具给的是 34）
 */
export const DEVICE_PRESETS = {
  ios: {
    brand: 'iPhone',
    model: 'iPhone X',
    screenWidth: 375,
    screenHeight: 812,
    pixelRatio: 3,
    statusBarHeight: 44,
    safeAreaBottom: 34,
    cutout: 'notch',
    system: 'iOS 16.0',
    platform: 'ios'
  },
  android: {
    brand: 'Xiaomi',
    model: 'Xiaomi 14',
    screenWidth: 375,
    screenHeight: 812,
    pixelRatio: 3,
    statusBarHeight: 47,
    safeAreaBottom: 0,
    cutout: 'punch-hole',
    system: 'Android 14',
    platform: 'android'
  },
  harmony: {
    brand: 'HUAWEI',
    model: 'Mate 60',
    screenWidth: 375,
    screenHeight: 812,
    pixelRatio: 3,
    statusBarHeight: 47,
    safeAreaBottom: 0,
    cutout: 'punch-hole',
    system: 'HarmonyOS 5.0.0',
    platform: 'ohos'
  }
} satisfies Record<string, DeviceProfile>;

export type DeviceName = keyof typeof DEVICE_PRESETS;

export const DEVICE_NAMES = Object.keys(DEVICE_PRESETS) as DeviceName[];

/**
 * 预设名取对应预设；给出字段时在 iPhone X 上覆盖，没写 cutout 时按状态栏和平台推断
 * （如只改了状态栏高度的 iPhone 8 不该带着 iPhone X 的刘海）；不认识的预设名抛错
 */
export function resolveDevice(device: DeviceName | Partial<DeviceProfile> | undefined): DeviceProfile {
  if (typeof device !== 'string') {
    const merged = { ...DEVICE_PRESETS.ios, ...device };
    return { ...merged, cutout: device?.cutout ?? inferCutout(merged) };
  }
  if (!DEVICE_NAMES.includes(device)) throw new Error(`未知机型 ${device}：可选 ${DEVICE_NAMES.join('、')}`);
  return { ...DEVICE_PRESETS[device] };
}

/** 传统机型的状态栏是 20px，更高的是全面屏 */
function inferCutout({ statusBarHeight, platform }: DeviceProfile): DeviceProfile['cutout'] {
  if (statusBarHeight <= 20) return 'none';
  return platform === 'ios' ? 'notch' : 'punch-hole';
}
