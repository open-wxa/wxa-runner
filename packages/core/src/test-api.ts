/**
 * window.__wxa_test_api__ 的全局类型声明，供测试代码按需引用：
 *
 *   /// <reference types="@open-wxa/wxa-runner-core/test-api" />
 *
 * 只产出类型，不参与运行时打包。WxaTestApi 等类型从包的主入口导入。
 */

import type { WxaTestApi } from './runtime/host/testApi';

declare global {
  interface Window {
    __wxa_test_api__: WxaTestApi;
    /**
     * 由测试工具在页面脚本执行前定义（如 Playwright 的 page.addInitScript）。宿主在 setup 之后、小程序启动前调用并等它完成，
     * 这里调用 mock、route，App.onLaunch 里就能生效。抛错时模拟器显示错误，小程序不启动
     */
    __wxa_before_launch__?: (api: WxaTestApi) => unknown;
    /**
     * 由测试工具在页面脚本执行前设为 true，这次打开的小程序里 web-view 的网页在新窗口打开，
     * 同开发服务器的 webViewWindow 选项（--webview-window）
     */
    __wxa_webview_window__?: boolean;
    /**
     * 由测试工具在页面脚本执行前定义。新窗口模式下宿主每新开一个网页窗口（type 为 'open'，带上地址）、关掉一个窗口（'close'）时调用，
     * name 同 webViews() 的 windowName。网页设置了 Cross-Origin-Opener-Policy 时窗口名会被清空、宿主也关不掉窗口，测试工具靠它对上窗口
     */
    __wxa_webview_window_event__?: (type: 'open' | 'close', name: string, src?: string) => Promise<void> | void;
  }
}
