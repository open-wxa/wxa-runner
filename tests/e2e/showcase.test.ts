/**
 * 端到端：在真实浏览器里用官方基础库运行 examples/showcase
 *
 * 需要本机安装微信开发者工具，以及 Chrome（或通过 WXA_CHROME 指定浏览器路径）。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { Browser, chromium, Frame, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DevServer } from '../../packages/core/src/server/DevServer';
import { EXAMPLES, REPO_ROOT } from '../helpers';
import { CHROME, chromeLaunchOptions, e2eReady } from './runner';

const RUNTIME_DIR = path.join(REPO_ROOT, 'packages/core/dist/runtime');

describe.skipIf(!e2eReady)('showcase 示例', () => {
  let server: DevServer;
  let browser: Browser;
  let page: Page;
  let base = '';

  const currentFrame = async (): Promise<Frame> => {
    const { frameName } = (await page.evaluate(() => window.__wxa_test_api__.currentPage()))!;
    return page.frame({ name: frameName })!;
  };
  // 跨跳转始终指向当前页，不用在每次跳转后重新取 frame
  const current = () => page.frameLocator('iframe[data-current]');
  const waitForPage = (pagePath: string) =>
    page.evaluate(p => window.__wxa_test_api__.waitForPage(p), pagePath);
  const open = async (url = '/') => {
    await page.goto(base + url);
    await page.waitForFunction(() => window.__wxa_test_api__);
    await page.evaluate(() => window.__wxa_test_api__.ready);
    return currentFrame();
  };

  beforeAll(async () => {
    server = new DevServer({
      projectPath: path.join(EXAMPLES, 'showcase'),
      port: 0,
      watch: false,
      runtimeDir: RUNTIME_DIR,
      logger: { log: () => undefined, warn: () => undefined, error: () => undefined }
    });
    base = await server.start();
    browser = await chromium.launch(chromeLaunchOptions);
    page = await browser.newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('首页由官方基础库渲染：数据绑定、wxs、列表与条件渲染、rpx', async () => {
    const frame = await open();
    // text 组件读看得见的文字：3.3.x 及更早版本在隐藏的 span 里另存一份，textContent 会读到两遍
    expect(await frame.innerText('#greeting')).toBe('Hello from the official base library');
    expect(await frame.textContent('#price')).toBe('价格：¥123.45');
    expect(await frame.locator('.item').count()).toBe(3);
    expect(await frame.textContent('#many')).toBe('共 3 项');
    // 24rpx 在 375 宽的设备上是 12px
    expect(await frame.evaluate(() => getComputedStyle(document.querySelector('.card')!).padding)).toBe('12px');
    expect(await page.textContent('.wxa-navbar-title')).toBe('首页');
  });

  it('自定义组件：点击组件内按钮一次，组件和父页面各更新一次', async () => {
    const frame = await open();
    await frame.click('wx-counter wx-button');
    await frame.waitForFunction(() => document.querySelector('#parent-count')!.textContent === '父页面收到：2');
    expect(await frame.innerText('wx-counter .counter--label')).toBe('组件计数: 2');
  });

  it('showToast 与 showModal 由宿主渲染，modal 的结果回传给页面', async () => {
    const frame = await open();
    await frame.click('#btn-toast');
    await expect(page.textContent('.wxa-toast-title')).resolves.toBe('你好');

    await frame.click('#btn-modal');
    await page.click('.wxa-modal-cancel');
    await frame.waitForFunction(() => document.querySelector('#modal-result')!.textContent === 'cancel');
  });

  it('wx.request 经代理发出，mock 后返回指定数据', async () => {
    const frame = await open();
    await page.evaluate(() => window.__wxa_test_api__.mock('createRequestTask', (_args: unknown, ctx: any) => {
      // mock 的是原生层，结果仍要按协议通过事件回传
      setTimeout(() => (window as any).__wxaHost.emitToService('onRequestTaskStateChange', {
        requestTaskId: 'm1', state: 'success', data: '{"ok":true}', statusCode: 201, header: {}
      }));
      return { requestTaskId: 'm1', errMsg: `${ctx.api}:ok` };
    }));
    await frame.click('#btn-request');
    await frame.waitForFunction(() => document.querySelector('#request-result')!.textContent === 'status 201');
    await page.evaluate(() => window.__wxa_test_api__.unmock('createRequestTask'));
  });

  it('navigateTo 带参数打开新页面，navigateBack 回到原页面且状态保留', async () => {
    await open();
    await current().locator('wx-counter wx-button').click();
    await current().locator('#btn-detail').click();
    const detail = await waitForPage('pages/detail/detail');
    expect(detail.query).toEqual({ id: '42' });

    expect(await current().locator('#detail-id').textContent()).toBe('id = 42');
    expect(await page.isVisible('.wxa-navbar-back')).toBe(true);
    expect(await page.isVisible('.wxa-tabbar')).toBe(false);
    expect(page.url()).toContain('path=pages%2Fdetail%2Fdetail&id=42');

    await current().locator('#btn-back').click();
    await waitForPage('pages/index/index');
    expect(await current().locator('#parent-count').textContent()).toBe('父页面收到：2');
    expect(await page.evaluate(() => window.__wxa_test_api__.pageStack().length)).toBe(1);
  });

  it('tabBar 切换页面，切回时页面实例保留', async () => {
    await open();
    await current().locator('wx-counter wx-button').click();
    await page.click('.wxa-tabbar-item[data-page-path="pages/mine/mine"]');
    await waitForPage('pages/mine/mine');
    expect(await current().locator('#mine-visits').textContent()).toMatch(/首页访问次数：\d+/);

    await page.click('.wxa-tabbar-item[data-page-path="pages/index/index"]');
    await waitForPage('pages/index/index');
    expect(await current().locator('#parent-count').textContent()).toBe('父页面收到：2');
  });

  it('env(safe-area-inset-*) 按页面窗口取值：贴着屏幕底边的页面才有底部安全区', async () => {
    const padding = (selector: string, side: 'Top' | 'Bottom') =>
      current().locator(selector).evaluate((el, prop) => getComputedStyle(el)[prop as 'paddingTop'], 'padding' + side);

    // tabBar 页面的窗口止于 tabBar 上方
    await open();
    expect(await padding('#index-safe-bottom', 'Bottom')).toBe('0px');

    // 非 tabBar 页面延伸到屏幕底部；默认导航栏下窗口不碰状态栏，顶部为 0 而不是 fallback
    await open('/?path=pages/detail/detail&id=1');
    expect(await padding('#detail-footer', 'Bottom')).toBe('34px');
    expect(await padding('#detail-inline', 'Bottom')).toBe('34px');
    expect(await padding('#detail-inline', 'Top')).toBe('0px');
  });

  it('wx.hideTabBar 隐藏原生 tabBar，页面窗口延伸到屏幕底边，切换 tab 后仍隐藏，wx.showTabBar 恢复', async () => {
    const frameHeight = async () => (await page.locator('iframe[data-current]').boundingBox())!.height;
    const safeBottom = () => current().locator('#index-safe-bottom').evaluate(el => getComputedStyle(el).paddingBottom);
    const tabBarVisible = () => page.isVisible('.wxa-tabbar');

    await open('/?path=pages/lab/lab');
    // iPhone X：状态栏 44 + 导航栏 44，tabBar 50 + 底部安全区 34
    expect(await frameHeight()).toBe(812 - 88 - 84);

    await page.evaluate(() => window.__wxa_test_api__.callPageMethod('hideTabBar'));
    expect(await tabBarVisible()).toBe(false);
    expect(await frameHeight()).toBe(812 - 88);

    await page.evaluate(() => window.__wxa_test_api__.switchTab('/pages/index/index'));
    expect(await tabBarVisible()).toBe(false);
    expect(await safeBottom()).toBe('34px');

    await page.evaluate(() => window.__wxa_test_api__.switchTab('/pages/lab/lab'));
    await page.evaluate(() => window.__wxa_test_api__.callPageMethod('showTabBar'));
    expect(await tabBarVisible()).toBe(true);
    expect(await frameHeight()).toBe(812 - 88 - 84);
    await page.evaluate(() => window.__wxa_test_api__.switchTab('/pages/index/index'));
    expect(await safeBottom()).toBe('0px');
  });

  it('tabBar 徽标、红点、样式和文字可以动态修改', async () => {
    const item = (pagePath: string) => page.locator(`.wxa-tabbar-item[data-page-path="${pagePath}"]`);
    const badge = item('pages/mine/mine').locator('.wxa-tabbar-badge');
    const dot = item('pages/index/index').locator('.wxa-tabbar-dot');
    // 基础库的 tabBar 接口是异步的，调用页面方法后要等界面和日志更新
    const callLab = (method: string) => page.evaluate(m => window.__wxa_test_api__.callPageMethod(m), method);
    const waitForLog = (text: string) => page.waitForFunction(
      t => (window.__wxa_test_api__.pageData()!.logs as Array<{ text: string }>).some(log => log.text.includes(t)),
      text
    );

    await open('/?path=pages/lab/lab');
    await callLab('setBadge');
    await waitForLog('setTabBarBadge:ok');
    expect(await badge.textContent()).toBe('9');
    await callLab('showRedDot');
    await waitForLog('showTabBarRedDot:ok');
    expect(await dot.count()).toBe(1);

    // 切换页面后标记仍在，选中态照常切换
    await page.click('.wxa-tabbar-item[data-page-path="pages/mine/mine"]');
    await waitForPage('pages/mine/mine');
    expect(await badge.textContent()).toBe('9');
    expect(await item('pages/mine/mine').getAttribute('class')).toContain('is-selected');
    await page.evaluate(() => window.__wxa_test_api__.switchTab('/pages/lab/lab'));

    await callLab('removeBadge');
    await waitForLog('removeTabBarBadge:ok');
    await callLab('hideRedDot');
    await waitForLog('hideTabBarRedDot:ok');
    expect(await badge.count()).toBe(0);
    expect(await dot.count()).toBe(0);

    await callLab('toggleStyle');
    await waitForLog('setTabBarStyle:ok');
    expect(await page.locator('.wxa-tabbar').evaluate(el => getComputedStyle(el).backgroundColor)).toBe('rgb(30, 30, 30)');
    expect(await item('pages/lab/lab').evaluate(el => getComputedStyle(el).color)).toBe('rgb(255, 214, 102)');
    expect(await item('pages/mine/mine').evaluate(el => getComputedStyle(el).color)).toBe('rgb(187, 187, 187)');

    await callLab('toggleItem');
    await waitForLog('setTabBarItem:ok');
    expect(await item('pages/lab/lab').textContent()).toBe('改过的');
  });

  it('自动化环境默认按 1:1 显示手机，截图即真实尺寸', async () => {
    await open();
    expect((await page.locator('.wxa-device').boundingBox())!.height).toBe(812);
    expect(await page.textContent('.wxa-scale')).toBe('100%');
  });

  it('选择适应窗口后，放不下时整体缩小手机，页面内的尺寸与交互不受影响', async () => {
    const small = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await small.addInitScript(() => localStorage.setItem('wxa-runner:scale', 'fit'));
      await small.goto(base + '/');
      await small.waitForFunction(() => window.__wxa_test_api__);
      await small.evaluate(() => window.__wxa_test_api__.ready);

      const device = (await small.locator('.wxa-device').boundingBox())!;
      const toolbar = (await small.locator('.wxa-toolbar').boundingBox())!;
      expect(device.height).toBeLessThan(812);
      expect(toolbar.y + toolbar.height).toBeLessThanOrEqual(720);
      expect(await small.textContent('.wxa-scale')).toBe(`${Math.round(device.height / 812 * 100)}%`);

      const current = small.frameLocator('iframe[data-current]');
      expect(await current.locator('.card').first().evaluate(el => [getComputedStyle(el).padding, window.innerWidth]))
        .toEqual(['12px', 375]);
      const label = current.locator('wx-counter .counter--label');
      const count = Number((await label.textContent())!.match(/\d+/)![0]);
      await current.locator('wx-counter wx-button').click();
      await label.filter({ hasText: `组件计数: ${count + 1}` }).waitFor();

      // 切回实际大小，选择会被记住
      await small.click('.wxa-scale');
      expect((await small.locator('.wxa-device').boundingBox())!.height).toBe(812);
      expect(await small.textContent('.wxa-scale')).toBe('100%');
      expect(await small.evaluate(() => localStorage.getItem('wxa-runner:scale'))).toBe('1');
    } finally {
      await small.close();
    }
  });

  it('页面和滚动容器不显示滚动条，也不占用页面宽度（与真机的浮层滚动条一致）', async () => {
    // Playwright 默认用 --hide-scrollbars 启动，这里去掉它，按普通浏览器的行为验证
    const plain = await chromium.launch({ ...chromeLaunchOptions, ignoreDefaultArgs: ['--hide-scrollbars'] });
    try {
      const tab = await plain.newPage();
      await tab.goto(base + '/?path=pages/detail/detail&id=1');
      await tab.waitForFunction(() => window.__wxa_test_api__);
      await tab.evaluate(() => window.__wxa_test_api__.ready);
      const widths = await tab.frameLocator('iframe[data-current]').locator('body').evaluate(body => {
        // 自定义滚动条在任何系统上都会占宽度，用它模拟接鼠标时的常规滚动条
        const style = document.createElement('style');
        style.textContent = '::-webkit-scrollbar { width: 8px; background: #eee; }';
        document.head.appendChild(style);
        const box = document.createElement('div');
        box.style.cssText = 'height: 100px; overflow: auto';
        box.innerHTML = '<div style="height: 500px"></div>';
        const tall = document.createElement('div');
        tall.style.height = '3000px';
        body.append(box, tall);
        return { page: document.documentElement.clientWidth, box: box.offsetWidth - box.clientWidth };
      });
      expect(widths).toEqual({ page: 375, box: 0 });
    } finally {
      await plain.close();
    }
  });

  it('用鼠标横向拖动 swiper 能翻页，按下后先抖出的 1px 竖向位移不会让拖动被当成竖向滑动', async () => {
    const frame = await open('/?path=pages/gesture/gesture');
    const swiper = frame.locator('wx-swiper');
    await swiper.scrollIntoViewIfNeeded();
    const box = (await swiper.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x + 75, y);
    await page.mouse.down();
    await page.mouse.move(x + 75, y + 1);
    await page.mouse.move(x - 75, y + 1, { steps: 10 });
    await page.mouse.up();
    await vi.waitFor(async () => {
      const logs = await page.evaluate(() => (window.__wxa_test_api__.pageData()!.logs as { text: string }[]).map(line => line.text));
      expect(logs).toContainEqual(expect.stringContaining('change {"current":1,'));
    });
  });

  it('用鼠标拖动 movable-view 不到 8px 就松手，这段小位移也会生效', async () => {
    const frame = await open('/?path=pages/gesture/gesture');
    const movable = frame.locator('wx-movable-view');
    await movable.scrollIntoViewIfNeeded();
    const box = (await movable.boundingBox())!;
    const x = box.x + box.width / 2;
    const y = box.y + box.height / 2;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 5, y, { steps: 5 });
    await page.mouse.up();
    await vi.waitFor(async () => {
      const { move } = (await page.evaluate(() => window.__wxa_test_api__.pageData()))!;
      expect(move).toMatch(/^x=5 y=0 /);
    });
  });

  it('通过 ?path= 直接打开指定页面，Storage 可以从测试中读取', async () => {
    const frame = await open('/?path=pages/detail/detail&id=7');
    expect(await frame.textContent('#detail-id')).toBe('id = 7');
    expect(await page.evaluate(() => typeof window.__wxa_test_api__.getStorage('showcase:visits'))).toBe('number');
  });

  it('默认字号固定为 16px，不受浏览器字号设置影响', async () => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-chrome-'));
    fs.mkdirSync(path.join(profile, 'Default'));
    fs.writeFileSync(path.join(profile, 'Default/Preferences'), JSON.stringify({ webkit: { webprefs: { default_font_size: 20 } } }));
    // 用不了 chromeLaunchOptions，见它的注释
    const context = await chromium.launchPersistentContext(profile, { executablePath: CHROME });
    try {
      const tab = await context.newPage();
      await tab.goto(base + '/');
      await tab.waitForFunction(() => window.__wxa_test_api__);
      await tab.evaluate(() => window.__wxa_test_api__.ready);
      const { frameName } = (await tab.evaluate(() => window.__wxa_test_api__.currentPage()))!;
      const frame = tab.frame({ name: frameName })!;
      expect(await frame.evaluate(() => getComputedStyle(document.documentElement).fontSize)).toBe('16px');
    } finally {
      await context.close();
    }
  });

  it('整个过程中逻辑层和渲染层没有未捕获的错误', async () => {
    expect(await page.evaluate(() => window.__wxa_test_api__.errors())).toEqual([]);
  });
});
