/** 文件 API、下载、上传和资源 URL 共用这些字节；不依赖 Node，以便 Service Worker 也能直接使用。 */

let storeSequence = 0;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder('utf-8', { ignoreBOM: true });

function normalizeEncoding(encoding: string): string {
  switch (String(encoding).toLowerCase()) {
    case 'utf8':
    case 'utf-8':
      return 'utf8';
    case 'utf16le':
    case 'utf-16le':
    case 'ucs2':
    case 'ucs-2':
      return 'utf16le';
    case 'latin1':
    case 'binary':
      return 'latin1';
    case 'ascii':
      return 'ascii';
    case 'base64':
    case 'base64url':
      return String(encoding).toLowerCase();
    case 'hex':
      return 'hex';
    default:
      throw new Error(`Unknown encoding: ${encoding}`);
  }
}

function encodeText(text: string, encoding: string): Uint8Array {
  const format = normalizeEncoding(encoding);
  if (format === 'utf8') return textEncoder.encode(text);
  if (format === 'base64' || format === 'base64url') {
    // 文件接口沿用宽松解析：接受 URL 字母表、忽略杂字符，遇到填充符即停止。
    let base64 = text
      .split('=', 1)[0]
      .replace(/-/g, '+')
      .replace(/_/g, '/')
      .replace(/[^A-Za-z0-9+/]/g, '');
    if (base64.length % 4 === 1) base64 = base64.slice(0, -1);
    base64 = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
    return Uint8Array.from(atob(base64), char => char.charCodeAt(0));
  }
  if (format === 'hex') {
    const bytes: number[] = [];
    for (let index = 0; index + 1 < text.length; index += 2) {
      const pair = text.slice(index, index + 2);
      if (!/^[\da-f]{2}$/i.test(pair)) break;
      bytes.push(parseInt(pair, 16));
    }
    return new Uint8Array(bytes);
  }
  const bytes = new Uint8Array(text.length * (format === 'utf16le' ? 2 : 1));
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (format === 'utf16le') {
      bytes[index * 2] = code & 0xff;
      bytes[index * 2 + 1] = code >>> 8;
    } else bytes[index] = code & 0xff;
  }
  return bytes;
}

function decodeText(bytes: Uint8Array, encoding: string): string {
  const format = normalizeEncoding(encoding);
  if (format === 'utf8') return textDecoder.decode(bytes);
  if (format === 'hex') return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const chunks: string[] = [];
  // 分块转换避免大文件超出函数参数个数限制；UTF-16 按码元读取以保留孤立代理项。
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    const chunk = bytes.subarray(offset, offset + 0x8000);
    const codes: number[] = [];
    for (let index = 0; index < chunk.length; index++) {
      if (format === 'utf16le') {
        if (index + 1 < chunk.length) codes.push(chunk[index] | (chunk[++index] << 8));
      } else codes.push(format === 'ascii' ? chunk[index] & 0x7f : chunk[index]);
    }
    chunks.push(String.fromCharCode(...codes));
  }
  const text = chunks.join('');
  if (format === 'base64') return btoa(text);
  if (format === 'base64url') return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return text;
}

interface FsNode {
  dir: boolean;
  data: Uint8Array;
  mtime: number;
  etag: string;
}

/** 基础库会往 http://usr/ 写运行日志；业务代码也可以通过 FileSystemManager 读写 */
export class FileStore {
  private readonly etagPrefix =
    globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${++storeSequence}-${Math.random().toString(36).slice(2)}`;
  private version = 0;
  private nodes = new Map<string, FsNode>([['/', { dir: true, data: new Uint8Array(0), mtime: Date.now(), etag: '' }]]);
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
    this.nodes.set(target, { dir: true, data: new Uint8Array(0), mtime: Date.now(), etag: '' });
  }

  write(filePath: string, input: string | Uint8Array, append = false) {
    const data = typeof input === 'string' ? textEncoder.encode(input) : new Uint8Array(input);
    const target = this.normalize(filePath);
    const parent = target.slice(0, target.lastIndexOf('/')) || '/';
    if (!this.nodes.get(parent)?.dir) throw new Error(`no such file or directory ${filePath}`);
    const existing = this.nodes.get(target);
    if (existing?.dir) throw new Error(`illegal operation on a directory ${filePath}`);
    let contents = data;
    if (append && existing) {
      contents = new Uint8Array(existing.data.length + data.length);
      contents.set(existing.data);
      contents.set(data, existing.data.length);
    }
    this.nodes.set(target, { dir: false, data: contents, mtime: Date.now(), etag: `${this.etagPrefix}-${++this.version}` });
  }

  read(filePath: string): Uint8Array {
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

  /** 文件 API 经开发服务器调用的操作，参数和返回值的字段名与基础库一致 */
  execute(operation: string, args: any): Record<string, any> {
    if (!Object.prototype.hasOwnProperty.call(this.operations, operation)) {
      throw new Error(`unsupported filesystem operation ${operation}`);
    }
    return this.operations[operation](args);
  }

  private readonly operations: Record<string, (args: any) => Record<string, any>> = {
    readFile: ({ filePath, encoding }) => {
      const data = this.read(filePath);
      return encoding === undefined ? { data: decodeText(data, 'base64'), binary: true } : { data: decodeText(data, encoding) };
    },
    writeFile: args => this.writeEncoded(args, false),
    appendFile: args => this.writeEncoded(args, true),
    copyFile: ({ srcPath, destPath }) => {
      this.write(destPath, this.read(srcPath));
      return {};
    },
    access: ({ path }) => {
      this.existing(path);
      return {};
    },
    stat: ({ path }) => {
      const node = this.existing(path);
      const stats = {
        mode: node.dir ? 0o40755 : 0o100644,
        size: node.data.length,
        lastAccessedTime: Math.floor(node.mtime / 1000),
        lastModifiedTime: Math.floor(node.mtime / 1000)
      };
      return { stats, ...stats };
    },
    getFileInfo: ({ filePath }) => ({ size: this.read(filePath).length }),
    mkdir: ({ dirPath, recursive }) => {
      this.mkdir(dirPath, !!recursive);
      return {};
    },
    readdir: ({ dirPath }) => ({ files: this.readdir(dirPath) }),
    unlink: ({ filePath }) => {
      this.remove(filePath, { dir: false });
      return {};
    },
    rmdir: ({ dirPath, recursive }) => {
      this.assertNotRoot(dirPath);
      this.remove(dirPath, { dir: true, recursive: !!recursive });
      return {};
    }
  };

  private writeEncoded(args: { filePath: string; data?: string; binary?: boolean; encoding?: string }, append: boolean) {
    this.write(args.filePath, encodeText(args.data ?? '', args.binary ? 'base64' : args.encoding || 'utf8'), append);
    return {};
  }

  private existing(filePath: string): FsNode {
    const node = this.stat(filePath);
    if (!node) throw new Error(`no such file or directory ${filePath}`);
    return node;
  }

  private assertNotRoot(dirPath: string) {
    const target = this.normalize(dirPath);
    const prefix = target === '/' ? '/' : target + '/';
    if (this.roots.some(root => root === target || root.startsWith(prefix))) {
      throw new Error(`operation not permitted ${dirPath}`);
    }
  }
}
