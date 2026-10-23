/**
 * 小程序请求在 Network 面板里的地址：原地址写在开发服务器的路径里
 */

import { describe, expect, it } from 'vitest';
import { fromServerPath, MOCK_PREFIX, PROXY_PREFIX, toServerPath } from '../../packages/core/src/runtime/networkPanel';

describe('请求在 Network 面板里的地址', () => {
  it('协议、域名、路径和查询参数依次写进路径，Name 列显示接口名', () => {
    expect(toServerPath(PROXY_PREFIX, 'https://api.example.com/user/info?id=1')).toBe(
      '/__wxa__/proxy/https/api.example.com/user/info?id=1'
    );
    expect(toServerPath(MOCK_PREFIX, 'http://localhost:8080/')).toBe('/__wxa__/mock/http/localhost:8080/');
  });

  it('路径里的 .. 先解析掉，不会在代理路径上吃掉域名；hash 不发给服务器，丢掉', () => {
    expect(toServerPath(PROXY_PREFIX, 'https://api.example.com/a/../../b#top')).toBe('/__wxa__/proxy/https/api.example.com/b');
  });

  it('不是 http(s) 地址时返回 null', () => {
    for (const url of ['relative/path', 'ftp://example.com/a', 'https://', '']) expect(toServerPath(PROXY_PREFIX, url), url).toBeNull();
  });

  it('开发服务器从路径还原出原地址，编码过的字符保持原样', () => {
    for (const url of [
      'https://api.example.com/user/info?id=1',
      'http://localhost:8080/',
      'https://cdn.example.com/a%2Fb/c%20d?q=%E4%B8%AD'
    ]) {
      expect(fromServerPath(PROXY_PREFIX, toServerPath(PROXY_PREFIX, url)!), url).toBe(url);
    }
  });

  it('还原不出合法的 http(s) 地址时返回 null', () => {
    const paths = [
      '/__wxa__/proxy/ftp/x',
      '/__wxa__/proxy/https/',
      '/__wxa__/proxy/https/api.example.com:badport/a',
      '/__wxa__/mock/https/a.com/'
    ];
    for (const path of paths) expect(fromServerPath(PROXY_PREFIX, path), path).toBeNull();
  });
});
