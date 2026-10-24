/**
 * 开发服务器扩展：检查器这类开发工具把要用的扩展点打包成一个扩展，
 * 由 DevServer 的 extensions 选项或命令行的 --extension 加载。runner 只认这个约定，不认识具体的工具。
 *
 * （「插件」在 runner 里指小程序插件，见 plugins.ts，所以这里叫扩展）
 */

import type { DevServerMiddleware, WebviewScript } from './DevServer';

export interface DevServerExtension {
  /** 出现在报错和启动信息里 */
  name: string;
  /** 开发服务器构造时调用一次 */
  setup(context: ExtensionContext): ExtensionSetup;
}

export interface ExtensionContext {
  /** 项目目录（DevServer 的 projectPath，绝对路径） */
  projectPath: string;
  /** 小程序代码根目录，已考虑 project.config.json 的 miniprogramRoot */
  root: string;
}

export interface ExtensionSetup {
  webviewScripts?: WebviewScript[];
  middlewares?: DevServerMiddleware[];
  wxmlTransform?: (code: string, file: string) => string;
  /** 扩展自己的页面：启动信息里打印，命令行 --open 时打开 */
  entry?: { label: string; path: string };
}

export interface ExtensionEntry {
  name: string;
  label: string;
  path: string;
}

type WxmlTransform = (code: string, file: string) => string;

/**
 * 把扩展合并进开发服务器自己的扩展点：脚本和中间件按顺序拼在后面，
 * wxml 转换按顺序串起来（先执行选项里直接给的，再依次执行各个扩展的）
 */
export function applyExtensions(
  base: ExtensionSetup,
  extensions: DevServerExtension[],
  context: ExtensionContext
): Required<Omit<ExtensionSetup, 'entry' | 'wxmlTransform'>> & { wxmlTransform?: WxmlTransform; entries: ExtensionEntry[] } {
  const webviewScripts = [...(base.webviewScripts ?? [])];
  const middlewares = [...(base.middlewares ?? [])];
  const transforms = base.wxmlTransform ? [base.wxmlTransform] : [];
  const entries: ExtensionEntry[] = [];

  for (const extension of extensions) {
    let setup: ExtensionSetup;
    try {
      setup = extension.setup(context);
    } catch (error) {
      throw new Error(`扩展 ${extension.name} 初始化失败：${(error as Error).message}`);
    }
    webviewScripts.push(...(setup.webviewScripts ?? []));
    middlewares.push(...(setup.middlewares ?? []));
    if (setup.wxmlTransform) transforms.push(setup.wxmlTransform);
    if (setup.entry) entries.push({ name: extension.name, ...setup.entry });
  }

  const wxmlTransform = transforms.length === 0
    ? undefined
    : (code: string, file: string) => transforms.reduce((result, transform) => transform(result, file), code);
  return { webviewScripts, middlewares, wxmlTransform, entries };
}
