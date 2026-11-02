import type { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WebSocketServer, type VerifyClientCallbackSync } from 'ws';
import { e2eReady, Runner, startRunner } from './runner';

const PAGE_JS = `
Page({
  connect(url, token) {
    return new Promise(resolve => {
      const result = { opened: false, messages: [], errors: [] };
      const task = wx.connectSocket({ url, header: { Authorization: token }, protocols: ['chat'], complete() {} });
      task.onOpen(event => {
        result.opened = true;
        result.protocol = event.header['sec-websocket-protocol'];
        task.send({ data: 'hello' });
        task.send({ data: new Uint8Array([0, 128, 255]).buffer });
      });
      task.onMessage(({ data }) => {
        result.messages.push(data instanceof ArrayBuffer ? Array.from(new Uint8Array(data)) : data);
        if (result.messages.length === 2) task.close({ code: 4001, reason: 'done' });
      });
      task.onError(error => result.errors.push(error.errMsg));
      task.onClose(({ code, reason }) => resolve({ ...result, code, reason }));
    });
  }
});
`;

describe.skipIf(!e2eReady)('wx.connectSocket 的自定义请求头', () => {
  let runner: Runner;
  let sockets: WebSocketServer;
  let url: string;

  beforeAll(async () => {
    sockets = new WebSocketServer({
      host: '127.0.0.1',
      port: 0,
      verifyClient: ({ req }: Parameters<VerifyClientCallbackSync>[0]) => req.headers.authorization === 'Bearer example'
    });
    await new Promise<void>(resolve => sockets.on('listening', resolve));
    sockets.on('connection', socket => socket.on('message', (data, binary) => socket.send(data, { binary })));
    url = `ws://127.0.0.1:${(sockets.address() as AddressInfo).port}`;
    runner = await startRunner({
      'app.json': { pages: ['pages/index/index'] },
      'pages/index/index.wxml': '<view>socket headers</view>',
      'pages/index/index.js': PAGE_JS
    });
  });

  afterAll(async () => {
    await runner?.close();
    sockets?.clients.forEach(socket => socket.terminate());
    sockets?.close();
  });

  it('真实基础库连接带鉴权的 WS，收发文本/二进制并正常关闭', async () => {
    await runner.open('/?path=pages/index/index');
    const result = await runner.page.evaluate(url => window.__wxa_test_api__.callPageMethod('connect', url, 'Bearer example'), url);
    expect(result).toEqual({ opened: true, protocol: 'chat', messages: ['hello', [0, 128, 255]], errors: [], code: 4001, reason: 'done' });
    expect(await runner.page.evaluate(() => window.__wxa_test_api__.errors())).toEqual([]);
  });

  it('鉴权失败触发 error / close，不能把连上代理误报成上游连接成功', async () => {
    await runner.open('/?path=pages/index/index');
    const result = await runner.page.evaluate(url => window.__wxa_test_api__.callPageMethod('connect', url, 'invalid'), url);
    expect(result).toMatchObject({ opened: false, messages: [], errors: ['connectSocket:fail'], code: 1011 });
  });
});
