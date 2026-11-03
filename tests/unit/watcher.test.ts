/**
 * 文件监听：开发者保存文件后报告哪些文件变了、是否有文件新增或删除
 *
 * 用真实的临时目录和文件写入。要确认某个改动「没有报告」时，最后再改一个哨兵文件：
 * 文件事件按顺序到达，等到哨兵的报告时，它之前的改动如果会报告，也已经报告了。
 */

import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileChanges, ProjectWatcher, watchProject } from '../../packages/core/src/server/watcher';
import { createProject } from '../helpers';

const SENTINEL = 'sentinel.js';
const REPORT_TIMEOUT = 5000;
// macOS 的 FSEvents 会把开始监听前一刻的写入在 ready 之后补报出来，这里要确认的是之后的改动，
// 所以建好临时项目后等一会儿再监听
const SETTLE_BEFORE_WATCH = 300;

let watcher: ProjectWatcher | null = null;

afterEach(async () => {
  await watcher?.close();
  watcher = null;
});

/**
 * @param files 相对项目目录的文件
 * @param options.root 小程序根目录（相对项目目录），报告和读写的路径都相对它
 * @param options.extraFiles 根目录之外也要监听的文件（相对项目目录）
 */
async function watch(files: Record<string, string>, options: { root?: string; extraFiles?: string[] } = {}) {
  const rootDir = options.root || '.';
  const projectPath = createProject({ [path.join(rootDir, SENTINEL)]: 'initial', ...files });
  const root = path.join(projectPath, rootDir);
  const reports: FileChanges[] = [];
  let onReport = () => {};

  await new Promise(resolve => setTimeout(resolve, SETTLE_BEFORE_WATCH));
  watcher = watchProject(root, [root, ...(options.extraFiles || []).map(file => path.join(projectPath, file))], changes => {
    reports.push(changes);
    onReport();
  });
  await watcher.ready;

  let revision = 0;
  return {
    write(file: string, content: string) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.writeFileSync(path.join(root, file), content);
    },
    remove(file: string) {
      fs.rmSync(path.join(root, file));
    },
    touchSentinel() {
      fs.writeFileSync(path.join(root, SENTINEL), `revision ${++revision}`);
    },
    /** 等到某次报告里出现 file，返回到这次为止收到的全部报告 */
    reportsUntil(file: string): Promise<FileChanges[]> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`等待 ${file} 的报告超时，已收到 ${JSON.stringify(reports)}`)), REPORT_TIMEOUT);
        onReport = () => {
          if (!reports.some(report => report.files.includes(file))) return;
          clearTimeout(timer);
          resolve(reports.splice(0));
        };
        onReport();
      });
    }
  };
}

describe('文件监听', () => {
  it('修改文件后报告它相对小程序根目录的路径，不算新增或删除', async () => {
    const project = await watch({ 'pages/index/index.wxml': '<view>old</view>' });

    project.write('pages/index/index.wxml', '<view>new</view>');

    expect(await project.reportsUntil('pages/index/index.wxml')).toEqual([{ files: ['pages/index/index.wxml'], structural: false }]);
  });

  it('连续保存的多个文件合并成一次报告', async () => {
    const project = await watch({ 'pages/index/index.wxml': '<view>old</view>', 'pages/index/index.js': 'Page({})' });

    project.write('pages/index/index.wxml', '<view>new</view>');
    project.write('pages/index/index.js', 'Page({ data: {} })');

    const reports = await project.reportsUntil('pages/index/index.js');
    expect(reports).toHaveLength(1);
    expect([...reports[0].files].sort()).toEqual(['pages/index/index.js', 'pages/index/index.wxml']);
  });

  it('同一批改动里有新增文件时，整批报告为有新增或删除', async () => {
    const project = await watch({ 'pages/index/index.js': 'Page({})' });

    project.write('pages/index/index.js', "require('./format.js'); Page({})");
    project.write('pages/index/format.js', 'module.exports = {}');

    const reports = await project.reportsUntil('pages/index/format.js');
    expect(reports).toEqual([expect.objectContaining({ structural: true })]);
    expect([...reports[0].files].sort()).toEqual(['pages/index/format.js', 'pages/index/index.js']);
  });

  it('删除文件后报告为有新增或删除', async () => {
    const project = await watch({ 'pages/detail/detail.js': 'Page({})' });

    project.remove('pages/detail/detail.js');

    expect(await project.reportsUntil('pages/detail/detail.js')).toEqual([{ files: ['pages/detail/detail.js'], structural: true }]);
  });

  it('构建工具重写了内容没变的代码文件时，不报告这些文件', async () => {
    const project = await watch({ 'pages/index/index.wxml': '<view>same</view>', 'app.json': '{"pages":[]}' });

    project.write('pages/index/index.wxml', '<view>same</view>');
    project.write('app.json', '{"pages":[]}');
    project.touchSentinel();

    expect(await project.reportsUntil(SENTINEL)).toEqual([{ files: [SENTINEL], structural: false }]);
  });

  it('开始监听前就有的文件不报告', async () => {
    const project = await watch({ 'app.js': 'App({})', 'pages/index/index.wxml': '<view></view>' });

    project.touchSentinel();

    expect(await project.reportsUntil(SENTINEL)).toEqual([{ files: [SENTINEL], structural: false }]);
  });

  it('node_modules 和 .git 里的变化不报告', async () => {
    const project = await watch({ 'node_modules/dayjs/index.js': 'v1', '.git/HEAD': 'ref: refs/heads/main' });

    project.write('node_modules/dayjs/index.js', 'v2');
    project.write('.git/HEAD', 'ref: refs/heads/dev');
    project.touchSentinel();

    expect(await project.reportsUntil(SENTINEL)).toEqual([{ files: [SENTINEL], structural: false }]);
  });

  it('小程序根目录之外的 setup 文件修改后也报告，路径同样相对小程序根目录', async () => {
    const project = await watch(
      { 'wxa.setup.ts': 'export default {}', 'miniprogram/app.js': 'App({})' },
      { root: 'miniprogram', extraFiles: ['wxa.setup.ts'] }
    );

    project.write('../wxa.setup.ts', 'export default { storage: {} }');

    expect(await project.reportsUntil('../wxa.setup.ts')).toEqual([{ files: ['../wxa.setup.ts'], structural: false }]);
  });
});
