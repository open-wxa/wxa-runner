import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eReady, Runner, startRunner } from './runner';

const project = {
  'app.json': { pages: ['pages/index/index', 'pages/detail/detail'] },
  'pages/index/index.js': 'Page({});',
  'pages/index/index.wxml': '<view>Home</view>',
  'pages/detail/detail.js': 'Page({});',
  'pages/detail/detail.wxml': '<view>Detail</view>'
};

describe.skipIf(!e2eReady)('页面滑动过渡', () => {
  let runner: Runner;

  beforeAll(async () => {
    runner = await startRunner(project, { pageTransition: true });
  });

  afterAll(async () => {
    await runner?.close();
  });

  it('前进保留原页，多级返回只保留退出页到动画结束，并尊重减少动态效果设置', async () => {
    await runner.open('/');
    const { page } = runner;
    const navigate = () => page.evaluate(async () => {
      const api = window.__wxa_test_api__;
      const viewport = document.querySelector<HTMLElement>('.wxa-pages')!;
      const navbar = document.querySelector<HTMLElement>('.wxa-navbar')!;
      const tabBar = document.querySelector<HTMLElement>('.wxa-tabbar')!;
      const home = viewport.querySelector('iframe')!;
      const records: unknown[] = [];
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (keyframes, options) {
        if (this instanceof HTMLIFrameElement && this.parentElement === viewport) {
          records.push({
            path: this.dataset.path,
            current: this.hasAttribute('data-current'),
            frames: viewport.querySelectorAll('iframe').length,
            visible: Array.from(viewport.querySelectorAll('iframe')).filter(frame => frame.style.visibility === 'visible').length,
            inert: viewport.inert,
            navigationLocked: navbar.inert && tabBar.inert
          });
        }
        return animate.call(this, keyframes, options);
      };
      try {
        await Promise.all([api.navigateTo('/pages/detail/detail?id=1'), api.navigateTo('/pages/detail/detail?id=2')]);
        await api.navigateBack(2);
        return {
          records,
          remaining: viewport.querySelectorAll('iframe').length,
          restored: home.hasAttribute('data-current'),
          inert: viewport.inert,
          navigationUnlocked: !navbar.inert && !tabBar.inert
        };
      } finally {
        Element.prototype.animate = animate;
      }
    });

    expect(await navigate()).toEqual({
      records: [
        { path: 'pages/detail/detail', current: true, frames: 2, visible: 2, inert: true, navigationLocked: true },
        { path: 'pages/detail/detail', current: true, frames: 3, visible: 2, inert: true, navigationLocked: true },
        { path: 'pages/detail/detail', current: false, frames: 2, visible: 2, inert: true, navigationLocked: true }
      ],
      remaining: 1,
      restored: true,
      inert: false,
      navigationUnlocked: true
    });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await navigate()).toEqual({ records: [], remaining: 1, restored: true, inert: false, navigationUnlocked: true });
  });

  it('连点返回按钮只退出一页，转场后仍能再次返回', async () => {
    const { page } = runner;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await runner.open('/');
    await page.evaluate(async () => {
      const api = window.__wxa_test_api__;
      await api.navigateTo('/pages/detail/detail?id=1');
      await api.navigateTo('/pages/detail/detail?id=2');
    });
    const back = page.getByRole('button', { name: '返回', exact: true });
    await back.dblclick();
    const stack = await page.evaluate(async () => {
      await (window as any).__wxaHost.enqueueRoute(async () => undefined);
      return window.__wxa_test_api__.pageStack().map(entry => entry.query.id);
    });
    expect(stack).toEqual([undefined, '1']);

    await back.click();
    await page.waitForFunction(() => window.__wxa_test_api__.pageStack().length === 1);
  });
});
