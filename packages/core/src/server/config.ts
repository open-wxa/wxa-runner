/**
 * 命令行 dev 的配置文件 wxa.config.*：项目里长期不变的启动参数。默认导出普通对象，不用引入 wxa-runner，
 * 要类型提示时用 import type { WxaConfig } from 'wxa-runner'
 */

import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
import { transform } from 'esbuild';
import type { DevServerExtension } from './extensions';

export const CONFIG_FILE_NAMES = ['wxa.config.ts', 'wxa.config.mts', 'wxa.config.js', 'wxa.config.mjs', 'wxa.config.cjs'];

/** 配置文件的内容；命令行写了的参数优先，路径相对配置文件所在目录 */
export interface WxaConfig {
  /** 小程序项目目录（project.config.json 所在目录），写了之后命令行可以不写项目目录 */
  project?: string;
  /** 端口号，默认 3000，被占用时换用后面空闲的端口 */
  port?: number;
  /** 监听地址，默认 localhost；true 时监听所有地址，局域网也能访问 */
  host?: string | true;
  /** 启动后打开浏览器 */
  open?: boolean;
  /** 基础库版本，默认使用本机已安装的最新兼容版本 */
  baselib?: string;
  /** 监听文件变化并热更新，默认 true */
  watch?: boolean;
  /** 小程序启动前执行的 setup 文件，默认使用项目目录下的 wxa.setup.ts / .js / .mjs；false 不执行 */
  setup?: string | false;
  /** 借本机微信开发者工具的登录态访问微信后台：真实的 code 和手机号、服务市场、插件 */
  devtoolsLogin?: boolean;
  /** true 时 console.warn / console.error 也转发到终端，false 时报错也不转发；默认只转发报错，检测到编程助手时全部转发 */
  forwardConsole?: boolean;
  /** 开发服务器扩展：扩展对象、不带参数调用后返回扩展的函数，或 npm 包名、文件路径。排在命令行 --extension 之前 */
  extensions?: Array<DevServerExtension | (() => DevServerExtension) | string>;
  /** （实验性）navigateTo 和 navigateBack 时播放页面滑动过渡，导航栏和 tabBar 暂不跟随 */
  pageTransition?: boolean;
  /** web-view 的网页在新窗口打开：网页和模拟器域名不同时，Cookie 也能正常使用 */
  webViewWindow?: boolean;
}

const CONFIG_KEYS = new Set<string>([
  'project', 'port', 'host', 'open', 'baselib', 'watch', 'setup', 'devtoolsLogin', 'forwardConsole', 'extensions', 'pageTransition', 'webViewWindow'
] satisfies Array<keyof WxaConfig>);

/** dir 下约定名称的配置文件，没有时为 null */
export function findConfigFile(dir: string): string | null {
  for (const name of CONFIG_FILE_NAMES) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/**
 * 加载配置文件，project、setup 和以 . 开头的扩展路径换成绝对路径
 * @param warn 收到不认识的配置项时调用：可能是拼错了，也可能是给更新的版本写的
 * @throws 文件执行出错，或默认导出不是对象
 */
export async function loadConfigFile(file: string, warn: (message: string) => void): Promise<WxaConfig> {
  let exported: unknown;
  try {
    exported = await importConfig(file);
  } catch (error) {
    throw new Error(`配置文件 ${file} 加载失败：${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof exported !== 'object' || exported === null || Array.isArray(exported)) {
    throw new Error(`配置文件 ${file} 要默认导出一个对象，如 export default { port: 3000 }`);
  }
  const config = exported as WxaConfig;
  const unknown = Object.keys(config).filter(key => !CONFIG_KEYS.has(key));
  if (unknown.length) warn(`配置文件 ${file} 里有不认识的配置项：${unknown.join('、')}，已忽略`);

  const dir = path.dirname(file);
  const resolve = (value: string) => path.resolve(dir, value);
  return {
    ...config,
    project: config.project && resolve(config.project),
    setup: typeof config.setup === 'string' ? resolve(config.setup) : config.setup,
    extensions: config.extensions?.map(extension => (typeof extension === 'string' && extension.startsWith('.') ? resolve(extension) : extension))
  };
}

/**
 * .js / .mjs / .cjs 交给 Node 按模块类型加载。.ts 要先转成 JS：Node 18 不能直接执行 TypeScript。
 * 转出的文件放在配置文件旁边，import 的依赖才能从项目的 node_modules 里找到；__dirname 等换成配置文件自己的。
 * 文件名带随机串：同时启动的几个进程加载同一份配置时，不会读到或删掉别人的文件
 */
async function importConfig(file: string): Promise<unknown> {
  if (!/\.m?ts$/.test(file)) return defaultExport(await import(pathToFileURL(file).href));
  const { code } = await transform(fs.readFileSync(file, 'utf8'), {
    loader: 'ts',
    format: 'esm',
    platform: 'node',
    sourcefile: file,
    define: {
      __dirname: JSON.stringify(path.dirname(file)),
      __filename: JSON.stringify(file),
      'import.meta.url': JSON.stringify(pathToFileURL(file).href)
    }
  });
  const compiled = `${file}.${randomUUID()}.mjs`;
  fs.writeFileSync(compiled, code);
  try {
    return defaultExport(await import(pathToFileURL(compiled).href));
  } finally {
    fs.rmSync(compiled, { force: true });
  }
}

/** import() 拿到的 default 对 CommonJS 是 module.exports，转译出的 exports.default 还要再取一层 */
function defaultExport(module: { default?: unknown }): unknown {
  const exported = module.default as { default?: unknown; __esModule?: boolean } | undefined;
  return exported?.__esModule ? exported.default : exported;
}
