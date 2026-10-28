/**
 * 插件代码的数据结构与页面查找，下载见 plugins.ts。
 * 不依赖 Node：查看器的 Service Worker 也按同样的结构生成页面
 */

import type { BuildResult } from '../project/AppBuilder';

export interface PluginCode {
  /** app.json 里的引用名，plugin://<alias>/页面名 */
  alias: string;
  /** 插件 appid */
  provider: string;
  version: string;
  /** 包内路径（/ 开头）→ 内容 */
  files: Map<string, Uint8Array>;
  /** 插件页面的路径，如 __plugin__/wx…/pages/index/index */
  pages: string[];
  /** 插件页面的配置，键同 __wxConfig.page（路径加 .html） */
  pageConfigs: Record<string, unknown>;
}

/** 构建结果加上用到的插件：插件页面并入 pages，配置并入 __wxConfig.page */
export interface AppBuild extends BuildResult {
  plugins: PluginCode[];
}

/** 插件页面并入 pages，配置并入 __wxConfig.page */
export function withPlugins(build: BuildResult, plugins: PluginCode[]): AppBuild {
  if (!plugins.length) return { ...build, plugins };
  return {
    ...build,
    plugins,
    pages: [...build.pages, ...plugins.flatMap(plugin => plugin.pages)],
    wxConfig: {
      ...build.wxConfig,
      page: { ...build.wxConfig.page, ...Object.assign({}, ...plugins.map(plugin => plugin.pageConfigs)) }
    }
  };
}

/** 插件页面所属的插件，以及页面在插件包里的路径（不带扩展名） */
export function findPluginPage(build: AppBuild, pagePath: string): { plugin: PluginCode; innerPath: string } | null {
  for (const plugin of build.plugins) {
    const prefix = `__plugin__/${plugin.provider}/`;
    if (plugin.pages.includes(pagePath)) return { plugin, innerPath: pagePath.slice(prefix.length) };
  }
  return null;
}

export function pluginScriptUrl(plugin: PluginCode, file: 'appservice.js' | 'pageframe.js'): string {
  return `/__wxa__/plugin/${encodeURIComponent(plugin.provider)}/${encodeURIComponent(plugin.version)}/${file}`;
}
