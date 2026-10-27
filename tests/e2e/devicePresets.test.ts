/**
 * e2e：业务代码在各个机型预设下拿到的设备信息
 *
 * 外壳按机型画刘海、挖孔摄像头和 Home Indicator。
 *
 * 基础库按开发者工具运行（__wxConfig.platform 为 devtools），会用 brand 改写 getDeviceInfo / getSystemInfo 的 platform：
 * iPhone 得到 ios，其他品牌得到 android。没有得到 ohos 的分支（截至 3.17.4），所以鸿蒙预设在业务代码里是 android
 */

import { afterEach, describe, expect, it } from 'vitest';
import { e2eReady, expectText, Runner, startRunner } from './runner';

const PROJECT = {
  'app.json': { pages: ['pages/index/index'] },
  'pages/index/index.json': {},
  'pages/index/index.wxml': '<view id="info">{{info}}</view>',
  'pages/index/index.js': `Page({
    data: { info: '' },
    onLoad() {
      const device = wx.getDeviceInfo();
      const system = wx.getSystemInfoSync();
      const { statusBarHeight } = wx.getWindowInfo();
      this.setData({ info: [device.platform, system.platform, device.brand, device.system, statusBarHeight].join('|') });
    }
  });`
};

describe.skipIf(!e2eReady)('机型预设', () => {
  let runner: Runner | undefined;

  afterEach(() => runner?.close());

  it.each([
    [undefined, 'ios|ios|iPhone|iOS 16.0|44', ['notch', 'home-indicator']],
    ['android', /^android\|android\|\S+\|Android [\d.]+\|47$/, ['punch-hole']],
    ['harmony', /^android\|android\|HUAWEI\|HarmonyOS [\d.]+\|47$/, ['punch-hole']]
  ] as const)('device: %s', async (device, expected, parts) => {
    runner = await startRunner(PROJECT, { device });
    await expectText(await runner.open('/'), '#info', expected);
    // 外壳只画这台机器有的部件：刘海和 Home Indicator 是 iPhone 的，安卓、鸿蒙是挖孔摄像头
    const drawn = await runner.page.evaluate(() =>
      ['notch', 'punch-hole', 'home-indicator'].filter(part => document.querySelector(`.wxa-${part}`))
    );
    expect(drawn).toEqual(parts);
  });
});
