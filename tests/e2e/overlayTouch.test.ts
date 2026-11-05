import type { CDPSession, Locator } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eReady, Runner, startRunner } from './runner';

const project = {
  'app.json': { pages: ['pages/index/index'] },
  'pages/index/index.wxml': `
    <button id="preview" bindtap="preview">图片预览</button>
    <button id="action" bindtap="action">操作菜单</button>
    <picker range="{{items}}"><view id="picker">选择器</view></picker>
  `,
  'pages/index/index.js': `
    Page({
      data: { items: ['A', 'B'] },
      preview() { wx.previewImage({ urls: ['https://example.com/pixel.gif'] }); },
      action() { wx.showActionSheet({ itemList: ['A'] }); }
    });
  `
};

async function tap(session: CDPSession, locator: Locator, position?: { x: number; y: number }) {
  await locator.scrollIntoViewIfNeeded({ timeout: 3000 });
  const box = await locator.boundingBox({ timeout: 3000 });
  if (!box) throw new Error('触摸目标不可见');
  const { x, y } = position ?? { x: box.width / 2, y: box.height / 2 };
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart', touchPoints: [{ x: Math.round(box.x + x), y: Math.round(box.y + y) }]
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}

describe.skipIf(!e2eReady)('触摸打开原生弹层', () => {
  let runner: Runner;

  beforeAll(async () => {
    runner = await startRunner(project);
    await runner.page.route('https://example.com/pixel.gif', route => route.fulfill({
      contentType: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64')
    }));
  });

  afterAll(() => runner?.close());

  it.each([
    ['图片预览', '#preview', '.wxa-preview', '.wxa-preview'],
    ['操作菜单', '#action', '.wxa-actionsheet', '.wxa-actionsheet-item'],
    ['选择器', '#picker', '.wxa-picker', '.wxa-overlay .wxa-mask']
  ])('%s 保持打开，下一次触摸才关闭', async (_name, trigger, overlay, dismiss) => {
    const { page } = runner;
    const frame = await runner.open('/');
    const session = await page.context().newCDPSession(page);
    try {
      await session.send('Emulation.setTouchEmulationEnabled', { enabled: true });
      await tap(session, frame.locator(trigger));
      const layer = page.locator(overlay);
      await layer.waitFor({ state: 'visible', timeout: 3000 });
      await tap(session, page.locator(dismiss), { x: 32, y: 32 });
      await layer.waitFor({ state: 'detached', timeout: 3000 });
      expect(await page.locator('.wxa-overlay > *').count()).toBe(0);
    } finally {
      await session.detach();
    }
  });
});
