/**
 * 文件监听：把开发者一次保存引起的文件变化合并成一批报告
 */

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import chokidar from 'chokidar';

export interface FileChanges {
  /** 相对小程序根目录、以 / 分隔的路径 */
  files: string[];
  /** 有文件新增或删除：页面、模块列表可能变了，只能整页刷新 */
  structural: boolean;
}

export interface ProjectWatcher {
  /** 初次扫描完成；此前已存在的文件不会作为改动报告 */
  ready: Promise<void>;
  close(): Promise<void>;
}

const DEBOUNCE = 120;
const IGNORED = /(^|[/\\])(node_modules|\.git)([/\\]|$)/;
const FINGERPRINTED = /\.(js|mjs|ts|json|wxml|wxss|wxs|less|scss|sass|css)$/;

/**
 * @param root 报告的路径相对这个目录
 * @param paths 要监听的目录和文件，可以在 root 之外
 * @param onChange 变化停下 120ms 后调用。内容没变的代码文件不算改动：
 *   构建工具（如 uni-app 的监听构建）每次保存都会重写全部产物
 */
export function watchProject(root: string, paths: string[], onChange: (changes: FileChanges) => void): ProjectWatcher {
  let changed = new Set<string>();
  let structural = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // 初次扫描时记下每个代码文件的内容指纹
  const fingerprints = new Map<string, string>();
  let scanned = false;

  const watcher = chokidar.watch(paths, { ignored: IGNORED });
  const ready = new Promise<void>(resolve => {
    watcher.on('ready', () => {
      scanned = true;
      resolve();
    });
  });

  const flush = () => {
    const changes = { files: [...changed], structural };
    changed = new Set();
    structural = false;
    onChange(changes);
  };

  watcher.on('all', (event, file) => {
    const unchanged = updateFingerprint(fingerprints, file, event);
    if (!scanned || unchanged) return;
    if (event !== 'change') structural = true;
    changed.add(path.relative(root, file).split(path.sep).join('/'));
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, DEBOUNCE);
  });

  return { ready, close: () => watcher.close() };
}

/** 记录文件的内容指纹；返回 true 表示内容与上次相同。图片等其他文件不读取，一律视为有变化 */
function updateFingerprint(fingerprints: Map<string, string>, file: string, event: string): boolean {
  if (event === 'unlink') {
    fingerprints.delete(file);
    return false;
  }
  if ((event !== 'add' && event !== 'change') || !FINGERPRINTED.test(file)) return false;
  let next: string;
  try {
    next = createHash('sha1').update(fs.readFileSync(file)).digest('hex');
  } catch {
    return false;
  }
  const previous = fingerprints.get(file);
  fingerprints.set(file, next);
  return previous === next;
}
