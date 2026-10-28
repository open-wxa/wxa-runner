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
