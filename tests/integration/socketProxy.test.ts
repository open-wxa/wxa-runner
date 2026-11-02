import http from 'http';
import { createHash } from 'crypto';
import { once } from 'events';
import type { AddressInfo, Socket } from 'net';
import { setTimeout as delay } from 'timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { createSocketProxy } from '../../packages/core/src/server/socketProxy';

describe('WebSocket 请求头代理', () => {
  let server: http.Server;
  let proxy: WebSocketServer;
  let upstream: WebSocketServer;
  let origin: string;
  let url: string;
  let target: string;

  beforeEach(async () => {
    proxy = createSocketProxy();
    server = http.createServer();
    server.on('upgrade', (req, socket, head) => proxy.handleUpgrade(req, socket, head, ws => proxy.emit('connection', ws, req)));
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    url = origin.replace('http:', 'ws:');
    upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
    await once(upstream, 'listening');
    target = `ws://127.0.0.1:${(upstream.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    proxy.clients.forEach(socket => socket.terminate());
    upstream.clients.forEach(socket => socket.terminate());
    await Promise.all([
      new Promise<void>(resolve => proxy.close(() => resolve())),
      new Promise<void>(resolve => upstream.close(() => resolve())),
      new Promise<void>(resolve => server.close(() => resolve()))
    ]);
  });

  const connect = async (request: object) => {
    const client = new WebSocket(url, { origin });
    await once(client, 'open');
    client.send(JSON.stringify(request));
    return client;
  };

  it('转发鉴权头和子协议，保留文本/二进制及上游关闭信息', async () => {
    let headers: http.IncomingHttpHeaders = {};
    let protocol = '';
    upstream.on('connection', (socket, req) => {
      headers = req.headers;
      protocol = socket.protocol;
      socket.on('message', (data, binary) => {
        if (!binary && data.toString() === 'close') socket.close(4001, 'finished');
        else socket.send(data, { binary });
      });
    });
    const client = await connect({
      url: target,
      header: { Authorization: 'Bearer example', Cookie: 'session=example' },
      protocols: ['chat']
    });
    expect(JSON.parse((await once(client, 'message'))[0].toString())).toMatchObject({
      ready: true,
      header: { 'sec-websocket-protocol': 'chat' }
    });
    expect(headers).toMatchObject({ authorization: 'Bearer example', cookie: 'session=example' });
    expect(protocol).toBe('chat');
    client.send('hello');
    let [data, binary] = await once(client, 'message');
    expect(data.toString()).toBe('hello');
    expect(binary).toBe(false);
    client.send(Buffer.from([0, 128, 255]));
    [data, binary] = await once(client, 'message');
    expect([...data]).toEqual([0, 128, 255]);
    expect(binary).toBe(true);
    client.send('close');
    const [code, reason] = await once(client, 'close');
    expect(code).toBe(4001);
    expect(reason.toString()).toBe('finished');
  });

  it('客户端关闭时关闭上游', async () => {
    const connection = once(upstream, 'connection');
    const client = await connect({ url: target });
    await once(client, 'message');
    const [socket] = await connection;
    const closed = once(socket, 'close');
    client.close(4002, 'leave');
    const [code, reason] = await closed;
    expect(code).toBe(4002);
    expect(reason.toString()).toBe('leave');
  });

  // 浏览器直连时看到什么，经代理也要看到什么。1005、1006 不能写进关闭帧，靠不带关闭码的 close() 和 terminate() 还原
  it.each([
    ['不带关闭码', (socket: WebSocket) => socket.close(), 1005, ''],
    ['异常断开', (socket: WebSocket) => socket.terminate(), 1006, ''],
    ['以服务器错误', (socket: WebSocket) => socket.close(1011, 'crashed'), 1011, 'crashed'],
    ['带最长的中文原因', (socket: WebSocket) => socket.close(4001, '中'.repeat(41)), 4001, '中'.repeat(41)]
  ])('上游%s关闭时，客户端收到相同的关闭码和原因', async (_name, close, code, reason) => {
    upstream.on('connection', socket => socket.once('message', () => close(socket)));
    const client = await connect({ url: target });
    await once(client, 'message');
    client.send('bye');
    const [closeCode, closeReason] = await once(client, 'close');
    expect(closeCode).toBe(code);
    expect(closeReason.toString()).toBe(reason);
  });

  it.each([
    ['不带关闭码', (client: WebSocket) => client.close(), 1005],
    ['异常断开', (client: WebSocket) => client.terminate(), 1006]
  ])('客户端%s时，上游收到相同的关闭码', async (_name, close, code) => {
    const connection = once(upstream, 'connection');
    const client = await connect({ url: target });
    await once(client, 'message');
    const [socket] = await connection;
    const closed = once(socket, 'close');
    close(client);
    expect((await closed)[0]).toBe(code);
  });

  it('上游正在关闭时客户端断开（如停止开发服务器），立即释放上游连接', async () => {
    // 上游发出关闭帧后不再回应：代理这一侧停在 CLOSING，不主动断开就要等 ws 默认 30 秒的关闭超时
    const lingering = http.createServer();
    let raw!: Socket;
    const halfClosed = new Promise<void>(resolve => {
      lingering.on('upgrade', (req, socket: Socket) => {
        raw = socket;
        const accept = createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
        socket.on('error', () => undefined);
        socket.on('data', () => undefined);
        // 代理回完关闭帧会半关闭连接；http 服务器允许半开，这边不跟着断开
        socket.on('end', resolve);
        socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
        socket.write(Buffer.from([0x88, 2, 0x03, 0xe8]));
      });
    });
    lingering.listen(0, '127.0.0.1');
    await once(lingering, 'listening');
    let poke: NodeJS.Timeout | undefined;
    try {
      const client = await connect({ url: `ws://127.0.0.1:${(lingering.address() as AddressInfo).port}` });
      await once(client, 'message');
      await halfClosed;
      const released = new Promise<boolean>(resolve => raw.on('close', () => resolve(true)));
      proxy.clients.forEach(socket => socket.terminate());
      // 代理已经断开的话，继续往这条连接写数据会收到 RST，连接随之关闭
      poke = setInterval(() => raw.write(Buffer.from([0x89, 0])), 20);
      expect(await Promise.race([released, delay(1000).then(() => false)])).toBe(true);
    } finally {
      clearInterval(poke);
      raw?.destroy();
      await new Promise<void>(resolve => lingering.close(() => resolve()));
    }
  });

  it('错误协议不能打开上游连接', async () => {
    const client = await connect({ url: 'http://127.0.0.1/' });
    expect((await once(client, 'close'))[0]).toBe(1008);
    expect(upstream.clients.size).toBe(0);
  });

  it('拒绝其他网站和没有 Origin 的连接', async () => {
    for (const source of ['https://example.com', undefined]) {
      const client = new WebSocket(url, source ? { origin: source } : {});
      const [error] = await once(client, 'error');
      expect(error.message).toContain('401');
    }
  });

  it.each(['timeout', 'cancel'])('上游握手等待中 %s 后断开上游连接', async mode => {
    const stalled = http.createServer();
    let connected!: () => void;
    const accepted = new Promise<void>(resolve => {
      connected = resolve;
    });
    let disconnected!: () => void;
    const closed = new Promise<void>(resolve => {
      disconnected = resolve;
    });
    stalled.on('upgrade', (_req, socket) => {
      socket.on('error', () => undefined);
      socket.on('end', () => socket.end());
      socket.on('close', disconnected);
      connected();
    });
    stalled.listen(0, '127.0.0.1');
    await once(stalled, 'listening');
    try {
      const client = await connect({
        url: `ws://127.0.0.1:${(stalled.address() as AddressInfo).port}`,
        timeout: mode === 'timeout' ? 100 : 60000
      });
      await accepted;
      const clientClosed = once(client, 'close');
      if (mode === 'cancel') client.close();
      expect((await clientClosed)[0]).toBe(mode === 'timeout' ? 1006 : 1005);
      await closed;
    } finally {
      await new Promise<void>(resolve => stalled.close(() => resolve()));
    }
  });

  it('上游拒绝握手时不发送 ready', async () => {
    const rejecting = http.createServer((_req, res) => {
      res.writeHead(401);
      res.end();
    });
    rejecting.listen(0, '127.0.0.1');
    await once(rejecting, 'listening');
    try {
      const client = await connect({ url: `ws://127.0.0.1:${(rejecting.address() as AddressInfo).port}` });
      const messages: unknown[] = [];
      client.on('message', data => messages.push(data));
      expect((await once(client, 'close'))[0]).toBe(1006);
      expect(messages).toEqual([]);
    } finally {
      await new Promise<void>(resolve => rejecting.close(() => resolve()));
    }
  });
});
