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
            inert: viewport.inert
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
          inert: viewport.inert
        };
      } finally {
        Element.prototype.animate = animate;
      }
    });

    expect(await navigate()).toEqual({
      records: [
        { path: 'pages/detail/detail', current: true, frames: 2, visible: 2, inert: true },
        { path: 'pages/detail/detail', current: true, frames: 3, visible: 2, inert: true },
        { path: 'pages/detail/detail', current: false, frames: 2, visible: 2, inert: true }
      ],
      remaining: 1,
      restored: true,
      inert: false
    });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await navigate()).toEqual({ records: [], remaining: 1, restored: true, inert: false });
  });
});
