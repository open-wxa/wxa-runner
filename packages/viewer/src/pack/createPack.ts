/**
 * wxa-runner viewer pack：在本机把小程序编译成 .wxapack 包，格式见 format.ts
 *
 * 编译要用官方 wcc / wcsc，只能在 Node 里做；包里放的是开发服务器本来按请求生成的东西，查看器拿到后不用再编译。
 */

import fs from 'fs';
import path from 'path';
import { strToU8, zipSync } from 'fflate';
import { resolveBaseLib, usesIsolatedContext } from '@open-wxa/wxa-runner-extractor';
import { AppBuilder, bundleSetup, findSetupFile, MiniProgram } from '@open-wxa/wxa-runner-core';
import { version } from '../../package.json';
import { isPackStaticFile, PACK_FORMAT } from './format';
import type { PackManifest } from './format';

export interface CreatePackOptions {
  projectPath: string;
  setup?: string | false;
  baseLibVersion?: string;
  baseLibCacheDir?: string;
  logger?: Pick<Console, 'warn'>;
}

export interface CreatePackResult {
  bytes: Uint8Array;
  manifest: PackManifest;
  warnings: string[];
}

export async function createPack(options: CreatePackOptions): Promise<CreatePackResult> {
  const project = new MiniProgram(path.resolve(options.projectPath));
  const builder = new AppBuilder(project);
  try {
    const baseLib = resolveBaseLib({ version: options.baseLibVersion, cacheDir: options.baseLibCacheDir });
    const setupFile = resolveSetupFile(options.setup, project.projectPath);
    const warnings: string[] = [];
    const plugins = Object.keys(project.readAppJson().plugins ?? {});
    if (plugins.length) {
      const warning = `wxapack 暂不支持插件：${plugins.join('、')}，包内的插件功能不可用`;
      warnings.push(warning);
      (options.logger ?? console).warn(warning);
    }

    const build = await builder.build();
    const files: Record<string, Uint8Array> = {
      'code/service-templates.js': strToU8(build.serviceTemplates),
      'code/service-bootstrap.js': strToU8(build.serviceBootstrap),
      'code/page-frame.js': strToU8(build.pageFrame),
      'code/page-templates.js': strToU8(build.pageTemplates),
      'code/page-styles.js': strToU8(build.pageStyles)
    };
    for (const id of [...build.modules, ...build.workerModules]) {
      files['code/module/' + id] = strToU8(builder.getModuleScript(id));
    }
    if (setupFile) files['setup.js'] = strToU8(await bundleSetup(setupFile));
    collectStaticFiles(project.root, '', files);

    const manifest: PackManifest = {
      format: PACK_FORMAT,
      generator: `wxa-viewer@${version}`,
      createdAt: new Date().toISOString(),
      appid: project.appid,
      baseLib: { version: baseLib.version, hasWorker: fs.existsSync(path.join(baseLib.dir, 'WAWorker.js')) },
      isolated: usesIsolatedContext(baseLib.version),
      build: {
        version: build.version,
        wxConfig: build.wxConfig,
        modules: build.modules,
        workerModules: build.workerModules,
        pages: build.pages,
        components: build.components
      },
      setup: setupFile !== null
    };
    files['manifest.json'] = strToU8(JSON.stringify(manifest));
    return { bytes: zipSync(files), manifest, warnings };
  } finally {
    builder.dispose();
  }
}

function resolveSetupFile(option: string | false | undefined, projectPath: string): string | null {
  if (option === false) return null;
  if (!option) return findSetupFile(projectPath);
  const file = path.resolve(option);
  if (!fs.existsSync(file)) throw new Error(`找不到 setup 文件：${file}`);
  return file;
}

function collectStaticFiles(root: string, dir: string, files: Record<string, Uint8Array>): void {
  for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    const relPath = dir ? dir + '/' + entry.name : entry.name;
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && !entry.name.startsWith('.')) collectStaticFiles(root, relPath, files);
    } else if (entry.isFile() && isPackStaticFile(relPath)) {
      files['static/' + relPath] = fs.readFileSync(path.join(root, relPath));
    }
  }
}
