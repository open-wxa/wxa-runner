/**
 * wxmlTransform 的镜像目录
 *
 * wcc 只接收文件路径、自己从磁盘读文件，转换不能只在内存里做：把转换后的 .wxml 和原样的 .wxs
 * 写进临时目录，编译时把 wcc 的工作目录指向这里。相对路径和行号与源文件一致，编译错误照常指向源文件。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { MiniProgram } from './MiniProgram';

export class WxmlMirror {
  private dir: string | null = null;
  /** 已写入的文件：源内容（判断要不要重新转换）与写入的内容 */
  private readonly files = new Map<string, string>();

  constructor(private readonly transform: (code: string, file: string) => string) {}

  /** 镜像目录；还没同步过时为 null */
  get directory(): string | null {
    return this.dir;
  }

  /**
   * 让镜像目录与项目里的 wxml / wxs 一致，返回镜像目录。
   * 只重写源内容变化的文件；项目里已删除的文件同时从镜像目录删除，被引用时 wcc 照常报错
   */
  sync(project: MiniProgram, relPaths: string[]): string {
    const dir = (this.dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-runner-wxml-')));
    const current = new Set(relPaths);
    for (const rel of [...this.files.keys()]) {
      if (current.has(rel)) continue;
      fs.rmSync(path.join(dir, rel), { force: true });
      this.files.delete(rel);
    }
    for (const rel of relPaths) {
      const source = project.readText(rel);
      if (this.files.get(rel) === source) continue;
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, rel.endsWith('.wxml') ? this.transform(source, rel) : source);
      this.files.set(rel, source);
    }
    return dir;
  }

  dispose(): void {
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
    this.files.clear();
  }
}
