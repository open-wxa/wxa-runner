/**
 * 伴生 SDK 子包能力的占位实现
 */

import { describe, expect, it, vi } from 'vitest';
import { guardSdkGlobals, installApiStubs, UNSUPPORTED_AD_APIS } from '../../packages/core/src/runtime/sdkStubs';

const install = () => {
  const warnings: string[] = [];
  // 基础库把这些接口定义成惰性 getter，缺子包时返回 undefined
  const wx: Record<string, any> = {};
  for (const name of UNSUPPORTED_AD_APIS) {
    Object.defineProperty(wx, name, { get: () => () => undefined, configurable: true });
  }
  const replaced = installApiStubs(wx, { warn: message => warnings.push(message) });
  return { wx, warnings, replaced };
};

describe('广告接口占位', () => {
  it('替换掉基础库返回 undefined 的那几个接口', () => {
    const { wx, replaced } = install();
    expect(replaced).toEqual([...UNSUPPORTED_AD_APIS]);
    for (const name of UNSUPPORTED_AD_APIS) expect(wx[name]()).toBeTruthy();
  });

  it('用到了才提示，并且只提示一次', () => {
    const { wx, warnings } = install();
    expect(warnings).toEqual([]);

    wx.createRewardedVideoAd({ adUnitId: 'adunit-x' });
    wx.createInterstitialAd({ adUnitId: 'adunit-y' });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('广告');
  });

  it('激励视频接口齐全，load / show 失败并先回调 onError', async () => {
    const { wx } = install();
    const ad = wx.createRewardedVideoAd({ adUnitId: 'adunit-x' });
    for (const method of ['load', 'show', 'destroy', 'onLoad', 'offLoad', 'onError', 'offError', 'onClose', 'offClose']) {
      expect(typeof ad[method]).toBe('function');
    }

    const onError = vi.fn();
    ad.onError(onError);
    await expect(ad.load()).rejects.toMatchObject({ errCode: 1000 });
    await expect(ad.show()).rejects.toMatchObject({ errMsg: expect.stringContaining('不支持') });
    expect(onError).toHaveBeenCalledTimes(2);
    expect(onError.mock.calls[0][0]).toMatchObject({ errCode: 1000, errMsg: expect.any(String) });
  });

  it('offError 之后不再回调，destroy 清掉监听', async () => {
    const { wx } = install();
    const ad = wx.createRewardedVideoAd({});
    const onError = vi.fn();

    ad.onError(onError);
    ad.offError(onError);
    await expect(ad.load()).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();

    ad.onError(onError);
    ad.destroy();
    await expect(ad.load()).rejects.toBeTruthy();
    expect(onError).not.toHaveBeenCalled();
  });

  it('只有原生模板广告有 hide / isShow', () => {
    const { wx } = install();
    expect(wx.createCustomAd({}).isShow()).toBe(false);
    expect(wx.createRewardedVideoAd({}).isShow()).toBeUndefined();
  });

  it('没人 catch 的 load 不会变成 unhandledrejection', async () => {
    const { wx } = install();
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);

    wx.createRewardedVideoAd({}).load();
    await new Promise(resolve => setTimeout(resolve, 10));

    process.off('unhandledRejection', onUnhandled);
    expect(onUnhandled).not.toHaveBeenCalled();
  });

  // 每次 require 业务模块前都会调一遍，不能反复换对象、反复提示
  it('幂等：装过就跳过，基础库改回去之后能重新装上', () => {
    const { wx, warnings } = install();
    const stub = wx.createRewardedVideoAd;

    expect(installApiStubs(wx, { warn: m => warnings.push(m) })).toEqual([]);
    expect(wx.createRewardedVideoAd).toBe(stub);

    wx.createRewardedVideoAd({});
    wx.createRewardedVideoAd({});
    expect(warnings).toHaveLength(1);

    // 基础库在交出 wx 之后还会改写它
    wx.createRewardedVideoAd = () => undefined;
    expect(installApiStubs(wx, { warn: () => undefined })).toEqual(['createRewardedVideoAd']);
    expect(wx.createRewardedVideoAd({})).toBeTruthy();
  });

  it('属性不可配置时跳过，不抛错', () => {
    const wx: Record<string, any> = {};
    Object.defineProperty(wx, 'createRewardedVideoAd', { value: () => undefined, configurable: false });

    const replaced = installApiStubs(wx, { warn: () => undefined });
    expect(replaced).not.toContain('createRewardedVideoAd');
    expect(replaced).toContain('createInterstitialAd');
  });
});

describe('伴生 SDK 的懒加载全局', () => {
  /** 模拟基础库执行前后的全局对象：location 是原有的存取器，后面几个是基础库加上的，读取时会触发加载 */
  const setup = () => {
    const loaded: string[] = [];
    const lazy = (name: string, value: () => unknown) => ({
      get: () => {
        loaded.push(name);
        return value();
      },
      configurable: true
    });
    const global: Record<string, any> = {};
    Object.defineProperty(global, 'location', { get: () => 'http://localhost/', configurable: true });
    const before = new Set(Object.getOwnPropertyNames(global));
    Object.defineProperty(global, 'ADSDK', lazy('ADSDK', () => { throw new TypeError("Cannot set properties of undefined (setting 'inject')"); }));
    Object.defineProperty(global, 'MidasSDK', lazy('MidasSDK', () => undefined));
    Object.defineProperty(global, '__cloudSDKMain__', lazy('__cloudSDKMain__', () => ({ getCloudAPI: () => ({}) })));
    Object.defineProperty(global, 'getApp', { get: () => () => undefined, configurable: false });
    global.define = () => undefined;
    return { global, before, loaded };
  };

  it('Taro 那样逐个拷贝全局属性不会中断，也不会触发加载', () => {
    const { global, before, loaded } = setup();
    guardSdkGlobals(global, before);

    const copy: Record<string, unknown> = {};
    expect(() => Object.getOwnPropertyNames(global).forEach(key => { copy[key] = global[key]; })).not.toThrow();
    expect(copy.ADSDK).toBeUndefined();
    expect(copy.MidasSDK).toBeUndefined();
    expect(loaded).toEqual(['__cloudSDKMain__']);
  });

  it('云开发的入口照常读取：wx.cloud 经它取到', () => {
    const { global, before } = setup();
    guardSdkGlobals(global, before);
    expect(typeof global.__cloudSDKMain__.getCloudAPI).toBe('function');
  });

  it('只换掉基础库加上的、可重新定义的存取器，基础库之后回写的值不受影响', () => {
    const { global, before } = setup();
    expect(guardSdkGlobals(global, before).sort()).toEqual(['ADSDK', 'MidasSDK']);
    expect(global.location).toBe('http://localhost/');
    expect(typeof global.getApp).toBe('function');

    Object.defineProperty(global, 'ADSDK', { value: { RewardedVideoAd: class {} }, configurable: true });
    expect(global.ADSDK.RewardedVideoAd).toBeTypeOf('function');
  });
});
