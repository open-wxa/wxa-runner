/**
 * 文件系统 API：内存文件系统，以及读取代码包里的文件
 *
 * 带协议的路径（如 http://usr/）在内存文件系统里；不带协议的是代码包里的文件，由开发服务器提供。
 * 临时文件和保存的文件见 tempFiles.ts、savedFiles.ts。
 */

import { ApiHandler, fail, ok } from './registry';
import { copyTempFile, isTempFile, removeTempFile, tempFileBytes, tempFileSize } from './tempFiles';

const DIR_MODE = 0o40755;
const FILE_MODE = 0o100644;

interface FsNode {
  dir: boolean;
  data: string;
  mtime: number;
}

/** 基础库会往 http://usr/ 写运行日志；业务代码也可以通过 FileSystemManager 读写 */
export class MemoryFileSystem {
  private nodes = new Map<string, FsNode>([['/', { dir: true, data: '', mtime: Date.now() }]]);

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
    this.nodes.set(target, { dir: true, data: '', mtime: Date.now() });
  }

  write(filePath: string, data: string, append = false) {
    const target = this.normalize(filePath);
    const parent = target.slice(0, target.lastIndexOf('/')) || '/';
    if (!this.nodes.get(parent)?.dir) throw new Error(`no such file or directory ${filePath}`);
    const existing = this.nodes.get(target);
    if (existing?.dir) throw new Error(`illegal operation on a directory ${filePath}`);
    this.nodes.set(target, { dir: false, data: append && existing ? existing.data + data : data, mtime: Date.now() });
  }

  read(filePath: string): string {
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
}

export function createFileSystemApis(): Record<string, ApiHandler> {
  const fs = new MemoryFileSystem();
  fs.mkdir('/__wxa__/tmp', true);

  const guard = (api: string, action: () => Record<string, unknown> | void) => {
    try {
      return ok(api, action() || {});
    } catch (error) {
      return fail(api, (error as Error).message);
    }
  };

  const statResult = (node: Omit<FsNode, 'data'> & { data: string | Uint8Array }) => {
    const stats = {
      mode: node.dir ? DIR_MODE : FILE_MODE,
      size: node.data.length,
      lastAccessedTime: Math.floor(node.mtime / 1000),
      lastModifiedTime: Math.floor(node.mtime / 1000)
    };
    return { stats, ...stats };
  };

  const readLocalFile: ApiHandler = (args, { api }) => guard(api, () => {
    const bytes = tempFileBytes(args.filePath);
    if (!bytes) return { data: fs.read(args.filePath) };
    if (args.encoding === undefined) return { data: bytes.slice().buffer };
    if (args.encoding === 'base64') {
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 32768) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
      }
      return { data: btoa(binary) };
    }
    return { data: new TextDecoder(args.encoding).decode(bytes) };
  });

  const apis: Record<string, ApiHandler> = {
    access: (args, { api }) => (tempFileBytes(args.path) || fs.stat(args.path) ? ok(api) : fail(api, `no such file or directory ${args.path}`)),
    stat: (args, { api }) => {
      const bytes = tempFileBytes(args.path);
      const node = bytes ? { dir: false, data: bytes, mtime: Date.now() } : fs.stat(args.path);
      return node ? ok(api, statResult(node)) : fail(api, `no such file or directory ${args.path}`);
    },
    mkdir: (args, { api }) => guard(api, () => fs.mkdir(args.dirPath, !!args.recursive)),
    writeFile: (args, { api }) => guard(api, () => fs.write(args.filePath, String(args.data ?? ''))),
    appendFile: (args, { api }) => guard(api, () => fs.write(args.filePath, String(args.data ?? ''), true)),
    readdir: (args, { api }) => guard(api, () => ({ files: fs.readdir(args.dirPath) })),
    unlink: (args, { api }) => isTempFile(args.filePath)
      ? removeTempFile(args.filePath).then(() => ok(api), error => fail(api, error.message))
      : guard(api, () => fs.remove(args.filePath, { dir: false })),
    rmdir: (args, { api }) => guard(api, () => fs.remove(args.dirPath, { dir: true, recursive: !!args.recursive })),
    getFileInfo: (args, { api }) => {
      if (isTempFile(args.filePath)) {
        return tempFileSize(args.filePath).then(size => (size === null ? fail(api, 'file not exist') : ok(api, { size })));
      }
      const node = fs.stat(args.filePath);
      return node ? ok(api, { size: node.data.length }) : fail(api, 'file not exist');
    }
  };
  for (const name of Object.keys(apis)) apis[name + 'Sync'] = apis[name];
  apis.unlinkSync = (args, { api }) => guard(api, () => fs.remove(args.filePath, { dir: false }));
  apis.copyFile = (args, { api }) => copyTempFile(args.srcPath, args.destPath).then(
    () => ok(api), error => fail(api, error.message)
  );
  // FileSystemManager 的异步调用在部分基础库里使用 fs_ 前缀。
  for (const name of Object.keys(apis)) if (!name.endsWith('Sync')) apis['fs_' + name] = apis[name];

  return {
    ...apis,
    fs_appendFile: apis.appendFile,
    // 不带协议的是代码包里的文件，要向开发服务器取；readFileSync 同步返回不了，只读内存文件系统。
    // 内存文件系统的路径去掉了协议，不能先在里面找：用户目录下的同名文件会顶替代码包里的
    readFile: (args, context) => (/^[a-z]+:\/\//i.test(String(args.filePath))
      ? readLocalFile(args, context)
      : readPackageFile(fs.normalize(args.filePath), args.encoding).then(
        data => ok(context.api, { data }),
        error => fail(context.api, error.message)
      )),
    readFileSync: readLocalFile
  };
}

/**
 * 开发服务器以项目目录为根目录提供代码包里的文件
 * @param filePath 以 / 开头、相对代码包根目录的路径
 * @param encoding 不指定时得到 ArrayBuffer
 * @throws 文件不存在，或 encoding 不是 utf8
 */
async function readPackageFile(filePath: string, encoding: unknown): Promise<string | ArrayBuffer> {
  if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'utf-8') {
    throw new Error(`读取代码包里的文件只支持 utf8 编码，或不指定编码得到 ArrayBuffer，不支持 ${encoding}`);
  }
  // encodeURI 不编码 # 和 ?，文件名里有的话会被当成地址的片段和查询
  const response = await fetch(filePath.split('/').map(encodeURIComponent).join('/'));
  if (!response.ok) throw new Error(`no such file or directory, open ${filePath}`);
  return encoding ? response.text() : response.arrayBuffer();
}
