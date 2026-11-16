/**
 * 开发者工具登录态的接口：开发服务器带着开发者 ticket 向微信换取 code 和手机号
 *
 * 微信服务器用 fetch 桩代替，响应格式取自对微信服务器的实测；
 * 访问本地接口用 http.request，才能自定义 Host 头。
 */

import http from 'http';
import { AddressInfo } from 'net';
import express from 'express';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { DeveloperTicket, TICKET_ENV } from '../../packages/extractor/src/devtools';
import { devtoolsLoginRouter } from '../../packages/core/src/server/devtoolsLogin';
import { collectSetupEnv } from '../../packages/core/src/server/setup';

const LATER = Date.now() + 3600_000;
/** wx.serviceMarket.invokeService 经基础库交给原生 operateWXData 的 data，取自实测 */
const SERVICE_MARKET_REQUEST = {
  api_name: 'webapi_servicemarket_jsapi_comm',
  data: { service_id: 'wxcae50ba710ca29d3', api_name: 'jokebot', data: '{"mode":2}', client_msg_id: '0.5_1', version: 1 },
  operate_directly: false,
  env: 1
};
/** jsoperatewxdata 成功时 data 是 JSON 文本，里面的 data 才是服务市场的结果，取自实测 */
const SERVICE_MARKET_DATA = JSON.stringify({
  data: JSON.stringify({ request_id: 'req-1', errcode: 0, errmsg: 'ok', scene: 4, data: '{"err_code":0,"data_list":[]}' }),
  err_no: 0
});
const PHONE_DATA = JSON.stringify({ data: '{"mobile":"138****1997"}', encryptedData: 'nW3E', iv: 'A44H', code: 'bb2730' });

let server: http.Server;
let port = 0;
let ticket: DeveloperTicket | null = null;

beforeAll(async () => {
  const app = express();
  app.use('/__wxa__/api', devtoolsLoginRouter('wx-app', () => ticket));
  server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => {
  server.close();
});

afterEach(() => {
  vi.unstubAllGlobals();
  ticket = null;
});

function post(path: string, headers: Record<string, string> = {}, json?: object): Promise<{ status: number; body: any }> {
  return postOn(port, path, headers, json);
}

function postOn(targetPort: number, path: string, headers: Record<string, string> = {}, json?: object): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const allHeaders = json ? { 'content-type': 'application/json', ...headers } : headers;
    const req = http.request({ host: '127.0.0.1', port: targetPort, path: `/__wxa__/api${path}`, method: 'POST', headers: allHeaders }, res => {
      let text = '';
      res.on('data', chunk => (text += chunk));
      res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(json ? JSON.stringify(json) : undefined);
  });
}

