/**
 * @open-wxa/wxa-runner-playwright：在 Playwright 里测试小程序
 *
 *   import { test, expect } from '@open-wxa/wxa-runner-playwright';
 *
 *   test('下单', async ({ miniProgram }) => {
 *     await miniProgram.open('pages/index/index');
 *     ...
 *   });
 */

import path from 'path';
import { expect as baseExpect, test as base } from '@playwright/test';
import { DevServer } from '@open-wxa/wxa-runner-core';
import { withEagerSourcePositions } from './launchOptions';
import { miniProgramMatchers } from './matchers';
import { createMiniProgram, MiniProgram } from './miniProgram';
import { devServerOptions, WxaServerOptions } from './server';

export type { MiniProgram, MockHandler, RouteHandler } from './miniProgram';
export type { MiniProgramRequest } from './request';
export type { WxaServerOptions } from './server';

/** 在 playwright.config.ts 的 use 里配置，或在用例文件里用 test.use 修改 */
export interface WxaOptions {
  /**
   * 小程序项目目录（project.config.json 所在目录）。相对路径基于 Playwright 配置文件所在目录，默认就是这个目录。
   * 每个 worker 启动一个开发服务器，所以只能在配置文件或用例文件顶层修改（test.use），修改后 Playwright 会换一个 worker
   */
  wxaProject: string;
  /** 开发服务器的其余参数，其中 setup 等路径也相对配置文件所在目录。同 wxaProject，只能在配置文件或用例文件顶层修改 */
  wxaServerOptions: WxaServerOptions;
  /** 用例结束时检查 errors() 为空，默认 true。有意触发运行时错误的用例用 test.use({ wxaCheckErrors: false }) 关掉 */
  wxaCheckErrors: boolean;
}

export interface WxaFixtures {
  /** 当前用例的小程序：每个用例一个新的浏览器上下文，Storage、页面栈互不影响 */
  miniProgram: MiniProgram;
}

export interface WxaWorkerFixtures {
  /** 本 worker 的开发服务器，所有用例共用：编译只做一次 */
  wxaServer: DevServer;
}

const ERRORS_HINT = '小程序有运行时错误，或调用了未实现的 wx API（用到的请 mock）。有意触发错误的用例可以 test.use({ wxaCheckErrors: false })';

export const test = base.extend<
  WxaFixtures & Pick<WxaOptions, 'wxaCheckErrors'>,
  WxaWorkerFixtures & Pick<WxaOptions, 'wxaProject' | 'wxaServerOptions'>
>({
  wxaProject: ['.', { scope: 'worker', option: true }],
  wxaServerOptions: [{}, { scope: 'worker', option: true }],
  wxaCheckErrors: [true, { option: true }],

  // 配置文件 use 里的 launchOptions 照常传进来；用例文件里 test.use({ launchOptions }) 会整个替换掉这里，不再追加
  launchOptions: [async ({ launchOptions, browserName }, use) => {
    await use(browserName === 'chromium' ? { ...launchOptions, args: withEagerSourcePositions(launchOptions.args) } : launchOptions);
  }, { scope: 'worker' }],

  wxaServer: [async ({ wxaProject, wxaServerOptions }, use, workerInfo) => {
    const configDir = workerInfo.config.configFile ? path.dirname(workerInfo.config.configFile) : process.cwd();
    const server = new DevServer(devServerOptions(configDir, wxaProject, wxaServerOptions));
    await server.start();
    await use(server);
    await server.close();
  }, { scope: 'worker', timeout: 60000 }],

  miniProgram: async ({ page, wxaServer, wxaCheckErrors }, use) => {
    const session = await createMiniProgram(page, {
      baseURL: wxaServer.url,
      listPages: () => wxaServer.builder.build().then(build => build.pages, () => null)
    });
    await use(session.miniProgram);

    session.throwHandlerError();
    if (wxaCheckErrors) baseExpect(await session.miniProgram.errors(), ERRORS_HINT).toEqual([]);
  }
});

export const expect = baseExpect.extend(miniProgramMatchers);
