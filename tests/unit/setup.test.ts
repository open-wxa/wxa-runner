/**
 * 启动前环境准备（setup）：预置存储、覆盖原生 API、拦截请求、run 兜底
 *
 * 断言都落在小程序可观测的结果上：基础库经 invoke 读到的存储、原生 API 的返回值、请求任务推送的结果。
 */

import { describe, expect, it } from 'vitest';
import { createNetworkApis } from '../../packages/core/src/runtime/host/api/network';
import { ApiRegistry } from '../../packages/core/src/runtime/host/api/registry';
import { RequestRoutes } from '../../packages/core/src/runtime/host/api/routes';
import {
  createStorageApis,
  decodeStorageValue,
  KeyValueStore,
  MiniProgramStorage
} from '../../packages/core/src/runtime/host/api/storage';
import { applySetup, formatSetupSummary } from '../../packages/core/src/runtime/host/setup';
import { defineSetup } from '../../packages/core/src/setup';

function memoryStore(): KeyValueStore {
  const map = new Map<string, string>();
  return {
    getItem: key => (map.has(key) ? map.get(key)! : null),
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
    key: index => [...map.keys()][index] ?? null,
    get length() {
      return map.size;
    }
  };
}

function createTarget() {
  const storage = new MiniProgramStorage(memoryStore(), 'wxtest');
  const routes = new RequestRoutes();
  const api = new ApiRegistry();
  const events: Array<{ event: string; data: any }> = [];
  api.register(createStorageApis(storage));
  api.register(createNetworkApis({ emit: (event, data) => events.push({ event, data }), defaultTimeout: () => 1000, routes }));
  const invoke = (name: string, args: object = {}) => api.invoke(name, args, { api: name, from: 'service', webviewId: 1 });
  /** 小程序里 wx.request 最终拿到的结果：基础库按任务 id 收集 success / fail 事件 */
  const request = async (args: { url: string; method?: string; data?: unknown; header?: Record<string, string>; responseType?: string }) => {
    const { requestTaskId } = invoke('createRequestTask', args) as any;
    for (let i = 0; i < 200; i++) {
      const done = events.find(e => e.data.requestTaskId === requestTaskId && ['success', 'fail'].includes(e.data.state));
      if (done) return done.data;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    throw new Error('请求没有结束');
  };
  /** 小程序里 wx.getStorageSync(key) 拿到的值：基础库按 dataType 还原 invoke 结果 */
  const readStorage = (key: string) => {
    const result = invoke('getStorageSync', { key }) as any;
    return result.errMsg.endsWith(':ok') ? decodeStorageValue(result) : undefined;
  };
  return { target: { storage, api, routes }, invoke, readStorage, request, events };
}

describe('setup 预置存储', () => {
  it('小程序读到的存储值保持原本的类型', async () => {
    const { target, readStorage } = createTarget();
    const loginAt = new Date('2026-01-01T00:00:00Z');

    await applySetup(defineSetup({
      storage: { token: 'abc', userInfo: { id: 1, tags: ['a'] }, count: 3, vip: false, loginAt, empty: null }
    }), target, {});

    expect(readStorage('token')).toBe('abc');
    expect(readStorage('userInfo')).toEqual({ id: 1, tags: ['a'] });
    expect(readStorage('count')).toBe(3);
    expect(readStorage('vip')).toBe(false);
    expect(readStorage('loginAt')).toEqual(loginAt);
    expect(readStorage('empty')).toBeNull();
  });

  it('预置值覆盖同名旧值，其他已有数据保留', async () => {
    const { target, invoke, readStorage } = createTarget();
    invoke('setStorageSync', { key: 'token', data: 'expired', dataType: 'String' });
    invoke('setStorageSync', { key: 'cart', data: '[1]', dataType: 'Array' });

    await applySetup({ storage: { token: 'fresh' } }, target, {});

    expect(readStorage('token')).toBe('fresh');
    expect(readStorage('cart')).toEqual([1]);
  });

  it('存储值是函数等无法序列化的类型时报错并指出 key', async () => {
    const { target } = createTarget();
    await expect(applySetup({ storage: { token: () => 'x' } as any }, target, {})).rejects.toThrow(/storage\.token/);
  });
});

describe('setup 覆盖原生 API', () => {
  it('wx.login 返回 setup 里给定的 code', async () => {
    const { target, invoke } = createTarget();
    await applySetup({ mock: { login: { code: 'dev_code' } } }, target, {});
    expect(invoke('login')).toEqual({ code: 'dev_code', errMsg: 'login:ok' });
  });

  it('函数形式的 mock 按调用参数返回，抛错即调用失败', async () => {
    const { target, invoke } = createTarget();
    await applySetup({
      mock: {
        getLocation: (args: any) => ({ latitude: args.type === 'gcj02' ? 31.23 : 0, longitude: 121.47 }),
        requestPayment: () => {
          throw new Error('余额不足');
        }
      }
    }, target, {});

    expect(invoke('getLocation', { type: 'gcj02' })).toMatchObject({ latitude: 31.23, errMsg: 'getLocation:ok' });
    expect(invoke('requestPayment')).toEqual({ errMsg: 'requestPayment:fail 余额不足' });
  });

  it('mock wx.request 这类经内部任务实现的 API 时报错，提示改用请求拦截', async () => {
    const { target } = createTarget();
    await expect(applySetup({ mock: { request: { data: {} } } }, target, {})).rejects.toThrow(/request.*请求拦截/);
  });

  it('mock 存储 API 时报错，提示改用 storage', async () => {
    const { target } = createTarget();
    await expect(applySetup({ mock: { getStorageSync: { data: 'x' } } }, target, {})).rejects.toThrow(/storage/);
  });
});

describe('setup 拦截请求', () => {
  const LOGIN = 'https://api.example.com/api/seed/fmmatch/auth/login';

  it('小程序请求被拦截的接口时，拿到 setup 给定的响应', async () => {
    const { target, request } = createTarget();
    await applySetup({
      network: { routes: { 'POST **/auth/login': { body: { code: 200, data: { token: 't-1' } } } } }
    }, target, {});

    const res = await request({ url: LOGIN + '?from=launch', method: 'POST', data: '{"code":"x"}' });
    expect(res.state).toBe('success');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.data)).toEqual({ code: 200, data: { token: 't-1' } });
  });

  it('函数形式的拦截按请求内容返回响应，可以指定状态码', async () => {
    const { target, request } = createTarget();
    await applySetup(defineSetup({
      network: {
        routes: {
          '**/auth/login': req => ({ status: 201, body: { method: req.method, sent: JSON.parse(String(req.data)) } })
        }
      }
    }), target, {});

    const res = await request({ url: LOGIN, method: 'POST', data: '{"code":"abc"}' });
    expect(res.statusCode).toBe(201);
    expect(JSON.parse(res.data)).toEqual({ method: 'POST', sent: { code: 'abc' } });
  });

  it('请求方法或地址对不上的请求不被拦截，照常发往网络', async () => {
    const { target, request } = createTarget();
    await applySetup({ network: { routes: { 'POST **/auth/login': { body: {} } } } }, target, {});

    // 单元测试里没有开发服务器，真正发出的请求会失败
    expect((await request({ url: LOGIN, method: 'GET' })).state).toBe('fail');
    expect((await request({ url: 'https://api.example.com/auth/login/extra', method: 'POST' })).state).toBe('fail');
  });

  it('* 只匹配一段路径，** 匹配任意层级', async () => {
    const { target, request } = createTarget();
    await applySetup({ network: { routes: { 'https://api.example.com/*/user': { body: 'one' } } } }, target, {});

    expect((await request({ url: 'https://api.example.com/v1/user' })).data).toBe('one');
    expect((await request({ url: 'https://api.example.com/v1/v2/user' })).state).toBe('fail');
  });

  it('拦截规则的 body 是 ArrayBuffer 或 Uint8Array（包括 Node 的 Buffer）时，小程序按 arraybuffer 请求拿到同样的字节', async () => {
    const { target, request } = createTarget();
    await applySetup({
      network: {
        routes: {
          '**/avatar.png': { body: new Uint8Array([0x89, 0x50, 0xff, 0x00]).buffer },
          // Node 的小 Buffer 共用一块内存，只占其中一段
          '**/user.pb': { body: Buffer.from([0x08, 0x96, 0x01]) }
        }
      }
    }, target, {});

    const avatar = await request({ url: 'https://cdn.example.com/avatar.png', responseType: 'arraybuffer' });
    expect(avatar.data).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(avatar.data)).toEqual(new Uint8Array([0x89, 0x50, 0xff, 0x00]));
    const user = await request({ url: 'https://api.example.com/user.pb', responseType: 'arraybuffer' });
    expect(new Uint8Array(user.data)).toEqual(new Uint8Array([0x08, 0x96, 0x01]));
  });

  it('小程序按 arraybuffer 请求、拦截规则给的是对象时，拿到 JSON 文本的 UTF-8 字节', async () => {
    const { target, request } = createTarget();
    await applySetup({ network: { routes: { '**/config': { body: { name: '小程序' } } } } }, target, {});

    const res = await request({ url: 'https://api.example.com/config', responseType: 'arraybuffer' });
    expect(res.data).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(res.data)).toBe('{"name":"小程序"}');
  });

  it('拦截规则的 body 是二进制（如读进来的 JSON 文件）、小程序按默认的文本请求时，拿到解码后的文本', async () => {
    const { target, request } = createTarget();
    await applySetup({ network: { routes: { '**/config': { body: new TextEncoder().encode('{"name":"小程序"}') } } } }, target, {});

    expect((await request({ url: 'https://api.example.com/config' })).data).toBe('{"name":"小程序"}');
  });

  it('拦截规则可以模拟网络延迟，响应过了指定时间才到', async () => {
    const { target, request } = createTarget();
    await applySetup({ network: { routes: { 'POST **/auth/login': { delay: 100, body: { ok: true } } } } }, target, {});

    const start = Date.now();
    const res = await request({ url: LOGIN, method: 'POST' });
    expect(res.state).toBe('success');
    // 计时器可能提前 1ms 左右触发
    expect(Date.now() - start).toBeGreaterThanOrEqual(95);
  });

  it('delay 为 0 的拦截规则正常响应', async () => {
    const { target, request } = createTarget();
    await applySetup({ network: { routes: { '**/auth/login': { delay: 0, body: { ok: true } } } } }, target, {});

    expect(JSON.parse((await request({ url: LOGIN })).data)).toEqual({ ok: true });
  });

  it('延迟中的请求被 abort 时以失败结束', async () => {
    const { target, invoke, events } = createTarget();
    await applySetup({ network: { routes: { '**/auth/login': { delay: 200, body: {} } } } }, target, {});

    const { requestTaskId } = invoke('createRequestTask', { url: LOGIN }) as any;
    await new Promise(resolve => setTimeout(resolve, 20));
    invoke('operateRequestTask', { requestTaskId, operationType: 'abort' });
    await new Promise(resolve => setTimeout(resolve, 20));

    const states = events.filter(e => e.data.requestTaskId === requestTaskId).map(e => e.data);
    expect(states).toEqual([expect.objectContaining({ state: 'fail', errMsg: 'request:fail abort' })]);
  });

  it('run 里也能添加拦截', async () => {
    const { target, request } = createTarget();
    await applySetup(defineSetup({
      run(wxa) {
        wxa.route('GET https://api.example.com/me', { body: { name: wxa.env.WXA_NAME } });
      }
    }), target, { WXA_NAME: 'dev' });

    expect(JSON.parse((await request({ url: 'https://api.example.com/me' })).data)).toEqual({ name: 'dev' });
  });

  it('拦截规则写错时报错并指出是哪一条', async () => {
    const { target } = createTarget();
    await expect(applySetup({ network: { routes: { 'FETCH https://a.com/x': { body: {} } } } } as any, target, {}))
      .rejects.toThrow(/network\.routes\["FETCH https:\/\/a\.com\/x"\]/);
    await expect(applySetup({ network: { rotes: {} } } as any, target, {})).rejects.toThrow(/rotes.*routes/);
    await expect(applySetup({ network: { routes: { '**/x': { delay: -1 } } } }, target, {})).rejects.toThrow(/delay/);
    await expect(applySetup({ network: { routes: { '**/x': '{"ok":true}' } } } as any, target, {})).rejects.toThrow(/响应对象/);
  });
});