/** 把对微信服务器的请求换成固定响应 */
function stubWechat(body: object) {
  const fetchMock = vi.fn(async (..._args: unknown[]) => new Response(JSON.stringify(body)));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('开发者工具登录态的接口', () => {
  it('wx.login：用开发者 ticket 请求 jslogin，返回微信签发的 code', async () => {
    ticket = { newticket: 'a+b&c=d', expiredAt: LATER };
    const fetchMock = stubWechat({ baseresponse: { errcode: 0, errmsg: 'ok' }, code: '0e3LEm' });

    expect(await post('/login')).toEqual({ status: 200, body: { code: '0e3LEm' } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const { pathname, searchParams } = new URL(url);
    expect(pathname).toBe('/wxa-dev-logic/jslogin');
    // ticket 里的 + & = 要编码，否则微信收到的是被截断的 ticket
    expect(searchParams.get('newticket')).toBe('a+b&c=d');
    expect(searchParams.get('appid')).toBe('wx-app');
    expect(JSON.parse(init.body as string)).toEqual({ scope: ['snsapi_base'] });
  });

  it('手机号：按 jsgetuserwxphone 的响应格式解析，data 原样转交给基础库', async () => {
    ticket = { newticket: 't', expiredAt: LATER };
    stubWechat({ BaseResponse: { Ret: 0, ErrMsg: { String: '' } }, jsapi_baseresponse: { errcode: 0 }, data: PHONE_DATA });

    const { status, body } = await post('/phone-number');
    expect(status).toBe(200);
    expect(body).toEqual({ data: PHONE_DATA, encryptedData: 'nW3E', iv: 'A44H' });
    expect(JSON.parse(body.data).code).toBe('bb2730');
  });

  it('微信返回错误码时说明原因和处理办法', async () => {
    ticket = { newticket: 't', expiredAt: LATER };
    stubWechat({ baseresponse: { errcode: 40029, errmsg: 'invalid ticket' } });

    const { status, body } = await post('/login');
    expect(status).toBe(500);
    expect(body.error).toBe('微信登录失败 40029: invalid ticket（登录态已失效，请在微信开发者工具里重新登录）');

    // 开发者工具刷新过 ticket，手里的旧 ticket 随即作废
    stubWechat({ baseresponse: { errcode: 40001, errmsg: 'invalid credential, access_token is invalid or not latest' } });
    expect((await post('/login')).body.error).toBe(
      '微信登录失败 40001: invalid credential, access_token is invalid or not latest（登录态已失效，请在微信开发者工具里重新登录）'
    );
  });

  it('连不上微信服务器时报出具体原因', async () => {
    ticket = { newticket: 't', expiredAt: LATER };
    vi.stubGlobal('fetch', async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND servicewechat.com') });
    });

    expect((await post('/login')).body.error).toBe('请求微信服务器失败：getaddrinfo ENOTFOUND servicewechat.com');
  });

  it('没有登录态、登录态过期时提示处理办法，不请求微信', async () => {
    const fetchMock = stubWechat({});

    expect((await post('/login')).body.error).toContain(`未找到微信开发者工具的登录态，请登录开发者工具，或设置环境变量 ${TICKET_ENV}`);
    ticket = { newticket: 't', expiredAt: Date.now() - 1000 };
    expect((await post('/phone-number')).body.error).toBe('微信开发者工具的登录态已过期，请打开开发者工具刷新登录态');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('每次请求重新读取登录态：开发者工具刷新登录后不用重启服务器', async () => {
    stubWechat({ baseresponse: { errcode: 0 }, code: 'fresh' });
    ticket = { newticket: 'old', expiredAt: Date.now() - 1000 };
    expect((await post('/login')).status).toBe(500);

    ticket = { newticket: 'new', expiredAt: LATER };
    expect(await post('/login')).toEqual({ status: 200, body: { code: 'fresh' } });
  });

  it('只允许经本机地址访问：防 DNS rebinding，IPv6 的 [::1] 可以访问', async () => {
    ticket = { newticket: 't', expiredAt: LATER };
    const fetchMock = stubWechat({ baseresponse: { errcode: 0 }, code: 'c' });

    expect(await post('/login', { host: `evil.example:${port}` })).toEqual({ status: 403, body: { error: '开发者登录态接口只允许本机访问' } });
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await post('/login', { host: `[::1]:${port}` })).status).toBe(200);
    expect((await post('/login', { host: `localhost:${port}` })).status).toBe(200);
  });

  it('服务市场：用开发者 ticket 请求 jsoperatewxdata，微信返回的 data 解析后交给基础库', async () => {
    ticket = { newticket: 't', expiredAt: LATER };
    const fetchMock = stubWechat({ baseresponse: { errcode: 0, errmsg: 'ok' }, data: SERVICE_MARKET_DATA });

    expect(await post('/operate-wx-data', {}, { data: SERVICE_MARKET_REQUEST })).toEqual({
      status: 200,
      body: { data: JSON.parse(SERVICE_MARKET_DATA) }
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const { pathname, searchParams } = new URL(url);
    expect(pathname).toBe('/wxa-dev-logic/jsoperatewxdata');
    expect(searchParams.get('appid')).toBe('wx-app');
    // 与开发者工具一致：基础库给的 data 序列化成文本放在 data 字段里
    expect(JSON.parse(JSON.parse(init.body as string).data)).toEqual(SERVICE_MARKET_REQUEST);
  });

  it('服务市场：微信拒绝时说明原因和处理办法', async () => {
    ticket = { newticket: 't', expiredAt: LATER };
    stubWechat({ baseresponse: { errcode: 40001, errmsg: 'invalid credential' } });

    const { status, body } = await post('/operate-wx-data', {}, { data: SERVICE_MARKET_REQUEST });
    expect(status).toBe(500);
    expect(body.error).toBe('服务市场调用失败 40001: invalid credential（登录态已失效，请在微信开发者工具里重新登录）');
  });

  it('只转发服务市场的请求：别的 operateWXData 不会借开发者的登录态发给微信', async () => {
    ticket = { newticket: 't', expiredAt: LATER };
    const fetchMock = stubWechat({ baseresponse: { errcode: 0 }, data: '{}' });

    const { status, body } = await post('/operate-wx-data', {}, { data: { api_name: 'webapi_getuserinfo', data: {} } });
    expect(status).toBe(403);
    expect(body.error).toContain('webapi_getuserinfo');
    expect((await post('/operate-wx-data', {}, {})).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('插件校验：用开发者 ticket 请求 verifyplugin，返回插件能访问的域名', async () => {
    ticket = { newticket: 't', expiredAt: LATER };
    const list = [{ plugin_id: 'wxplugin', request_domain: ['https://api.example.com'], host_sign: 'sign' }];
    const fetchMock = stubWechat({ baseresponse: { errcode: 0 }, list });

    const request = { plugins: [{ provider: 'wxplugin', inner_version: 0 }] };
    expect(await post('/verify-plugin', {}, { data: request })).toEqual({ status: 200, body: { data: { list } } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/wxa-dev-logic/verifyplugin');
    // 与开发者工具一致：基础库给的 data 序列化后放在 ext_info 里
    expect(JSON.parse(JSON.parse(init.body as string).ext_info)).toEqual(request);
  });

  it('插件信息：请求 batchgetcontact，按基础库要的格式交回每个插件的信息', async () => {
    ticket = { newticket: 't', expiredAt: LATER };
    const pluginList = [{ nickname: '快递跟踪', PluginNetWork: { RequestDomain: ['https://api.example.com'] } }];
    const fetchMock = stubWechat({
      baseresponse: { errcode: 0 },
      contact_list: [{ appid: 'wxplugin', plugin_info: { plugin_list: pluginList } }, { appid: 'wxother' }]
    });

    expect(await post('/batch-get-contact', {}, { appIds: ['wxplugin', 'wxother'] })).toEqual({
      status: 200,
      body: { contactList: [{ appId: 'wxplugin', plugin_list: pluginList }] }
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(new URL(url).pathname).toBe('/wxa-dev-logic/batchgetcontact');
    expect(JSON.parse(init.body as string)).toEqual({ appid_list: ['wxplugin', 'wxother'] });
  });

  it('插件校验：微信拒绝时说明原因和处理办法', async () => {
    ticket = { newticket: 't', expiredAt: LATER };
    stubWechat({ baseresponse: { errcode: 40001, errmsg: 'invalid credential' } });

    const { status, body } = await post('/verify-plugin', {}, { data: {} });
    expect(status).toBe(500);
    expect(body.error).toBe('插件校验失败 40001: invalid credential（登录态已失效，请在微信开发者工具里重新登录）');
  });

  it('开发者 ticket 的环境变量不会随 setup 下发给浏览器', () => {
    expect(collectSetupEnv({ [TICKET_ENV]: 'secret', WXA_NAME: 'dev' })).toEqual({ WXA_NAME: 'dev' });
  });
});

describe('三方平台代开发（ext.json）时的 wx.login', () => {
  // 项目 appid 是服务商的模板 appid，模拟器按 ext.json 的 extAppid 运行：jslogin 的 code 属于模板 appid，换不了授权方登录态
  let extServer: http.Server;
  let extPort = 0;
  let simulator: () => Promise<string>;

  beforeAll(async () => {
    const app = express();
    app.use(
      '/__wxa__/api',
      devtoolsLoginRouter('wx-template', () => ({ newticket: 't', expiredAt: LATER }), () => simulator(), { simulatorLogin: true })
    );
    extServer = app.listen(0, '127.0.0.1');
    await new Promise(resolve => extServer.once('listening', resolve));
    extPort = (extServer.address() as AddressInfo).port;
  });

  afterAll(() => {
    extServer.close();
  });

  it('先让开发者工具的模拟器自己调 wx.login，不去问微信 jslogin', async () => {
    simulator = async () => 'code-from-simulator';
    const fetchMock = stubWechat({ baseresponse: { errcode: 0 }, code: 'code-from-jslogin' });

    expect(await postOn(extPort, '/login')).toEqual({ status: 200, body: { code: 'code-from-simulator' } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('模拟器失败时直接报错，jslogin 可用也不退回（它的 code 属于模板 appid）', async () => {
    simulator = async () => {
      throw new Error('微信开发者工具里找不到项目窗口');
    };
    const fetchMock = stubWechat({ baseresponse: { errcode: 0 }, code: 'code-from-jslogin' });

    const { status, body } = await postOn(extPort, '/login');
    expect(status).toBe(500);
    expect(body.error).toContain('项目窗口');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
