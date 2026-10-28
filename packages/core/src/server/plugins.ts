/**
 * 小程序插件的代码
 *
 * 插件代码不在项目里，同开发者工具：开发服务器带着开发者 ticket 向微信下载（wxa-dev/getplugincode），
 * 只放在内存里，同一个插件版本下载一次。下载要用开发者的登录态，所以只在开启 --devtools-login 时进行；
 * 小程序的 appid 要已在管理后台添加了这个插件，并经插件开发者通过。
 *
 * 下载到的是 .wxvpkg 格式的包，里面是编译好的产物：
 *   /plugin.json        插件页面表（pages）和每个页面的 window 配置（page）
 *   /appservice.js      逻辑层：definePlugin(...) 注册插件，自己 requirePlugin 完成初始化
 *   /pageframe.js       渲染层：插件的模板函数 $gwx_<插件 appid> 和样式
 *   /pages/x/x.html     插件页面：注入样式、取模板、派发 generateFuncReady
 *   /static/...         图片等资源
 * 插件页面的路径是 __plugin__/<插件 appid>/pages/x/x，基础库把 plugin://别名/页面名 解析成它再交给原生路由。
 */

import { readWxvpkgFile, readWxvpkgIndex } from '@open-wxa/wxa-runner-extractor';
import type { BuildResult } from '../project/AppBuilder';
import { AppBuild, PluginCode, withPlugins } from './pluginCode';
import { requireOk, WechatDevClient } from './wechatDev';

export { findPluginPage, pluginScriptUrl } from './pluginCode';
export type { AppBuild, PluginCode } from './pluginCode';

const DOWNLOAD_TIMEOUT = 30_000;
const PACKAGE_MAGIC = 0xbe;

/** app.json 的 plugins：引用名 → { provider, version } */
type DeclaredPlugins = Record<string, { provider?: string; version?: string }>;

export class PluginStore {
  /** provider@version → 下载结果；失败的不留，下次打开小程序时重试 */
  private readonly downloads = new Map<string, Promise<PluginCode>>();
  /**
   * 这次打开小程序时决定用哪些插件。同一次打开的逻辑层、业务模块、渲染层等请求都按它处理：
   * 各自去下载的话，下载失败时每个请求都会重试，结果还可能前后不一，页面列表和逻辑层对不上
   */
  private selection: Promise<PluginCode[]> | null = null;
  /** 没开 --devtools-login 的提示每个插件只说一次 */
  private readonly warned = new Set<string>();

  /**
   * @param wechat 开启 --devtools-login 时才有，没有时不下载插件
   */
  constructor(
    private readonly wechat: WechatDevClient | null,
    private readonly logger: Pick<Console, 'warn'>
  ) {}

  /** 打开小程序时（宿主取 app-info）调用：重新决定用哪些插件，下载过的直接用，上次失败的重试 */
  async refresh(build: BuildResult): Promise<AppBuild> {
    this.selection = this.select(build);
    return withPlugins(build, await this.selection);
  }

  /** 其余请求沿用这次打开时的决定，不触发下载；还没决定过时（如直接请求逻辑层）先决定一次 */
  async current(build: BuildResult): Promise<AppBuild> {
    this.selection ??= this.select(build);
    return withPlugins(build, await this.selection);
  }

  /** app.json 声明的插件；下载不了的跳过，在终端说明原因，小程序自己的页面照常可用 */
  private async select(build: BuildResult): Promise<PluginCode[]> {
    const declared: DeclaredPlugins = build.wxConfig.plugins || {};
    const results = await Promise.all(Object.entries(declared).map(([alias, { provider, version }]) =>
      provider && version ? this.load(alias, provider, version) : null
    ));
    return results.filter((plugin): plugin is PluginCode => !!plugin);
  }

  private async load(alias: string, provider: string, version: string): Promise<PluginCode | null> {
    const label = `插件 ${alias}（${provider}@${version}）`;
    if (!this.wechat) {
      this.warnOnce(label, `[wxa-runner] ${label} 的代码要用开发者的登录态向微信下载，启动时加 --devtools-login`);
      return null;
    }

    const key = `${provider}@${version}`;
    let download = this.downloads.get(key);
    if (!download) {
      download = this.download(this.wechat, alias, provider, version);
      this.downloads.set(key, download);
      download.catch(() => this.downloads.delete(key));
    }
    try {
      return await download;
    } catch (error) {
      this.logger.warn(`[wxa-runner] ${label} 下载失败：${(error as Error).message}`);
      return null;
    }
  }

  /** @throws 没有登录态、连不上、微信拒绝或返回的不是插件代码包时，消息是原因 */
  private async download(wechat: WechatDevClient, alias: string, provider: string, version: string): Promise<PluginCode> {
    const response = await wechat.post('wxa-dev/getplugincode', { plugin_id: provider, plugin_version: version }, DOWNLOAD_TIMEOUT);
    const data = Buffer.from(await response.arrayBuffer());
    // 出错时返回的是带 baseresponse 的 JSON
    if (data[0] !== PACKAGE_MAGIC) {
      let body: { baseresponse?: { errcode?: number; errmsg?: string } } = {};
      try {
        body = JSON.parse(data.toString('utf8'));
      } catch {
        // 不是 JSON，按没有结果码处理
      }
      if (body.baseresponse?.errcode) requireOk(body, '微信拒绝下载');
      throw new Error('微信没有返回插件代码');
    }

    const files = new Map(readWxvpkgIndex(data).map(entry => [entry.name, Buffer.from(readWxvpkgFile(data, entry))]));
    const pluginJson = JSON.parse(files.get('/plugin.json')?.toString('utf8') || '{}');
    return {
      alias,
      provider,
      version,
      files,
      pages: Object.values<string>(pluginJson.pages || {}),
      pageConfigs: pluginJson.page || {}
    };
  }

  private warnOnce(key: string, message: string) {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.logger.warn(message);
  }
}
