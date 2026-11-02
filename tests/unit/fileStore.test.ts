import { readFileSync } from 'fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileStore } from '../../packages/core/src/server/FileStore';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FileStore 的浏览器兼容性', () => {
  it('文件存储源码不依赖 Node，供 Service Worker 直接使用', () => {
    const source = readFileSync(new URL('../../packages/core/src/server/FileStore.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/node:|\bBuffer(?:Encoding)?\b|from\s+['"]crypto['"]/);
  });

  it('文件存储在没有 Node 全局对象和 crypto 时仍能读写，实例间 ETag 不重复', () => {
    vi.stubGlobal('Buffer', undefined);
    vi.stubGlobal('crypto', undefined);
    const first = new FileStore();
    const second = new FileStore();
    first.execute('writeFile', { filePath: '/a', data: '中文' });
    second.execute('writeFile', { filePath: '/a', data: '中文' });
    expect(first.execute('readFile', { filePath: '/a' })).toEqual({ data: '5Lit5paH', binary: true });
    expect(first.stat('/a')!.etag).not.toBe(second.stat('/a')!.etag);
    const etag = first.stat('/a')!.etag;
    first.execute('appendFile', { filePath: '/a', data: 'IQ==', binary: true });
    expect(first.execute('readFile', { filePath: '/a', encoding: 'utf8' })).toEqual({ data: '中文!' });
    expect(first.stat('/a')!.etag).not.toBe(etag);
  });

  it.each<BufferEncoding>(['utf8', 'utf-8', 'ascii', 'latin1', 'binary', 'utf16le', 'ucs2', 'ucs-2', 'base64', 'base64url', 'hex'])(
    '文件读取保留 %s 编码的 JSON 输出',
    encoding => {
      const store = new FileStore();
      const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0, 0x41, 0x80, 0xff, 0x3d, 0xd8]);
      store.write('/a', bytes);
      expect(store.execute('readFile', { filePath: '/a', encoding })).toEqual({ data: bytes.toString(encoding) });
    }
  );

  it.each<[BufferEncoding, string]>([
    ['utf8', '\uFEFF中文😀\uD800'],
    ['utf16le', '\uFEFF中文😀\uD800'],
    ['ucs-2', '中文'],
    ['ascii', 'é中😀'],
    ['latin1', 'é中😀'],
    ['binary', 'é中😀'],
    ['hex', '00ff81'],
    ['hex', '12z345'],
    ['hex', 'abc'],
    ['hex', '1z'],
    ['base64', ''],
    ['base64', 'AA=='],
    ['base64', 'AP+A'],
    ['base64', ' _-A\n!'],
    ['base64', 'YWJj=ignored'],
    ['base64', 'Y'],
    ['base64', 'YWI'],
    ['base64url', '_-A']
  ])('文件写入保留 %s 对 %j 的解析结果', (encoding, data) => {
    const store = new FileStore();
    store.execute('writeFile', { filePath: '/a', data, encoding });
    expect(store.execute('readFile', { filePath: '/a' })).toEqual({ data: Buffer.from(data, encoding).toString('base64'), binary: true });
  });

  it('文件存储复制输入字节，追加和复制文件后各文件内容独立', () => {
    const store = new FileStore();
    const bytes = new Uint8Array([0, 255, 128]);
    store.write('/a', bytes);
    bytes.fill(1);
    store.execute('copyFile', { srcPath: '/a', destPath: '/b' });
    store.write('/a', new Uint8Array([65]), true);
    expect([...store.read('/a')]).toEqual([0, 255, 128, 65]);
    expect([...store.read('/b')]).toEqual([0, 255, 128]);
  });

  it('文件接口对未知编码继续报错', () => {
    const store = new FileStore();
    store.write('/a', 'a');
    expect(() => store.execute('readFile', { filePath: '/a', encoding: 'unknown' })).toThrow('Unknown encoding: unknown');
    expect(() => store.execute('writeFile', { filePath: '/a', data: 'a', encoding: 'unknown' })).toThrow('Unknown encoding: unknown');
  });
});

describe('FileStore 重命名', () => {
  it('移动二进制文件、替换目标并保留源文件的元数据，同路径不删除文件', () => {
    const store = new FileStore(['/usr']);
    store.write('/usr/source', new Uint8Array([0, 255, 128]));
    store.write('/usr/target', 'old');
    const node = store.stat('/usr/source');
    store.execute('rename', { oldPath: 'http://localhost/usr/source', newPath: '/usr/target' });
    expect(store.stat('/usr/source')).toBeUndefined();
    expect(store.stat('/usr/target')).toBe(node);
    store.execute('rename', { oldPath: '/usr/./target', newPath: '/usr/target' });
    expect([...store.read('/usr/target')]).toEqual([0, 255, 128]);
  });

  it('移动整个目录，支持替换空目录，不误移动同前缀的兄弟节点', () => {
    const store = new FileStore(['/usr']);
    store.mkdir('/usr/from/nested', true);
    store.mkdir('/usr/to');
    store.write('/usr/from/nested/file', 'hello');
    store.write('/usr/from-other', 'keep');
    store.execute('rename', { oldPath: '/usr/from', newPath: '/usr/to' });
    expect(store.stat('/usr/from')).toBeUndefined();
    expect(store.stat('/usr/from/nested/file')).toBeUndefined();
    expect([...store.read('/usr/to/nested/file')]).toEqual([...new TextEncoder().encode('hello')]);
    expect(store.stat('/usr/from-other')).toBeDefined();
  });

  it.each([
    ['/usr/missing', '/usr/target'], ['/usr/source', '/missing/target'],
    ['/usr/source', '/usr/dir'], ['/usr/dir', '/usr/source'],
    ['/usr/dir', '/usr/full'], ['/usr/dir', '/usr/dir/child'],
    ['/usr', '/moved'], ['/usr/dir', '/usr'], ['/', '/moved']
  ])('非法移动 %s → %s 不改变已有节点', (oldPath, newPath) => {
    const store = new FileStore(['/usr']);
    store.mkdir('/usr/dir');
    store.mkdir('/usr/full');
    store.write('/usr/source', 'keep');
    store.write('/usr/full/child', 'keep');
    const before = store.readdir('/usr');
    expect(() => store.execute('rename', { oldPath, newPath })).toThrow();
    expect(store.readdir('/usr')).toEqual(before);
    expect(store.stat('/usr/source')).toBeDefined();
    expect(store.stat('/usr/full/child')).toBeDefined();
  });

  it('源文件不存在时，报错里是调用方传入的路径', () => {
    const store = new FileStore(['/usr']);
    expect(() => store.execute('rename', { oldPath: 'http://localhost/usr/missing', newPath: '/usr/target' })).toThrow(
      'no such file or directory http://localhost/usr/missing'
    );
  });
});
