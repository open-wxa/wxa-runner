/**
 * 在浏览器里编译查看器中设置的 setup（esbuild-wasm）。只支持单个文件：浏览器里没有项目目录，import 的文件找不到
 */

import type { build as esbuildBuild, Plugin } from 'esbuild-wasm';
import { SETUP_MODULE, SETUP_MODULE_SOURCE } from '@open-wxa/wxa-runner-core/web';

type SetupBuild = typeof esbuildBuild;
let compiler: Promise<SetupBuild> | undefined;
const SINGLE_FILE_ERROR = '查看器里的 setup 只能是单个文件；要 import 其他文件，用 wxa-runner viewer pack --setup 打进包里';

function browserCompiler(): Promise<SetupBuild> {
  compiler ??= import('esbuild-wasm')
    .then(async esbuild => {
      await esbuild.initialize({ wasmURL: '/__wxa__/runtime/esbuild.wasm' });
      return esbuild.build;
    })
    .catch(error => {
      compiler = undefined;
      throw error;
    });
  return compiler;
}

/** 编译单文件 setup；失败时抛出编译错误。build 可注入 Node 版 esbuild，测试无需启动 WASM。 */
export async function compileSetup(source: string, filename = 'wxa.setup.ts', build?: SetupBuild): Promise<string> {
  const compile = build ?? (await browserCompiler());
  const plugin: Plugin = {
    name: 'viewer-setup',
    setup(builder) {
      builder.onResolve({ filter: /.*/ }, args =>
        args.path === SETUP_MODULE ? { path: SETUP_MODULE, namespace: 'viewer-setup' } : { errors: [{ text: SINGLE_FILE_ERROR }] }
      );
      builder.onLoad({ filter: /.*/, namespace: 'viewer-setup' }, () => ({ contents: SETUP_MODULE_SOURCE, loader: 'js' }));
    }
  };
  const result = await compile({
    stdin: { contents: source, sourcefile: filename, loader: /\.ts$/i.test(filename) ? 'ts' : 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    logLevel: 'silent',
    logOverride: { 'unsupported-dynamic-import': 'error' },
    sourcemap: 'inline',
    plugins: [plugin]
  }).catch(error => {
    if (error.errors?.some((item: { id?: string }) => item.id === 'unsupported-dynamic-import')) {
      throw new Error(SINGLE_FILE_ERROR);
    }
    throw error;
  });
  return result.outputFiles![0].text;
}
