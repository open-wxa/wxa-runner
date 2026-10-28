/**
 * 部署出去的查看器转发 wx.request 用的处理函数（packages/viewer/src/proxy.ts）：只转发白名单里的域名，和平台无关
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProxyHandler, isAllowedHost, PROXY_PATH } from '../../../packages/viewer/src/proxy';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('转发的域名白名单', () => {
  it.each([
    ['api.example.com', 'api.example.com', true],
    ['API.EXAMPLE.COM', ' other.com, api.example.com ', true],
    ['api.example.com', ['other.com', 'api.example.com'], true],
    ['example.com', '*.example.com', false],
    ['api.example.com', '*.example.com', true],
    ['a.b.example.com', '*.example.com', true],
    ['evil-example.com', '*.example.com', false],
    ['example.com.evil.com', '*.example.com', false],
    ['example.com', '', false],
    ['example.com', ' , ', false],
    ['example.com', '*', false],
    ['example.com', [], false]
  ])('%s 按白名单 %j 判断为 %s', (host, patterns, allowed) => {
    expect(isAllowedHost(host, patterns as string | string[])).toBe(allowed);
  });
});

describe('转发处理函数', () => {
  it('转发白名单里的目标，保留编码过的路径', async () => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => new Response(String(input)));
    const proxy = createProxyHandler({ allowedHosts: ['*.example.com'] });
    const response = await proxy(new Request(`https://viewer.example${PROXY_PATH}https/api.example.com:8443/a%2Fb`));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('https://api.example.com:8443/a%2Fb');
  });

  it.each([[[]], [''], [' , ']])('白名单为空（%j）时拒绝转发并说明怎么配置', async allowedHosts => {
    const visited: string[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
      visited.push(String(input));
      return new Response();
    });
    const response = await createProxyHandler({ allowedHosts })(new Request(`https://viewer.example${PROXY_PATH}https/api.example.com/`));
    expect(response.status).toBe(403);
    expect(response.headers.get('x-wxa-proxy-error')).toBe('1');
    expect(await response.text()).toContain('allowedHosts');
    expect(visited).toEqual([]);
  });

  it('拒绝白名单外的目标，不访问上游', async () => {
    const visited: string[] = [];
    vi.stubGlobal('fetch', async () => {
      visited.push('upstream');
      return new Response();
    });
    const response = await createProxyHandler({ allowedHosts: 'allowed.example' })(new Request(`https://viewer.example${PROXY_PATH}https/blocked.example/`));
    expect(response.status).toBe(403);
    expect(await response.text()).toContain('blocked.example');
    expect(visited).toEqual([]);
  });

  it('路径不是转发地址时返回 404，不访问上游', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const response = await createProxyHandler({ allowedHosts: 'api.example.com' })(new Request('https://viewer.example/index.html'));
    expect(response.status).toBe(404);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
