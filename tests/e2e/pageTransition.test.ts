import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eReady, expectText, Runner, startRunner } from './runner';

const project = {
  'app.json': { pages: ['pages/index/index', 'pages/detail/detail', 'pages/input/input'] },
  'pages/index/index.js': 'Page({ open() { wx.navigateTo({ url: "/pages/detail/detail" }); } });',
  'pages/index/index.wxml': '<button id="open" bindtap="open">Open detail</button>',
  'pages/detail/detail.js': 'Page({ data: { count: 0 }, increment() { this.setData({ count: this.data.count + 1 }); } });',
  'pages/detail/detail.wxml': '<button id="increment" style="pointer-events: auto !important" bindtap="increment">Increment</button><view id="count">{{count}}</view>',
  'pages/input/input.js': 'Page({ data: { autoFocus: true, value: "" }, update(event) { this.setData({ value: event.detail.value }); } });',
  'pages/input/input.wxml': '<input focus="{{autoFocus}}" bindinput="update"/><view id="value">{{value}}</view>'
};

describe.skipIf(!e2eReady)('页面滑动过渡', () => {
  let runner: Runner;

  beforeAll(async () => {
    runner = await startRunner(project, { pageTransition: true });
  });

  afterAll(async () => {
    await runner?.close();
  });

  it('跳转后立即点击新页面，点击在转场结束后送达一次', async () => {
    const { page } = runner;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const home = await runner.open('/');
    await home.locator('#open').click({ timeout: 5000 });
    await page.frameLocator('iframe[data-current]').locator('#increment').click({ timeout: 5000 });
    const { frameName } = (await page.evaluate(() => window.__wxa_test_api__.currentPage()))!;
    await expectText(page.frame({ name: frameName })!, '#count', '1');
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
          const frames = Array.from(viewport.querySelectorAll('iframe'));
          const visible = frames.filter(frame => frame.style.visibility === 'visible');
          const outgoing = visible.find(frame => !frame.hasAttribute('data-current'))!;
          const incoming = visible.find(frame => frame.hasAttribute('data-current'))!;
          records.push({
            path: this.dataset.path,
            current: this.hasAttribute('data-current'),
            frames: frames.length,
            visible: visible.length,
            outgoingInert: outgoing.contentDocument!.documentElement.inert,
            incomingShielded: incoming.contentDocument!.elementFromPoint(8, 8)?.classList.contains('wxa-page-transition-shield'),
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
          homeInteractive: !home.contentDocument!.documentElement.inert &&
            !home.contentDocument!.querySelector('.wxa-page-transition-shield'),
          navigationUnlocked: !navbar.inert && !tabBar.inert
        };
      } finally {
        Element.prototype.animate = animate;
      }
    });

    expect(await navigate()).toEqual({
      records: [
        { path: 'pages/detail/detail', current: true, frames: 2, visible: 2, outgoingInert: true, incomingShielded: true, navigationLocked: true },
        { path: 'pages/detail/detail', current: true, frames: 3, visible: 2, outgoingInert: true, incomingShielded: true, navigationLocked: true },
        { path: 'pages/detail/detail', current: false, frames: 2, visible: 2, outgoingInert: true, incomingShielded: true, navigationLocked: true }
      ],
      remaining: 1,
      restored: true,
      homeInteractive: true,
      navigationUnlocked: true
    });

    await page.emulateMedia({ reducedMotion: 'reduce' });
    expect(await navigate()).toEqual({ records: [], remaining: 1, restored: true, homeInteractive: true, navigationUnlocked: true });
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

  it('转场时页面可以自动聚焦，结束后能直接打字', async () => {
    const { page } = runner;
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await runner.open('/');
    await page.evaluate(async () => {
      const animate = Element.prototype.animate;
      Element.prototype.animate = function (keyframes, options) {
        const animation = animate.call(this, keyframes, options);
        // 路由完成与动画默认时长相近，减速让基础库的自动聚焦明确落在转场内。
        if (this instanceof HTMLIFrameElement && this.dataset.path === 'pages/input/input') {
          animation.updatePlaybackRate(0.5);
        }
        return animation;
      };
      try {
        await window.__wxa_test_api__.navigateTo('/pages/input/input');
      } finally {
        Element.prototype.animate = animate;
      }
    });
    await page.frameLocator('iframe[data-current]').locator('input:focus').waitFor({ timeout: 3000 });
    await page.keyboard.type('hello');
    const { frameName } = (await page.evaluate(() => window.__wxa_test_api__.currentPage()))!;
    await expectText(page.frame({ name: frameName })!, '#value', 'hello');
  });
});
