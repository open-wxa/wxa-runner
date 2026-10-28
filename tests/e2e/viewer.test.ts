/**
 * 查看器的端到端流程：wxa-runner viewer pack 打出的包在 preview 里由 Service Worker 渲染，
 * 在查看页面里改环境变量和 setup 后生效，刷新后还在；wx.request 经本机代理到达真实服务器
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { Browser, chromium, Frame, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPack } from '../../packages/viewer/src/pack/createPack';
import { ViewerServer } from '../../packages/viewer/src/server/ViewerServer';
import { createProject, REPO_ROOT } from '../helpers';
import { chromeLaunchOptions, e2eReady, expectText } from './runner';

const RUNTIME_DIR = path.join(REPO_ROOT, 'packages/core/dist/runtime');
const viewerBuilt = fs.existsSync(path.join(REPO_ROOT, 'packages/viewer/dist/runtime/viewer.js'));

describe.skipIf(!e2eReady || !viewerBuilt)('查看器', () => {
  let api: http.Server;
  let viewer: ViewerServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    api = http.createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ message: `来自接口：${req.headers['x-token'] ?? ''}` }));
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    const apiUrl = `http://127.0.0.1:${(api.address() as { port: number }).port}/hello`;

    const projectPath = createProject({
      'project.config.json': { appid: 'wxviewer00000000', compileType: 'miniprogram' },
      'app.json': { pages: ['pages/index/index'] },
      'app.js': 'App({});',
      'pages/index/index.json': {},
      'pages/index/index.wxml': '<view id="token">{{token}}</view><view id="remote">{{remote}}</view><image id="logo" src="/images/logo.svg" />',
      'pages/index/index.js': `Page({
        data: { token: '', remote: '' },
        onLoad() {
          const token = wx.getStorageSync('token');
          this.setData({ token });
          wx.request({ url: ${JSON.stringify(apiUrl)}, header: { 'x-token': token }, success: res => this.setData({ remote: res.data.message }) });
        }
      });`,
      'images/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>',
      'wxa.setup.ts': `import { defineSetup } from '@open-wxa/wxa-runner-core/setup';
export default defineSetup(({ env }) => ({ storage: { token: env.WXA_TOKEN || 'pack-default' } }));`
    });
    const { bytes } = await createPack({ projectPath, logger: { warn: () => undefined } });
    const packFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-viewer-test-')), 'demo.wxapack');
    fs.writeFileSync(packFile, bytes);

    viewer = new ViewerServer({ port: 0, packs: [packFile], coreRuntimeDir: RUNTIME_DIR, logger: { warn: () => undefined } });
    await viewer.start();
    browser = await chromium.launch(chromeLaunchOptions);
    page = await (await browser.newContext()).newPage();
  });

  afterAll(async () => {
    await browser?.close();
    await viewer?.close();
    await new Promise(resolve => api?.close(resolve));
  });

  /** 等宿主 iframe 里的小程序启动完成，返回当前页的渲染层 */
  async function currentPage(): Promise<Frame> {
    const host = await waitFor(() => page.frames().find(frame => frame.url().endsWith('/__wxa__/host.html') && !frame.isDetached()));
    await host.waitForFunction(() => window.__wxa_test_api__, undefined, { timeout: 20000 });
    await host.evaluate(() => window.__wxa_test_api__.ready);
    const { frameName } = (await host.evaluate(() => window.__wxa_test_api__.currentPage()))!;
    return page.frame({ name: frameName })!;
  }

  /** 每 50ms 检查一次，返回第一个真值；20 秒还没有就失败 */
  async function waitFor<T>(check: () => T | undefined | false, timeout = 20000): Promise<T> {
    const deadline = Date.now() + timeout;
    for (;;) {
      const value = check();
      if (value) return value;
      if (Date.now() > deadline) throw new Error('等待超时');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }

  /** 保存后查看页面会重载宿主：等旧的宿主 iframe 被换掉再找当前页 */
  async function afterRestart(action: () => Promise<void>): Promise<Frame> {
    const old = page.frames().find(frame => frame.url().endsWith('/__wxa__/host.html'));
    await action();
    await waitFor(() => old?.isDetached() ?? true);
    return currentPage();
  }

  it('打开 preview 给出的地址时导入包并渲染页面，setup、静态资源和请求转发都生效', async () => {
    await page.goto(viewer.url);
    const frame = await currentPage();
    await expectText(frame, '#token', 'pack-default');
    await expectText(frame, '#remote', '来自接口：pack-default');
    const logo = await page.evaluate(async () => (await fetch('/images/logo.svg')).status);
    expect(logo).toBe(200);
    // 导入后地址栏里的 pack 参数被去掉，刷新时不会重复导入
    expect(new URL(page.url()).searchParams.has('pack')).toBe(false);
  });

  it('在查看页面里保存 WXA_ 变量后，setup 拿到新的值', async () => {
    await page.getByRole('tab', { name: /环境变量/ }).click();
    await page.getByLabel('变量名').first().fill('WXA_TOKEN');
    await page.getByLabel('变量值').first().fill('token-from-viewer');
    const frame = await afterRestart(() => page.getByRole('button', { name: '保存变量' }).click());
    await expectText(frame, '#token', 'token-from-viewer');
    await expectText(frame, '#remote', '来自接口：token-from-viewer');
  });

  it('在查看页面里改写 setup 后覆盖包里的，刷新页面后包、setup 和变量都还在', async () => {
    await page.getByRole('tab', { name: 'setup' }).click();
    await page.getByLabel('setup 源码').fill(`export default ({ env }: { env: Record<string, string> }) => ({ storage: { token: 'viewer:' + env.WXA_TOKEN } });`);
    let frame = await afterRestart(() => page.getByRole('button', { name: '保存 setup' }).click());
    await expectText(frame, '#token', 'viewer:token-from-viewer');

    await page.reload();
    frame = await currentPage();
    await expectText(frame, '#token', 'viewer:token-from-viewer');
  });

  it('setup 编译失败时显示错误，不覆盖已保存的 setup', async () => {
    await page.getByLabel('setup 源码').fill('export default {');
    await page.getByRole('button', { name: '保存 setup' }).click();
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).not.toBe('');
    await page.reload();
    const frame = await currentPage();
    await expectText(frame, '#token', 'viewer:token-from-viewer');
  });
});
