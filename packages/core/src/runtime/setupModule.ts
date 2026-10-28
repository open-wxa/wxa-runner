/** setup 打包时对 wxa-runner-core/setup 的替换：开发服务器和在浏览器里编译 setup 的宿主（如查看器）共用同一实现；defineSetup 只提供类型提示，运行时原样返回。 */
export const SETUP_MODULE = '@open-wxa/wxa-runner-core/setup';
export const SETUP_MODULE_SOURCE = 'export function defineSetup(setup) { return setup; }';
