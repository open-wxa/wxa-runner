import { describe, expect, it } from 'vitest';
import { proxyFetch } from '../../packages/core/src/server/proxyFetch';

const request = (path = 'https/api.example.com/a%2Fb?q=%C4%E3', init?: RequestInit) =>
  new Request(`https://viewer.example/__wxa__/proxy/${path}`, init);

const echoFetch: typeof fetch = async (input, init) => {
  const outgoing = new Request(input, init);
  const headers: Record<string, string> = {};
  outgoing.headers.forEach((value, name) => {
    headers[name] = value;
  });
  return Response.json({ url: outgoing.url, method: outgoing.method, headers, body: await outgoing.text() });
};

describe('Fetch 代理', () => {
  it('代理保留编码路径、方法和请求体，只转发小程序自定义头', async () => {
    const response = await proxyFetch(
      request(undefined, {
        method: 'POST',
        body: 'payload',
        headers: {
          cookie: 'viewer=secret',
          authorization: 'viewer-secret',
          'x-wxa-headers': JSON.stringify({
            cookie: 'sid=1',
            Referer: 'https://app.example/',
            'User-Agent': 'mini',
            'X-Count': 2,
            'X-Null': null,
            host: 'bad',
            connection: 'close',
            'content-length': '99',
            'transfer-encoding': 'chunked',
            'keep-alive': '1',
            upgrade: 'websocket',
            expect: '100-continue'
          })
        }
      }),
      { fetch: echoFetch }
    );
    expect(await response.json()).toEqual({
      url: 'https://api.example.com/a%2Fb?q=%C4%E3',
      method: 'POST',
      body: 'payload',
      headers: { cookie: 'sid=1', referer: 'https://app.example/', 'user-agent': 'mini', 'x-count': '2' }
    });
  });

  it.each(['{broken', 'null'])('代理忽略无效自定义头 %s', async encoded => {
    const response = await proxyFetch(request(undefined, { headers: { 'x-wxa-headers': encoded } }), { fetch: echoFetch });
    expect((await response.json()).headers).toEqual({});
  });

  it('代理上传 multipart 时保留浏览器生成的 boundary', async () => {
    const response = await proxyFetch(
      request(undefined, {
        method: 'POST',
        body: 'multipart-data',
        headers: { 'content-type': 'multipart/form-data; boundary=browser', 'x-wxa-headers': '{"Content-Type":"multipart/form-data"}' }
      }),
      { fetch: echoFetch }
    );
    expect((await response.json()).headers['content-type']).toBe('multipart/form-data; boundary=browser');
  });

  it('代理编码完整响应头和多条 cookie，并移除失效的传输头', async () => {
    const headers = new Headers({
      'content-encoding': 'gzip',
      'content-length': '100',
      'transfer-encoding': 'chunked',
      connection: 'close',
      'x-upstream': 'quoted, value'
    });
    headers.append('set-cookie', 'a=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT');
    headers.append('set-cookie', 'b=2; Path=/');
    const response = await proxyFetch(request(), { fetch: async () => new Response('decoded', { status: 404, headers }) });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('decoded');
    expect(response.headers.get('content-encoding')).toBeNull();
    expect(response.headers.get('content-length')).toBeNull();
    expect(response.headers.get('transfer-encoding')).toBeNull();
    expect(response.headers.get('connection')).toBeNull();
    expect(response.headers.get('set-cookie')).toBeNull();
    expect(response.headers.get('x-upstream')).toBe('quoted, value');
    expect(JSON.parse(decodeURIComponent(response.headers.get('x-wxa-headers')!))).toMatchObject({
      'content-encoding': 'gzip',
      'content-length': '100'
    });
    expect(JSON.parse(decodeURIComponent(response.headers.get('x-wxa-set-cookie')!))).toEqual([
      'a=1; Expires=Wed, 21 Oct 2030 07:28:00 GMT',
      'b=2; Path=/'
    ]);
  });

  it('代理在上游尚未结束时返回首块数据，并传递后续流错误', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(new TextEncoder().encode('first'));
      }
    });
    const response = await proxyFetch(request(), { fetch: async () => new Response(body) });
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('first');
    controller.error(new Error('upstream disconnected'));
    await expect(reader.read()).rejects.toThrow('upstream disconnected');
  });

  it('代理保留无响应体状态码', async () => {
    const response = await proxyFetch(request(), { fetch: async () => new Response(null, { status: 204 }) });
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it.each(['ftp/example.com/', 'https/example.com:bad/'])('代理拒绝错误目标 %s', async path => {
    const response = await proxyFetch(request(path), {
      fetch: async () => {
        throw new Error('must not fetch');
      }
    });
    expect(response.status).toBe(400);
    expect(response.headers.get('x-wxa-proxy-error')).toBe('1');
    expect(await response.text()).toContain('invalid url');
  });

  it('代理连接失败时返回具体原因', async () => {
    const response = await proxyFetch(request(), {
      fetch: async () => {
        throw { message: 'fetch failed', cause: { message: 'ECONNREFUSED' } };
      }
    });
    expect(response.status).toBe(502);
    expect(response.headers.get('x-wxa-proxy-error')).toBe('1');
    expect(await response.text()).toBe('ECONNREFUSED');
  });

  it('代理拒绝白名单外域名且不发送请求', async () => {
    const visited: string[] = [];
    const response = await proxyFetch(request(), {
      isAllowed: () => false,
      fetch: async input => {
        visited.push(String(input));
        return new Response();
      }
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('api.example.com');
    expect(visited).toEqual([]);
  });

  it('代理逐跳解析相对重定向并阻止跳转到白名单外', async () => {
    const visited: string[] = [];
    const response = await proxyFetch(request(), {
      isAllowed: url => url.hostname === 'api.example.com',
      fetch: async (input, init) => {
        const url = new URL(String(input));
        visited.push(url.pathname);
        expect(init?.redirect).toBe('manual');
        return new Response(null, { status: 302, headers: { location: url.pathname === '/next' ? 'https://blocked.example/' : '/next' } });
      }
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/blocked\.example.*2/);
    expect(visited).toEqual(['/a%2Fb', '/next']);
  });

  it('代理超过 20 跳时终止重定向并说明跳数', async () => {
    const response = await proxyFetch(request(), {
      isAllowed: () => true,
      fetch: async () => new Response(null, { status: 302, headers: { location: '/again' } })
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toMatch(/api\.example\.com.*21/);
  });

  it('代理未设置白名单时保留自动跟随重定向', async () => {
    const response = await proxyFetch(request(), { fetch: async (_input, init) => Response.json({ redirect: init?.redirect }) });
    expect(await response.json()).toEqual({ redirect: 'follow' });
  });

  it.each([307, 308])('代理跟随 %s 跳转时重发方法、请求体和同源凭据', async status => {
    const response = await proxyFetch(
      request(undefined, {
        method: 'POST',
        body: 'payload',
        headers: { 'x-wxa-headers': '{"cookie":"sid=1"}' }
      }),
      {
        isAllowed: () => true,
        fetch: async (input, init) =>
          new URL(String(input)).pathname === '/next'
            ? echoFetch(input, init)
            : new Response(null, { status, headers: { location: '/next' } })
      }
    );
    expect(await response.json()).toMatchObject({ method: 'POST', body: 'payload', headers: { cookie: 'sid=1' } });
  });

  it.each([301, 302, 303])('代理跟随 %s 跳转时将 POST 改为 GET，跨源移除凭据', async status => {
    const response = await proxyFetch(
      request(undefined, {
        method: 'POST',
        body: 'payload',
        headers: { 'x-wxa-headers': '{"cookie":"sid=1","authorization":"Bearer secret","content-type":"application/json"}' }
      }),
      {
        isAllowed: () => true,
        fetch: async (input, init) =>
          new URL(String(input)).hostname === 'next.example.com'
            ? echoFetch(input, init)
            : new Response(null, { status, headers: { location: 'https://next.example.com/' } })
      }
    );
    expect(await response.json()).toMatchObject({ method: 'GET', body: '', headers: {} });
  });

  it('代理将客户端取消信号传给上游', async () => {
    const controller = new AbortController();
    const response = proxyFetch(request(undefined, { signal: controller.signal }), {
      fetch: async (_input, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
          controller.abort();
        })
    });
    expect(await (await response).text()).toBe('cancelled');
  });
});
