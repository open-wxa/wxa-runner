/**
 * 被拦截的 wx.request 在 Network 面板里的响应：Service Worker 向发出请求的页面要拦截规则给出的结果。
 * 开发服务器的 sw.ts 和查看器的 packSw.ts 共用
 */

import { MockQuery, MockReply, toHeaders } from './networkPanel';

export interface MockClient {
  postMessage(message: MockQuery, transfer: Transferable[]): void;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

/** 向发起请求的页面索取拦截响应；页面失效或响应无法表示时让 Network 面板显示请求失败。 */
export async function mockedResponse(client: MockClient | undefined, id: string): Promise<Response> {
  if (!client) return Response.error();
  const reply = await new Promise<MockReply>(resolve => {
    const channel = new MessageChannel();
    channel.port1.onmessage = event => {
      channel.port1.close();
      resolve(event.data);
    };
    client.postMessage({ type: 'wxa-mock-response', id }, [channel.port2]);
  });
  if (!reply) return Response.error();
  try {
    return new Response(NULL_BODY_STATUSES.has(reply.statusCode) ? null : reply.body, {
      status: reply.statusCode,
      headers: toHeaders(reply.header)
    });
  } catch {
    // 小程序允许的部分状态码超出浏览器 Response 能表示的范围。
    return Response.error();
  }
}
