/**
 * e2e：基础库捕获的业务代码错误也记入 errors()
 *
 * 生命周期、事件处理函数、wx API 回调、定时器里抛出的错误多被基础库捕获，只用 console.error 打印，
 * 不触发 iframe 的全局 error 事件；哪些位置被捕获因版本而异（如 3.7.0 的定时器不捕获，2.32.3 捕获）。
 * Playwright fixture 靠 errors() 判断用例有没有出错，漏记就让出了错的用例通过。
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eReady, expectText, installedBaseLibs, Runner, startRunner, VERIFIED_BASELIBS } from './runner';

const THROWN = ['wx API 回调里出错', '定时器里出错', 'Promise 没处理', '生命周期里出错', '事件处理函数里出错'];

describe.skipIf(!e2eReady)('基础库捕获的业务代码错误', () => {
  for (const version of VERIFIED_BASELIBS) {
    describe.skipIf(!installedBaseLibs.has(version))(`基础库 ${version}`, () => {
      let runner: Runner;

      beforeAll(async () => {
        runner = await startRunner({
          'app.json': { pages: ['pages/index/index'] },
          'pages/index/index.json': {},
          'pages/index/index.wxml': '<view id="btn" bindtap="tap">{{step}}</view>',
          'pages/index/index.js': `Page({
            data: { step: '' },
            onLoad() {
              wx.getSystemInfo({ success() { throw new Error('wx API 回调里出错'); } });
              setTimeout(() => { throw new Error('定时器里出错'); });
              Promise.reject(new Error('Promise 没处理'));
            },
            onReady() {
              this.setData({ step: '已渲染' });
              throw new Error('生命周期里出错');
            },
            tap() { throw new Error('事件处理函数里出错'); }
          });`
        }, { baseLibVersion: version });
      });

      afterAll(() => runner?.close());

      it('各处抛出的错误都记入 errors()，每个只记一次，保留原本的 message 和栈', async () => {
        const frame = await runner.open('/');
        await expectText(frame, '#btn', '已渲染');
        await frame.click('#btn');
        await runner.page.waitForFunction(count => window.__wxa_test_api__.errors().length >= count, THROWN.length);
        // 等一等：同一个错误从两路报来时，后到的那一路不能再记一次
        await new Promise(resolve => setTimeout(resolve, 500));

        const errors = await runner.page.evaluate(() => window.__wxa_test_api__.errors());
        expect(errors.map(error => error.message).sort()).toEqual([...THROWN].sort());
        for (const error of errors) {
          expect(error).toMatchObject({ kind: 'service', stack: expect.stringContaining('pages/index/index.js') });
        }
      }, 60000);
    });
  }
});
