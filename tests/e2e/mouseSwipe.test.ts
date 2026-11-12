import type { Frame, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { e2eReady, Runner, startRunner } from './runner';

const project = {
  'app.json': { pages: ['pages/index/index'] },
  'pages/index/index.wxml': `
    <view bindtouchend="ended">
      <view id="ended">{{ended}}</view>
      <scroll-view id="hscroll" scroll-x style="width:300px;height:80px;white-space:nowrap">
        <view wx:for="{{items}}" wx:key="*this" style="display:inline-block;width:120px;height:200px">{{item}}</view>
      </scroll-view>
      <scroll-view id="vscroll" scroll-y style="width:300px;height:120px">
        <view wx:for="{{items}}" wx:key="*this" style="height:60px">{{item}}</view>
      </scroll-view>
      <view id="box" bindtouchstart="start" bindtouchmove="move" style="width:300px;height:80px;background:#06c270">{{offset}}</view>
      <scroll-view id="caughtMove" scroll-x style="width:300px;height:80px;white-space:nowrap">
        <view catchtouchmove="noop" style="display:inline-block;width:900px;height:80px">catchtouchmove</view>
      </scroll-view>
      <scroll-view id="caughtStart" scroll-x style="width:300px;height:80px;white-space:nowrap">
        <view catchtouchstart="noop" style="display:inline-block;width:900px;height:80px">catchtouchstart</view>
      </scroll-view>
      <scroll-view id="paging" enhanced paging-enabled scroll-y style="width:300px;height:100px">
        <view wx:for="{{[1,2,3,4,5]}}" wx:key="*this" style="height:100px">{{item}}</view>
      </scroll-view>
      <scroll-view id="refresher" refresher-enabled scroll-y bindrefresherrefresh="refresh" style="width:300px;height:200px">
        <view style="height:1000px">{{refreshes}}</view>
      </scroll-view>
      <swiper id="swiper" style="width:300px;height:150px">
        <swiper-item><scroll-view id="inSwiper" scroll-y style="height:150px"><view style="height:600px">0</view></scroll-view></swiper-item>
        <swiper-item><view>1</view></swiper-item>
      </swiper>
      <scroll-view id="picture" scroll-x style="width:300px;height:80px">
        <rich-text nodes="{{html}}"></rich-text>
      </scroll-view>
      <view style="height:2000px">tall</view>
    </view>
  `,
  'pages/index/index.js': `
    Page({
      data: {
        items: ['a','b','c','d','e','f','g','h'],
        offset: 0,
        ended: 0,
        refreshes: 0,
        html: '<img src="/pixel.gif" style="width:900px;height:80px">'
      },
      start(e) { this.x0 = e.touches[0].clientX; },
      move(e) { this.setData({ offset: Math.round(e.touches[0].clientX - this.x0) }); },
      ended() { this.setData({ ended: this.data.ended + 1 }); },
      refresh() { this.setData({ refreshes: this.data.refreshes + 1 }); },
      noop() {}
    });
  `
};

/** 只发出鼠标事件，不等转换出的触摸派发完；要断言滚动结果先 waitTouchEnds */
async function drag(page: Page, frame: Frame, selector: string, dx: number, dy: number) {
  const box = (await frame.locator(selector).boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + dx, y + dy, { steps: 10 });
  await page.mouse.up();
}

/** 鼠标事件转成的触摸是排队异步派发的，等到第 count 个 touchend 派发完，这之前的滚动都已应用 */
async function waitTouchEnds(frame: Frame, count: number) {
  await vi.waitFor(async () => expect(Number(await frame.textContent('#ended'))).toBeGreaterThanOrEqual(count));
}

/** scroll-view 内部真正滚动的是哪个元素因基础库版本而异，取子树里最大的滚动量 */
function scrolled(frame: Frame, selector: string) {
  return frame.locator(selector).evaluate(el => {
    const all = [el, ...Array.from(el.querySelectorAll('*'))];
    return { left: Math.max(...all.map(node => node.scrollLeft)), top: Math.max(...all.map(node => node.scrollTop)) };
  });
}

const pageScrollTop = (frame: Frame) => frame.evaluate(() => document.scrollingElement!.scrollTop);

describe.skipIf(!e2eReady)('鼠标拖动模拟手指滑动', () => {
  let runner: Runner;
  beforeAll(async () => {
    runner = await startRunner({
      ...project,
      'pixel.gif': Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    });
  });
  afterAll(() => runner?.close());

  async function swipe(selector: string, dx: number, dy: number) {
    const frame = await runner.open('/');
    await frame.locator(selector).scrollIntoViewIfNeeded();
    const before = await pageScrollTop(frame);
    await drag(runner.page, frame, selector, dx, dy);
    await waitTouchEnds(frame, 1);
    return { frame, before };
  }

  it('只监听 touchmove 的元素收到带位移的触摸', async () => {
    const { frame } = await swipe('#box', -100, 0);
    expect(await frame.textContent('#box')).toBe('-100');
  });

  it('横向拖动 scroll-view 会滚动', async () => {
    const { frame } = await swipe('#hscroll', -150, 0);
    expect((await scrolled(frame, '#hscroll')).left).toBeGreaterThan(100);
  });

  it('纵向拖动 scroll-view 会滚动', async () => {
    const { frame } = await swipe('#vscroll', 0, -100);
    expect((await scrolled(frame, '#vscroll')).top).toBeGreaterThan(60);
  });

  it('斜向拖动只开了 scroll-x 的 scroll-view，纵向不跟着滚', async () => {
    const { frame } = await swipe('#hscroll', -100, -40);
    expect(await scrolled(frame, '#hscroll')).toMatchObject({ left: expect.any(Number), top: 0 });
    expect((await scrolled(frame, '#hscroll')).left).toBeGreaterThan(60);
  });

  it('纵向拖动横向 scroll-view 时滚动的是页面', async () => {
    const { frame, before } = await swipe('#hscroll', 0, -100);
    expect(await pageScrollTop(frame) - before).toBeGreaterThan(60);
    expect((await scrolled(frame, '#hscroll')).left).toBe(0);
  });

  it('内层 scroll-view 已经到底时，继续上拉滚动的是页面', async () => {
    const frame = await runner.open('/');
    await frame.locator('#vscroll').evaluate(el => {
      for (const node of [el, ...Array.from(el.querySelectorAll('*'))]) node.scrollTop = node.scrollHeight;
    });
    const before = await scrolled(frame, '#vscroll');
    const pageBefore = await pageScrollTop(frame);
    await drag(runner.page, frame, '#vscroll', 0, -100);
    await waitTouchEnds(frame, 1);
    expect(await pageScrollTop(frame) - pageBefore).toBeGreaterThan(60);
    expect(await scrolled(frame, '#vscroll')).toEqual(before);
  });

  it.each(['#caughtMove', '#caughtStart'])('%s 区域拖不动外层 scroll-view', async selector => {
    const { frame } = await swipe(selector, -150, 0);
    expect((await scrolled(frame, selector)).left).toBe(0);
  });

  it('paging-enabled 的 scroll-view 拖一小段，松手后对齐到下一页而不是翻到底', async () => {
    const { frame } = await swipe('#paging', 0, -70);
    await vi.waitFor(async () => expect((await scrolled(frame, '#paging')).top).toBe(100));
  });

  it('refresher-enabled 的 scroll-view 在顶部下拉超过阈值会触发刷新', async () => {
    const { frame } = await swipe('#refresher', 0, 200);
    await vi.waitFor(async () => expect(await frame.textContent('#refresher')).toBe('1'));
  });

  it('swiper 里的 scroll-view 竖拉会滚动', async () => {
    const { frame } = await swipe('#swiper', 0, -80);
    expect((await scrolled(frame, '#inSwiper')).top).toBeGreaterThan(40);
  });

  it('从图片上开始拖动也能滑完，不会变成浏览器的拖放', async () => {
    const { frame } = await swipe('#picture', -150, 0);
    expect((await scrolled(frame, '#picture')).left).toBeGreaterThan(100);
  });

  it('上一次拖动还没派发完就开始下一次，两次各自滚动自己的元素', async () => {
    const frame = await runner.open('/');
    // 在页面里同步发出两次拖动的鼠标事件，保证第二次按下时第一次的触摸还在队列里
    await frame.evaluate(() => {
      const drag = (selector: string, dx: number, dy: number) => {
        const box = document.querySelector(selector)!.getBoundingClientRect();
        const x = box.left + box.width / 2;
        const y = box.top + box.height / 2;
        // 和真实鼠标一样，事件目标是光标下最内层的元素
        const target = document.elementFromPoint(x, y)!;
        const fire = (type: string, i: number) => target.dispatchEvent(new MouseEvent(type, {
          bubbles: true, button: 0, clientX: x + dx * i / 10, clientY: y + dy * i / 10
        }));
        fire('mousedown', 0);
        for (let i = 1; i <= 10; i++) fire('mousemove', i);
        fire('mouseup', 10);
      };
      drag('#hscroll', -100, 0);
      drag('#vscroll', 0, -70);
    });
    await waitTouchEnds(frame, 2);
    expect(await scrolled(frame, '#hscroll')).toMatchObject({ top: 0 });
    expect((await scrolled(frame, '#hscroll')).left).toBeGreaterThan(60);
    expect(await scrolled(frame, '#vscroll')).toMatchObject({ left: 0 });
    expect((await scrolled(frame, '#vscroll')).top).toBeGreaterThan(40);
  });
});
