/**
 * setup 文件的发现、编译与环境变量（浏览器端执行见 runtime/host/setup.ts）
 */

import fs from 'fs';
import path from 'path';
import { build, Plugin } from 'esbuild';
import { SETUP_MODULE, SETUP_MODULE_SOURCE } from '../runtime/setupModule';

export const SETUP_FILE_NAMES = ['wxa.setup.ts', 'wxa.setup.js', 'wxa.setup.mjs'];
const ENV_PREFIX = 'WXA_';

/** 项目目录（project.config.json 所在目录）下约定名称的 setup 文件 */
export function findSetupFile(projectPath: string): string | null {
  for (const name of SETUP_FILE_NAMES) {
    const file = path.join(projectPath, name);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

/** 只暴露 WXA_ 前缀的变量：setup 跑在浏览器里，其余环境变量可能是不该外泄的密钥 */
export function collectSetupEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[0].startsWith(ENV_PREFIX) && entry[1] !== undefined)
  );
}

/**
 * 把 setup 文件连同它 import 的文件打成一个浏览器 ES 模块
 *
 * 用户的小程序项目里通常没装本包，对它的引用直接换成运行时自带的实现。
 *
 * @throws 语法错误、import 找不到等编译错误，消息里带相对 setup 文件目录的位置
 */
export async function bundleSetup(file: string): Promise<string> {
  const result = await build({
    entryPoints: [file],
    absWorkingDir: path.dirname(file),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
    sourcemap: 'inline',
    plugins: [builtinSetupModule()]
  });
  return result.outputFiles[0].text;
}

function builtinSetupModule(): Plugin {
  return {
    name: 'wxa-setup-module',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: new RegExp(`^${SETUP_MODULE}$`) }, () => ({ path: SETUP_MODULE, namespace: 'wxa-setup' }));
      pluginBuild.onLoad({ filter: /.*/, namespace: 'wxa-setup' }, () => ({
        contents: SETUP_MODULE_SOURCE,
        loader: 'js'
      }));
    }
  };
}
