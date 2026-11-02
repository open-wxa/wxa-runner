/**
 * 浏览器不能给 WebSocket 握手设置自定义请求头。连接本地代理后，首帧传入目标和请求头，
 * 上游握手成功才回 ready；随后逐帧转发原始文本/二进制消息。凭据不进入 URL 或日志。
 */
import { WebSocket, WebSocketServer, type VerifyClientCallbackSync } from 'ws';

/**
 * 把一端的关闭原样转给另一端，小程序看到的关闭码和浏览器直连时一致。
 * 1005、1006、1015 不能写进关闭帧：不带关闭码的 close() 到对端就是 1005，terminate() 到对端就是 1006
 */
function mirrorClose(to: WebSocket, code: number, reason: Buffer) {
  if (code === 1005) to.close();
  else if (code === 1006 || code === 1015) to.terminate();
  else to.close(code, reason);
}

export function createSocketProxy(): WebSocketServer {
  const server = new WebSocketServer({
    noServer: true,
    // 不能让其他网站借本地开发服务器建立任意带凭据的连接。
    verifyClient: ({ origin, req }: Parameters<VerifyClientCallbackSync>[0]) => origin === `http://${req.headers.host}`
  });
  server.on('connection', client => {
    let upstream: WebSocket | undefined;
    const timer = setTimeout(() => client.close(1008, 'Missing socket request'), 10000);
    timer.unref();
    client.on('error', () => undefined);
    client.once('message', (data, binary) => {
      clearTimeout(timer);
      try {
        if (binary || data.toString().length > 64 * 1024) throw new Error('Invalid socket request');
        const { url, header, protocols, timeout } = JSON.parse(data.toString());
        const target = new URL(url);
        if (!['ws:', 'wss:'].includes(target.protocol) || target.username || target.password) throw new Error('Invalid socket URL');
        upstream = new WebSocket(target, protocols || [], {
          headers: header || {},
          handshakeTimeout: typeof timeout === 'number' && timeout > 0 ? timeout : 60000
        });
      } catch {
        client.close(1008, 'Invalid socket request');
        return;
      }
      const socket = upstream;
      let header = {};
      socket.on('upgrade', response => {
        header = response.headers;
      });
      socket.on('open', () => {
        if (client.readyState !== WebSocket.OPEN) {
          socket.close();
          return;
        }
        client.send(JSON.stringify({ ready: true, header }));
      });
      socket.on('message', (message, isBinary) => {
        if (client.readyState === WebSocket.OPEN) client.send(message, { binary: isBinary });
      });
      client.on('message', (message, isBinary) => {
        if (socket.readyState === WebSocket.OPEN) socket.send(message, { binary: isBinary });
      });
      // 握手被拒、超时和连接中断，直连时浏览器看到的都是 1006
      socket.on('error', () => client.terminate());
      socket.on('close', (code, reason) => {
        if (client.readyState === WebSocket.OPEN) mirrorClose(client, code, reason);
      });
    });
    client.on('close', (code, reason) => {
      clearTimeout(timer);
      if (upstream?.readyState === WebSocket.OPEN) mirrorClose(upstream, code, reason);
      // 握手中或正在关闭的上游直接断开：CLOSING 时等对方回应最长要 30 秒，停止开发服务器时不能留着它
      else if (upstream) upstream.terminate();
    });
  });
  return server;
}