describe('setup 的写法', () => {
  it('函数形式的 setup 能拿到环境变量', async () => {
    const { target, readStorage } = createTarget();
    await applySetup(defineSetup(({ env }) => ({ storage: { token: env.WXA_TOKEN } })), target, { WXA_TOKEN: 't-123' });
    expect(readStorage('token')).toBe('t-123');
  });

  it('run 在声明式配置之后执行，异步完成后 setup 才算结束', async () => {
    const { target, invoke, readStorage } = createTarget();
    await applySetup(defineSetup({
      storage: { token: 'from-config' },
      mock: { login: { code: 'from-config' } },
      async run(wxa) {
        await new Promise(resolve => setTimeout(resolve, 10));
        wxa.storage.set('token', `${wxa.storage.get('token')}+run`);
        wxa.mock('login', { code: wxa.env.WXA_CODE! });
      }
    }), target, { WXA_CODE: 'from-run' });

    expect(readStorage('token')).toBe('from-config+run');
    expect(invoke('login')).toMatchObject({ code: 'from-run' });
  });

  it('写错的配置项直接报错，并列出可用的配置项', async () => {
    const { target } = createTarget();
    await expect(applySetup({ storge: { token: 'x' } } as any, target, {})).rejects.toThrow(/storge.*storage, mock, network, run/);
  });

  it('setup 默认导出不是对象或函数时报错', async () => {
    const { target } = createTarget();
    await expect(applySetup(undefined, target, {})).rejects.toThrow(/export default/);
  });
});

describe('setup 执行摘要', () => {
  it('列出预置的存储 key 和覆盖的 API，包括 run 里做的', async () => {
    const { target } = createTarget();
    const summary = await applySetup(defineSetup({
      storage: { token: 'x', userInfo: {} },
      mock: { login: { code: 'c' } },
      network: { routes: { 'POST **/auth/login': { body: {} } } },
      run(wxa) {
        wxa.mock('getLocation', { latitude: 0, longitude: 0 });
      }
    }), target, {});

    const text = formatSetupSummary(summary);
    expect(text).toMatch(/storage\s+token, userInfo/);
    expect(text).toMatch(/mock\s+login, getLocation/);
    expect(text).toMatch(/network\s+POST \*\*\/auth\/login/);
  });
});
