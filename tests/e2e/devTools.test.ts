/**
 * 端到端：开发工具（如 wxa-inspector）依赖的约定
 *
 * 开发工具通过 webviewScripts、middlewares、wxmlTransform 接入，同时依赖运行时的几项行为。这些行为不在扩展点的类型里，
 * 改动 runner 时容易无意中破坏，所以用一个最小的开发工具逐项验证，见 PROJECT_DESIGN.md 的「开发工具扩展点」。
 * 拦截 tap 的时机与基础库版本有关（2.x 的基础库自己在捕获阶段监听 touch），本机有哪个已验证版本就测哪个。
 */

import { Frame } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eReady, expectText, installedBaseLibs, Runner, startRunner, VERIFIED_BASELIBS } from './runner';

/** 在基础库之前注入：记录收到的事件，block 打开时在捕获阶段拦下；收到 ping 时回传给 top */
const HEAD_SCRIPT = `
window.__tool = { block: false, seen: [] };
['touchstart', 'touchmove', 'touchend', 'touchcancel', 'click'].forEach(function (type) {
  addEventListener(type, function (event) {
    __tool.seen.push(type);
    if (__tool.block) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, { capture: true, passive: false });
});
addEventListener('message', function (event) {
  if (event.data === 'tool:ping') top.postMessage('tool:pong:' + location.pathname, '*');
});
`;

/** 开发工具自己的页面：把 wxa-runner 的宿主页面嵌在 iframe 里，按 frame 树逐层广播 */
const TOOL_PAGE = `<!DOCTYPE html>
<iframe src="/" style="width:1000px;height:900px"></iframe>
<script>
var pongs = [];
addEventListener('message', function (event) { pongs.push(event.data); });
function ping(win) {
  for (var i = 0; i < win.frames.length; i++) { win.frames[i].postMessage('tool:ping', '*'); ping(win.frames[i]); }
}
</script>`;

const PROJECT = {
  'app.json': { pages: ['pages/index/index'] },
  'pages/index/index.json': { usingComponents: { box: '/components/box/box' } },
  'pages/index/index.wxml': '<view id="plain">plain</view>\n<button id="tap" bindtap="onTap">tap</button>\n<view id="count">{{count}}</view>\n<box id="box"/>',
  'pages/index/index.js': 'Page({ data: { count: 0 }, onTap() { this.setData({ count: this.data.count + 1 }); } });',
  'components/box/box.json': { component: true },
  'components/box/box.wxml': '<view>inner</view>',
  'components/box/box.js': 'Component({});'
};

describe.skipIf(!e2eReady)('开发工具依赖的约定', () => {
  for (const version of VERIFIED_BASELIBS) {
    describe.skipIf(!installedBaseLibs.has(version))(`基础库 ${version}`, () => {
      let runner: Runner;
      let frame: Frame;

      beforeAll(async () => {
        runner = await startRunner(PROJECT, {
          baseLibVersion: version,
          extensions: {
            webviewScripts: [
              { content: HEAD_SCRIPT, position: 'head' },
              { content: 'window.__bodyScript = { hasBody: !!document.body, rendered: !!document.querySelector("#plain") };' }
            ],
            middlewares: [{ path: '/__tool__', handler: (_req, res) => res.end(TOOL_PAGE) }],
            // 给 view 和自定义组件标签标上所在的文件
            wxmlTransform: (code, file) => code.replace(/<(view|box)\b/g, `$& data-tool-src="${file}"`)
          }
        });
        frame = await runner.open('/?path=pages/index/index');
      });

      afterAll(async () => {
        await runner?.close();
      });

      it('两种位置的注入脚本都会执行：head 在基础库之前，body 在页面渲染之前', async () => {
        expect(await frame.evaluate(() => [typeof (window as any).__tool, (window as any).__bodyScript])).toEqual([
          'object',
          { hasBody: true, rendered: false }
        ]);
      });

      it('wxml 里的 data-* 能从元素的 __wxElement.dataset 读到；自定义组件的内容渲染在宿主元素里，宿主的 is 是组件路径', async () => {
        const read = await frame.evaluate(() => {
          const wx = (el: Element | null) => (el as any)?.__wxElement;
          const inner = document.querySelector('wx-box wx-view')!;
          const host = inner.parentElement!.closest('wx-box');
          return {
            plain: wx(document.querySelector('#plain')).dataset.toolSrc,
            inner: wx(inner).dataset.toolSrc,
            host: wx(host).dataset.toolSrc,
            is: wx(host).is
          };
        });
        expect(read).toEqual({
          plain: 'pages/index/index.wxml',
          inner: 'components/box/box.wxml',
          host: 'pages/index/index.wxml',
          is: 'components/box/box'
        });
      });

      it('鼠标点击按 touch 事件派发；head 脚本在捕获阶段拦下 touch 后不触发 tap', async () => {
        await frame.click('#tap');
        await expectText(frame, '#count', '1');
        const seen: string[] = await frame.evaluate(() => (window as any).__tool.seen);
        expect(seen).toEqual(expect.arrayContaining(['touchstart', 'touchend', 'click']));

        await frame.evaluate(() => { (window as any).__tool.block = true; });
        await frame.click('#tap');
        await frame.waitForTimeout(500);
        expect(await frame.textContent('#count')).toBe('1');
        await frame.evaluate(() => { (window as any).__tool.block = false; });
      });

      it('宿主页面嵌在开发工具的页面里时，按 frame 树广播的消息能到达渲染层，渲染层能回传给 top', async () => {
        const { page } = runner;
        await page.goto(`${runner.base}/__tool__/`);
        await page.waitForFunction(() => {
          const visit = (win: Window): boolean => Array.from({ length: win.frames.length }, (_, i) => win.frames[i])
            .some(child => { try { return child.location.pathname.startsWith('/__wxa__/webview/') || visit(child); } catch { return false; } });
          return visit(window);
        });
        await page.waitForFunction(() => {
          (window as any).ping(window);
          return (window as any).pongs.includes('tool:pong:/__wxa__/webview/pages/index/index.html');
        }, undefined, { polling: 200 });
      });
    });
  }
});
