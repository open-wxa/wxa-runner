/** 开发服务器持有的文件存储；文件 API、下载、上传和资源 URL 共用这些字节。 */

import { randomUUID } from 'crypto';

interface FsNode {
  dir: boolean;
  data: Buffer;
  mtime: number;
  etag: string;
}

/** 基础库会往 http://usr/ 写运行日志；业务代码也可以通过 FileSystemManager 读写 */
export class FileStore {
  private readonly etagPrefix = randomUUID();
  private version = 0;
  private nodes = new Map<string, FsNode>([['/', { dir: true, data: Buffer.alloc(0), mtime: Date.now(), etag: '' }]]);
  private readonly roots: string[];

  /** @param roots 预先创建的目录（如用户目录）。rmdir 不能删除它们和它们的上级目录：删掉之后再写 USER_DATA_PATH 都会失败 */
  constructor(roots: string[] = []) {
    this.roots = roots.map(root => this.normalize(root));
    for (const root of this.roots) this.mkdir(root, true);
  }

  normalize(filePath: string): string {
    const stripped = String(filePath || '').replace(/^[a-z]+:\/\/[^/]*/i, '');
    const parts: string[] = [];
    for (const part of stripped.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') parts.pop();
      else parts.push(part);
    }
    return '/' + parts.join('/');
  }

  stat(filePath: string): FsNode | undefined {
    return this.nodes.get(this.normalize(filePath));
  }

  mkdir(dirPath: string, recursive = false) {
    const target = this.normalize(dirPath);
    if (this.nodes.has(target)) throw new Error(`file already exists ${dirPath}`);
    const parent = target.slice(0, target.lastIndexOf('/')) || '/';
    if (!this.nodes.get(parent)?.dir) {
      if (!recursive) throw new Error(`no such file or directory ${dirPath}`);
      this.mkdir(parent, true);
    }
    this.nodes.set(target, { dir: true, data: Buffer.alloc(0), mtime: Date.now(), etag: '' });
  }

  write(filePath: string, input: string | Uint8Array, append = false) {
    const data = Buffer.from(input);
    const target = this.normalize(filePath);
    const parent = target.slice(0, target.lastIndexOf('/')) || '/';
    if (!this.nodes.get(parent)?.dir) throw new Error(`no such file or directory ${filePath}`);
    const existing = this.nodes.get(target);
    if (existing?.dir) throw new Error(`illegal operation on a directory ${filePath}`);
    const contents = append && existing ? Buffer.concat([existing.data, data]) : data;
    this.nodes.set(target, { dir: false, data: contents, mtime: Date.now(), etag: `${this.etagPrefix}-${++this.version}` });
  }

  read(filePath: string): Buffer {
    const node = this.stat(filePath);
    if (!node) throw new Error(`no such file or directory, open ${filePath}`);
    if (node.dir) throw new Error(`illegal operation on a directory ${filePath}`);
    return node.data;
  }

  readdir(dirPath: string): string[] {
    const target = this.normalize(dirPath);
    if (!this.nodes.get(target)?.dir) throw new Error(`no such file or directory ${dirPath}`);
    const prefix = target === '/' ? '/' : target + '/';
    return [...this.nodes.keys()]
      .filter(key => key.startsWith(prefix) && key !== target && !key.slice(prefix.length).includes('/'))
      .map(key => key.slice(prefix.length));
  }

  remove(filePath: string, options: { dir: boolean; recursive?: boolean }) {
    const target = this.normalize(filePath);
    const node = this.nodes.get(target);
    if (!node) throw new Error(`no such file or directory ${filePath}`);
    if (node.dir !== options.dir) throw new Error(options.dir ? `not a directory ${filePath}` : `operation not permitted ${filePath}`);
    if (node.dir) {
      const children = this.readdir(target);
      if (children.length && !options.recursive) throw new Error(`directory not empty ${filePath}`);
      for (const key of [...this.nodes.keys()]) if (key.startsWith(target + '/')) this.nodes.delete(key);
    }
    this.nodes.delete(target);
  }

  execute(operation: string, args: any): Record<string, any> {
    switch (operation) {
      case 'readFile': {
        const data = this.read(args.filePath);
        return args.encoding === undefined ? { data: data.toString('base64'), binary: true } : { data: data.toString(args.encoding) };
      }
      case 'writeFile':
      case 'appendFile': {
        const data = Buffer.from(args.data ?? '', args.binary ? 'base64' : args.encoding || 'utf8');
        this.write(args.filePath, data, operation === 'appendFile');
        return {};
      }
      case 'copyFile':
        this.write(args.destPath, this.read(args.srcPath));
        return {};
      case 'access':
        if (!this.stat(args.path)) throw new Error(`no such file or directory ${args.path}`);
        return {};
      case 'stat': {
        const node = this.stat(args.path);
        if (!node) throw new Error(`no such file or directory ${args.path}`);
        const stats = {
          mode: node.dir ? 0o40755 : 0o100644,
          size: node.data.length,
          lastAccessedTime: Math.floor(node.mtime / 1000),
          lastModifiedTime: Math.floor(node.mtime / 1000)
        };
        return { stats, ...stats };
      }
      case 'getFileInfo':
        return { size: this.read(args.filePath).length };
      case 'mkdir':
        this.mkdir(args.dirPath, !!args.recursive);
        return {};
      case 'readdir':
        return { files: this.readdir(args.dirPath) };
      case 'unlink':
        this.remove(args.filePath, { dir: false });
        return {};
      case 'rmdir': {
        const target = this.normalize(args.dirPath);
        const prefix = target === '/' ? '/' : target + '/';
        if (this.roots.some(root => root === target || root.startsWith(prefix))) {
          throw new Error(`operation not permitted ${args.dirPath}`);
        }
        this.remove(args.dirPath, { dir: true, recursive: !!args.recursive });
        return {};
      }
      default:
        throw new Error(`unsupported filesystem operation ${operation}`);
    }
  }
}
