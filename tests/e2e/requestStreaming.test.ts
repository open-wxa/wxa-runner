import http from 'http';
import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { e2eReady, Runner, startRunner } from './runner';

interface RequestState {
  chunks: { bytes: number[]; arrayBuffer: boolean }[];
  events: string[];
  done: boolean;
  data?: string | number[];
  error?: string;
}

const PAGE_JS = `
Page({
  start(url, options) {
    this.result = { chunks: [], events: [], done: false };
    const result = this.result;
    this.task = wx.request({
      url, enableChunked: true, dataType: 'text', ...options,
      success: res => {
        result.data = res.data instanceof ArrayBuffer ? Array.from(new Uint8Array(res.data)) : res.data;
        result.events.push('success');
      },
      fail: err => { result.error = err.errMsg; result.events.push('fail'); },
      complete: () => { result.done = true; result.events.push('complete'); }
    });
    this.task.onHeadersReceived(() => result.events.push('headers'));
    this.task.onChunkReceived(({ data }) => {
      result.chunks.push({ bytes: Array.from(new Uint8Array(data)), arrayBuffer: data instanceof ArrayBuffer });
      result.events.push('chunk');
    });
  },
  state() { return this.result; },
  abort() { this.task.abort(); }
});
`;

describe.skipIf(!e2eReady)('wx.request 流式响应', () => {
  let runner: Runner;
  let server: http.Server;
  let url: string;
  const responses = new Map<string, http.ServerResponse>();
  const closed = new Set<string>();
  // 前两个字节是不完整的 UTF-8 字符；只有客户端确认收到后，测试才补发剩余字节并结束响应。
  const text = Buffer.from('你好');
  const binary = Buffer.from([0, 0x80, 0xff, 1]);

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const name = req.url!;
      responses.set(name, res);
      res.on('close', () => closed.add(name));
      if (name === '/before-headers') return;
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.write((name === '/binary' ? binary : text).subarray(0, 2));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    runner = await startRunner({
      'app.json': { pages: ['pages/index/index'] },
      'pages/index/index.wxml': '<view>stream</view>',
      'pages/index/index.js': PAGE_JS
    });
  });

  afterAll(async () => {
    await runner?.close();
    server?.closeAllConnections();
    server?.close();
  });

  const call = (method: string, ...args: unknown[]) =>
    runner.page.evaluate(([method, args]) => window.__wxa_test_api__.callPageMethod(method, ...args), [method, args] as const);
  const state = async () => (await call('state')) as RequestState;
  const waitFor = (check: () => Promise<void> | void) => vi.waitFor(check, { timeout: 5000 });
  async function start(name: string, options = {}) {
    await runner.open('/?path=pages/index/index');
    await call('start', url + name, options);
  }

  it.each([
    ['/text', {}, text, '你好'],
    ['/binary', { responseType: 'arraybuffer' }, binary, [...binary]]
  ] as const)('连接结束前收到分块，success 保留完整文本或二进制：%s', async (name, options, bytes, expected) => {
    await start(name, options);
    await waitFor(async () => expect((await state()).chunks).toHaveLength(1));
    const first = await state();
    expect(first.done).toBe(false);
    expect(first.events).toEqual(['headers', 'chunk']);
    expect(first.chunks[0]).toEqual({ bytes: [...bytes.subarray(0, 2)], arrayBuffer: true });

    responses.get(name)!.end(bytes.subarray(2));
    await waitFor(async () => expect((await state()).done).toBe(true));
    const result = await state();
    expect(result.chunks.flatMap((chunk: { bytes: number[] }) => chunk.bytes)).toEqual([...bytes]);
    expect(result.data).toEqual(expected);
    expect(result.events.slice(-2)).toEqual(['success', 'complete']);
  });

  it('收到首块后 abort 会关闭上游，只调用 fail 和 complete', async () => {
    await start('/abort');
    await waitFor(async () => expect((await state()).chunks).toHaveLength(1));
    await call('abort');
    await waitFor(async () => expect((await state()).done).toBe(true));
    expect((await state()).events).toEqual(['headers', 'chunk', 'fail', 'complete']);
    expect((await state()).error).toMatch(/abort/);
    await waitFor(() => expect(closed.has('/abort')).toBe(true));
  });

  it('响应头到达前取消也会关闭上游请求', async () => {
    await start('/before-headers');
    await waitFor(() => expect(responses.has('/before-headers')).toBe(true));
    await call('abort');
    await waitFor(async () => expect((await state()).done).toBe(true));
    expect((await state()).events).toEqual(['fail', 'complete']);
    await waitFor(() => expect(closed.has('/before-headers')).toBe(true));
  });

  it('收到首块后超时会关闭上游，不把部分响应当成成功', async () => {
    await start('/timeout', { timeout: 1500 });
    await waitFor(async () => expect((await state()).chunks).toHaveLength(1));
    await waitFor(async () => expect((await state()).done).toBe(true));
    expect((await state()).events).toEqual(['headers', 'chunk', 'fail', 'complete']);
    await waitFor(() => expect(closed.has('/timeout')).toBe(true));
  });
});
