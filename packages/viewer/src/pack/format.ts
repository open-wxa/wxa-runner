/**
 * .wxapack 包格式与读取
 *
 * zip 包：manifest.json，code/ 下的模板、样式、bootstrap 与每个业务模块的 define 脚本，可选的 setup.js，static/ 下的资源文件。
 * 不依赖 Node：查看器的页面导入时校验、Service Worker 应答时读取，都用这里的 readPack。
 */

import { strFromU8, unzipSync } from 'fflate';
import type { BuildResult } from '@open-wxa/wxa-runner-core/web';

export const PACK_FORMAT = 1;

export interface PackManifest {
  format: typeof PACK_FORMAT;
  generator: string;
  createdAt: string;
  appid: string;
  baseLib: { version: string; hasWorker: boolean };
  isolated: boolean;
  build: Pick<BuildResult, 'version' | 'wxConfig' | 'modules' | 'workerModules' | 'pages' | 'components'>;
  setup: boolean;
}

export interface WxaPack {
  manifest: PackManifest;
  build: BuildResult;
  moduleScript(id: string): string | null;
  setupScript: string | null;
  staticFile(relPath: string): Uint8Array | null;
}

const SOURCE_EXTENSION = /\.(?:js|wxml|wxs|wxss|less|scss|sass|ts)$/i;
const PROJECT_CONFIGS = new Set(['project.config.json', 'project.private.config.json']);

export function isPackStaticFile(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, '/').split('/');
  const name = parts.pop()!;
  return (
    Boolean(name) &&
    !SOURCE_EXTENSION.test(name) &&
    !PROJECT_CONFIGS.has(name) &&
    !parts.some(part => !part || part.startsWith('.') || part === 'node_modules')
  );
}

export function readPack(bytes: Uint8Array): WxaPack {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes);
  } catch {
    throw new Error('不是 wxapack 包：无法读取 zip，文件可能已损坏');
  }
  if (!files['manifest.json']) throw new Error('不是 wxapack 包：缺少 manifest.json');

  let manifest: unknown;
  try {
    manifest = JSON.parse(strFromU8(files['manifest.json']));
  } catch {
    throw new Error('wxapack 的 manifest.json 无效：不是合法的 JSON');
  }
  if (!isRecord(manifest)) throw new Error('wxapack 的 manifest.json 无效：需要清单对象');
  if (manifest.format !== PACK_FORMAT) {
    throw new Error(`wxapack 格式版本 ${String(manifest.format)} 不受支持，请升级 wxa-runner`);
  }
  if (!isManifest(manifest)) throw new Error('wxapack 的 manifest.json 无效：字段缺失或类型错误');

  const script = (file: string): string | null => (files[file] ? strFromU8(files[file]) : null);
  const requiredScript = (file: string): string => {
    const code = script(file);
    if (code === null) throw new Error(`wxapack 包不完整：缺少 ${file}`);
    return code;
  };
  const build: BuildResult = {
    ...manifest.build,
    serviceTemplates: requiredScript('code/service-templates.js'),
    serviceBootstrap: requiredScript('code/service-bootstrap.js'),
    pageFrame: requiredScript('code/page-frame.js'),
    pageTemplates: requiredScript('code/page-templates.js'),
    pageStyles: requiredScript('code/page-styles.js'),
    durationMs: 0
  };
  for (const id of [...build.modules, ...build.workerModules]) requiredScript('code/module/' + id);

  return {
    manifest,
    build,
    moduleScript: id => script('code/module/' + id),
    setupScript: manifest.setup ? requiredScript('setup.js') : null,
    staticFile: relPath => files['static/' + relPath] ?? null
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isManifest(value: Record<string, unknown>): value is Record<string, unknown> & PackManifest {
  const { baseLib, build } = value;
  const strings = (items: unknown): items is string[] => Array.isArray(items) && items.every(item => typeof item === 'string');
  return (
    typeof value.generator === 'string' &&
    typeof value.createdAt === 'string' &&
    typeof value.appid === 'string' &&
    typeof value.isolated === 'boolean' &&
    typeof value.setup === 'boolean' &&
    isRecord(baseLib) &&
    typeof baseLib.version === 'string' &&
    typeof baseLib.hasWorker === 'boolean' &&
    isRecord(build) &&
    typeof build.version === 'number' &&
    isRecord(build.wxConfig) &&
    strings(build.modules) &&
    strings(build.workerModules) &&
    strings(build.pages) &&
    strings(build.components)
  );
}
