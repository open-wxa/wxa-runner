/**
 * 查看器的项目操作：导入 wxapack、?pack= 地址自动导入、环境变量校验
 */

import { readPack } from '../pack/format';
import type { ViewerProject } from '../store';

/** 校验包后生成待保存的项目；仅地址栏导入允许替换同名同 appid 的包，保留用户的 setup 和变量。 */
export function importProject(
  bytes: Uint8Array,
  filename: string,
  projects: ViewerProject[] = [],
  replaceMatching = false,
  now = Date.now()
): ViewerProject {
  const { manifest } = readPack(bytes);
  const name = filename.replace(/\.wxapack$/i, '') || '未命名项目';
  const existing = replaceMatching ? projects.find(project => project.name === name && project.appid === manifest.appid) : undefined;
  if (existing) return { ...existing, pack: bytes, updatedAt: Math.max(now, existing.updatedAt + 1) };
  return {
    id: globalThis.crypto?.randomUUID?.() ?? `${now}-${Math.random().toString(36).slice(2)}`,
    name,
    appid: manifest.appid,
    pack: bytes,
    importedAt: now,
    updatedAt: now,
    setupSource: null,
    setupFileName: null,
    setupScript: null,
    env: {}
  };
}

/**
 * 下载地址栏里 pack 参数指向的同源包，有多个时按顺序全部下载（wxa-runner viewer preview 传了多个包）。
 * 只有调用方都保存成功后才用 cleanURL 替换地址，下载或校验失败时刷新还能重试
 * @returns 地址栏没有 pack 参数时为 null
 * @throws 有非同源地址（不发任何请求）、某个包下载失败时
 */
export async function downloadPacks(
  pageURL: string,
  fetcher: typeof fetch = fetch
): Promise<{ packs: Array<{ filename: string; bytes: Uint8Array }>; cleanURL: string } | null> {
  const page = new URL(pageURL);
  const packPaths = page.searchParams.getAll('pack');
  if (!packPaths.length) return null;
  const urls = packPaths.map(packPath => {
    if (!packPath) throw new Error('pack 参数需要同源 wxapack 地址');
    const url = new URL(packPath, page);
    if (url.origin !== page.origin || !/^https?:$/.test(url.protocol) || url.username || url.password) {
      throw new Error('pack 参数只接受同源 wxapack 地址');
    }
    return url;
  });
  const packs = [];
  for (const url of urls) {
    const response = await fetcher(url.href, { credentials: 'same-origin', redirect: 'error' });
    if (!response.ok) throw new Error(`下载 wxapack 失败：HTTP ${response.status}`);
    packs.push({
      filename: decodeURIComponent(url.pathname.split('/').pop() || 'project.wxapack'),
      bytes: new Uint8Array(await response.arrayBuffer())
    });
  }
  page.searchParams.delete('pack');
  return { packs, cleanURL: page.href };
}

/**
 * 导入地址栏下载的一批包：全部校验通过才返回，有一个坏包就整批不导入，刷新后还能重试
 * @throws 有包校验失败时
 */
export function importProjects(packs: Array<{ filename: string; bytes: Uint8Array }>, projects: ViewerProject[]): ViewerProject[] {
  return packs.map(({ bytes, filename }) => importProject(bytes, filename, projects, true));
}

/**
 * 站点导出时带了默认包（viewer.json 的 defaultPacks），浏览器里又还没有项目时，把它们当作地址栏的 pack 参数交给 downloadPacks。
 * 地址栏已经指定了 pack 时以地址栏为准
 */
export function withDefaultPacks(pageURL: string, defaultPacks: string[], hasProjects: boolean): string {
  const page = new URL(pageURL);
  if (hasProjects || page.searchParams.has('pack')) return pageURL;
  for (const pack of defaultPacks) page.searchParams.append('pack', pack);
  return page.href;
}

/** 将编辑表格转换为项目 env；不改动变量值，非法或重复键阻止整个保存。 */
export function parseEnv(rows: Array<[string, string]>): Record<string, string> {
  const entries: Array<[string, string]> = [];
  const seen = new Set<string>();
  for (const [rawKey, value] of rows) {
    const key = rawKey.trim();
    if (!key && !value) continue;
    if (!/^WXA_[A-Za-z0-9_]+$/.test(key)) throw new Error(`变量名必须以 WXA_ 开头，只能包含字母、数字和下划线：${key || '（空）'}`);
    if (seen.has(key)) throw new Error(`变量名重复：${key}`);
    seen.add(key);
    entries.push([key, value]);
  }
  return Object.fromEntries(entries);
}
