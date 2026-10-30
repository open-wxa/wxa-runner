/**
 * fixture 启动的 Chrome：Playwright 连着浏览器时 V8 要给每个函数补源码位置，基础库初始化会慢几百毫秒，fixture 默认关掉这一步
 */

import { expect, test } from '@open-wxa/wxa-runner-playwright';

test('开发者用 fixture 跑用例时，Chrome 启动时就让 V8 编译时记下源码位置，打开页面不用等基础库重新解析', async ({ page }) => {
  await page.goto('chrome://version');

  await expect(page.locator('#command_line')).toContainText('--no-enable-lazy-source-positions');
});
