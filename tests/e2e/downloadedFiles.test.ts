import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { e2eReady, Runner, startRunner } from './runner';

const PAGE_JS = `
Page({
  call(api, args) {
    return new Promise(resolve => wx[api]({ ...args, success: resolve, fail: resolve }));
  },
  callFs(api, args) {
    return new Promise(resolve => wx.getFileSystemManager()[api]({
      ...args,
      success: result => resolve({ ...result, data: result.data instanceof ArrayBuffer
        ? Array.from(new Uint8Array(result.data)) : result.data }),
      fail: resolve
    }));
  },
  read(filePath, encoding) {
    try {
      const data = wx.getFileSystemManager().readFileSync(filePath, encoding);
      return { data: data instanceof ArrayBuffer ? Array.from(new Uint8Array(data)) : data };
    } catch (error) { return { error: error.message }; }
  },
  userPath() { return wx.env.USER_DATA_PATH; }
});
`;

const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));

describe.skipIf(!e2eReady)('下载文件的二进制读取与用户目录复制', () => {
  let runner: Runner;
  let server: http.Server;
  let url: string;
  const uploads: Buffer[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (req.method === 'POST') {
        const parts: Buffer[] = [];
        req.on('data', part => parts.push(part));
        req.on('end', () => {
          uploads.push(Buffer.concat(parts));
          res.end('uploaded');
        });
      } else {
        res.setHeader('content-type', 'application/octet-stream');
        res.end(req.url === '/reversed' ? Buffer.from(bytes).reverse() : bytes);
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    runner = await startRunner({
      'app.json': { pages: ['pages/index/index'] },
      'pages/index/index.wxml': '<view>files</view>',
      'pages/index/index.js': PAGE_JS
    });
  });

  afterAll(async () => {
    await runner?.close();
    server?.closeAllConnections();
    server?.close();
  });

  const call = (method: string, ...args: unknown[]) =>
    runner.page.evaluate(([method, args]) => window.__wxa_test_api__.callPageMethod(method, ...args), [
      method,
      args
    ] as const) as Promise<any>;
  async function download(path = '/bytes') {
    const result = await call('call', 'downloadFile', { url: url + path });
    expect(result.errMsg).toBe('downloadFile:ok');
    return result.tempFilePath as string;
  }

  it('下载后同步和异步读取都保留原始字节，支持 base64，stat 返回字节数', async () => {
    await runner.open('/?path=pages/index/index');
    const filePath = await download();
    expect(await call('read', filePath)).toEqual({ data: [...bytes] });
    expect(await call('read', filePath, 'base64')).toEqual({ data: bytes.toString('base64') });
    expect(await call('callFs', 'readFile', { filePath })).toMatchObject({ data: [...bytes] });
    expect(await call('callFs', 'stat', { path: filePath })).toMatchObject({ stats: { size: bytes.length } });
    expect(await call('callFs', 'access', { path: filePath })).toMatchObject({ errMsg: 'access:ok' });
  });

  it('复制到用户目录后可读取、上传和覆盖；删除后字节缓存和服务器文件一起失效', async () => {
    await runner.open('/?path=pages/index/index');
    const source = await download();
    const destination = (await call('userPath')) + '/实验照片.bin';
    const copy = (srcPath: string) => call('callFs', 'copyFile', { srcPath, destPath: destination });
    expect((await copy(source)).errMsg).toMatch(/:ok$/);
    expect(await call('read', destination)).toEqual({ data: [...bytes] });
    const upload = await call('call', 'uploadFile', { url: url + '/upload', filePath: destination, name: 'photo' });
    expect(upload.errMsg).toBe('uploadFile:ok');
    expect(uploads.at(-1)!.includes(bytes)).toBe(true);

    // 同名文件覆盖后，HTTP 读取也必须拿到新内容，而不是命中旧 ETag。
    const fetchBytes = () => runner.page.evaluate(async path => [...new Uint8Array(await (await fetch(path)).arrayBuffer())], destination);
    expect(await fetchBytes()).toEqual([...bytes]);
    expect((await copy(await download('/reversed'))).errMsg).toMatch(/:ok$/);
    expect(await fetchBytes()).toEqual([...Buffer.from(bytes).reverse()]);
    expect(await call('read', destination)).toEqual({ data: [...Buffer.from(bytes).reverse()] });

    for (const filePath of [source, destination]) {
      expect((await call('callFs', 'unlink', { filePath })).errMsg).toMatch(/:ok$/);
      expect((await call('read', filePath)).data).toBeUndefined();
      expect((await call('callFs', 'readFile', { filePath })).errMsg).toMatch(/:fail/);
      expect((await call('callFs', 'access', { path: filePath })).errMsg).toMatch(/:fail/);
      expect(await runner.page.evaluate(async path => (await fetch(path)).status, filePath)).toBe(404);
    }
    expect((await call('call', 'uploadFile', { url: url + '/upload', filePath: destination })).errMsg).toMatch(/:fail/);
    expect(uploads).toHaveLength(1);
    expect(await runner.page.evaluate(() => window.__wxa_test_api__.errors())).toEqual([]);
  });
});
