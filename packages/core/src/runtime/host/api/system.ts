/**
 * 设备与系统信息：以模拟设备为准，而不是宿主浏览器窗口
 */

import type { DeviceProfile } from '../../types';
import { ApiHandler, ok } from './registry';

export interface SystemApiOptions {
  device: DeviceProfile;
  baseLibVersion: string;
  /** 当前页面可用高度（扣除导航栏、tabBar） */
  windowHeight: () => number;
  /** 当前页面窗口顶部到屏幕顶部的距离，自定义导航栏时为 0 */
  screenTop: () => number;
}

export const NAVIGATION_BAR_HEIGHT = 44;
export const TAB_BAR_HEIGHT = 50;

/** 胶囊按钮位置，外壳绘制和 getMenuButtonBoundingClientRect 共用 */
export function menuButtonRect(device: DeviceProfile) {
  const width = 87;
  const height = 32;
  const top = device.statusBarHeight + 6;
  const right = device.screenWidth - 7;
  return { width, height, top, right, bottom: top + height, left: right - width };
}

export function createSystemApis(options: SystemApiOptions): Record<string, ApiHandler> {
  const { device } = options;

  const windowInfo = () => {
    const safeBottom = device.screenHeight - device.safeAreaBottom;
    return {
      pixelRatio: device.pixelRatio,
      screenWidth: device.screenWidth,
      screenHeight: device.screenHeight,
      windowWidth: device.screenWidth,
      windowHeight: options.windowHeight(),
      windowTop: 0,
      windowBottom: 0,
      statusBarHeight: device.statusBarHeight,
      safeArea: {
        left: 0,
        right: device.screenWidth,
        top: device.statusBarHeight,
        bottom: safeBottom,
        width: device.screenWidth,
        height: safeBottom - device.statusBarHeight
      },
      safeAreaInsets: { top: device.statusBarHeight, left: 0, right: 0, bottom: device.safeAreaBottom },
      screenTop: options.screenTop()
    };
  };

  // abi、deviceAbi、cpuType、benchmarkLevel 官方文档注明仅 Android 支持
  const androidOnly = device.platform === 'android'
    ? { abi: 'arm64-v8a', deviceAbi: 'arm64-v8a', cpuType: 'unknown', benchmarkLevel: 1 }
    : {};
  const deviceInfo = () => ({
    brand: device.brand,
    model: device.model,
    system: device.system,
    platform: device.platform,
    memorySize: '4096',
    ...androidOnly
  });

  const appBaseInfo = () => ({
    SDKVersion: options.baseLibVersion,
    enableDebug: false,
    host: { env: 'WeChat', appId: '' },
    language: 'zh_CN',
    version: '8.0.50',
    theme: 'light',
    fontSizeSetting: 16
  });

  const authorizeSetting = () => ({
    albumAuthorized: 'authorized',
    bluetoothAuthorized: 'authorized',
    cameraAuthorized: 'authorized',
    locationAuthorized: 'authorized',
    locationReducedAccuracy: false,
    microphoneAuthorized: 'authorized',
    notificationAuthorized: 'authorized',
    phoneCalendarAuthorized: 'authorized'
  });

  const systemSetting = () => ({
    bluetoothEnabled: true,
    locationEnabled: true,
    wifiEnabled: true,
    deviceOrientation: 'portrait'
  });

  const systemInfo: ApiHandler = (args, { api }) => {
    switch (args.type) {
      case 'windowInfo': return ok(api, windowInfo());
      case 'deviceInfo': return ok(api, deviceInfo());
      case 'appBaseInfo': return ok(api, appBaseInfo());
      case 'appAuthorizeSetting': return ok(api, authorizeSetting());
      case 'systemSetting': return ok(api, systemSetting());
    }
    return ok(api, {
      ...deviceInfo(),
      ...windowInfo(),
      ...appBaseInfo(),
      ...systemSetting(),
      albumAuthorized: true,
      cameraAuthorized: true,
      locationAuthorized: true,
      microphoneAuthorized: true,
      notificationAuthorized: true
    });
  };

  return {
    getSystemInfo: systemInfo,
    getSystemInfoSync: systemInfo,
    getSystemInfoAsync: systemInfo,
    getWindowInfo: (_args, { api }) => ok(api, windowInfo()),
    getDeviceInfo: (_args, { api }) => ok(api, deviceInfo()),
    getAppBaseInfo: (_args, { api }) => ok(api, appBaseInfo()),
    getAppAuthorizeSetting: (_args, { api }) => ok(api, authorizeSetting()),
    getSystemSetting: (_args, { api }) => ok(api, systemSetting()),
    getNetworkType: (_args, { api }) => ok(api, { networkType: 'wifi', signalStrength: 100, hasSystemProxy: false }),
    getBatteryInfo: (_args, { api }) => ok(api, { level: 100, isCharging: true }),
    getBatteryInfoSync: (_args, { api }) => ok(api, { level: 100, isCharging: true }),
    getMenuButtonBoundingClientRect: (_args, { api }) => ok(api, menuButtonRect(device)),
    getScreenBrightness: (_args, { api }) => ok(api, { value: 0.8 }),
    setScreenBrightness: () => undefined,
    setKeepScreenOn: () => undefined,
    vibrateShort: () => undefined,
    vibrateLong: () => undefined
  };
}
