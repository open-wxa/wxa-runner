/**
 * 浏览器端运行时中与 DOM 无关的逻辑
 */

import { describe, expect, it } from 'vitest';
import { FileStore } from '../../packages/core/src/server/FileStore';
import { ApiContext, ApiRegistry } from '../../packages/core/src/runtime/host/api/registry';
import { createStorageApis, KeyValueStore, MiniProgramStorage } from '../../packages/core/src/runtime/host/api/storage';
import { PageStack } from '../../packages/core/src/runtime/host/PageStack';

class MemoryStore implements KeyValueStore {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  getItem(key: string) { return this.map.get(key) ?? null; }
  setItem(key: string, value: string) { this.map.set(key, value); }
  removeItem(key: string) { this.map.delete(key); }
}

const context = { api: 'test', from: 'service' as const, webviewId: 1 };

describe('PageStack', () => {
  it('最多 10 层，超出时拒绝', () => {
    const stack = new PageStack<number>();
    for (let i = 0; i < 10; i++) stack.push(i);
    expect(stack.canPush()).toBe(false);
    expect(() => stack.push(10)).toThrow('webview count limit exceed');
  });

  it('返回时至少保留栈底页面，被弹出的页面按栈顶在前返回', () => {
    const stack = new PageStack<string>();
    ['a', 'b', 'c'].forEach(p => stack.push(p));
    expect(stack.pop(5)).toEqual(['c', 'b']);
    expect(stack.entries()).toEqual(['a']);
    expect(stack.pop()).toEqual([]);
  });

  it('replaceTop 替换栈顶，reset 清空并返回原有页面', () => {
    const stack = new PageStack<string>();
    stack.push('a');
    stack.push('b');
    expect(stack.replaceTop('c')).toBe('b');
    expect(stack.entries()).toEqual(['a', 'c']);
    expect(stack.reset('a')).toEqual(['c']);
    expect(stack.entries()).toEqual(['a']);
  });
});

describe('ApiRegistry', () => {
  it('处理函数没有返回 errMsg 时补上 :ok', () => {
    const registry = new ApiRegistry();
    registry.register({ foo: () => ({ value: 1 }), bar: () => undefined });
    expect(registry.invoke('foo', {}, context)).toEqual({ value: 1, errMsg: 'foo:ok' });
    expect(registry.invoke('bar', {}, context)).toEqual({ errMsg: 'bar:ok' });
  });

  it('同步结果同步返回，异步结果返回 Promise', async () => {
    const registry = new ApiRegistry();
    registry.register({ later: async () => ({ v: 2 }) });
    const result = registry.invoke('later', {}, context);
    expect(result).toBeInstanceOf(Promise);
    await expect(result).resolves.toEqual({ v: 2, errMsg: 'later:ok' });
  });

  it('抛出的异常和 rejected Promise 都转换为 :fail', async () => {
    const registry = new ApiRegistry();
    registry.register({
      boom: () => { throw new Error('bad'); },
      reject: () => Promise.reject(new Error('nope'))
    });
    expect(registry.invoke('boom', {}, context)).toEqual({ errMsg: 'boom:fail bad' });
    await expect(registry.invoke('reject', {}, context)).resolves.toEqual({ errMsg: 'reject:fail nope' });
  });

  it('mock 优先于内置实现，可以传对象或函数，unmock 后恢复', () => {
    const registry = new ApiRegistry();
    registry.register({ login: () => ({ code: 'real' }) });
    registry.mock('login', { code: 'mocked' });
    expect(registry.invoke('login', {}, context)).toEqual({ code: 'mocked', errMsg: 'login:ok' });
    registry.mock('login', args => ({ code: args.prefix + '-fn' }));
    expect(registry.invoke('login', { prefix: 'x' }, context)).toMatchObject({ code: 'x-fn' });
    registry.unmock('login');
    expect(registry.invoke('login', {}, context)).toMatchObject({ code: 'real' });
  });

  it('未实现的 API 默认返回成功，避免业务代码中断', () => {
    expect(new ApiRegistry().invoke('reportIDKey', {}, context)).toEqual({ errMsg: 'reportIDKey:ok' });
  });

  it('未实现的 API 上报调用来源，渲染层先调用过不影响之后逻辑层调用的上报', () => {
    const reported: ApiContext[] = [];
    const registry = new ApiRegistry(unimplemented => reported.push(unimplemented));
    const fromWebview = { api: 'getVolume', from: 'webview' as const, webviewId: 2 };
    const fromService = { api: 'getVolume', from: 'service' as const, webviewId: 2 };
    registry.invoke('getVolume', {}, fromWebview);
    registry.invoke('getVolume', {}, fromService);
    expect(reported).toEqual([fromWebview, fromService]);
  });

  it('基础库内部的上报类接口和 mock 过的 API 不算未实现', () => {
    const reported: ApiContext[] = [];
    const registry = new ApiRegistry(unimplemented => reported.push(unimplemented));
    registry.mock('chooseImage', { tempFilePaths: ['a.png'] });
    registry.invoke('reportIDKey', {}, { ...context, api: 'reportIDKey' });
    registry.invoke('chooseImage', {}, { ...context, api: 'chooseImage' });
    registry.invoke('addPhoneContact', {}, { ...context, api: 'addPhoneContact' });
    expect(reported.map(unimplemented => unimplemented.api)).toEqual(['addPhoneContact']);
  });
});

describe('Storage', () => {
  const storage = new MiniProgramStorage(new MemoryStore(), 'wx1');
  const apis = createStorageApis(storage);
  const call = (api: string, args: object) => apis[api](args, { ...context, api }) as Record<string, any>;

  it('按 storageId 隔离，原样保存基础库序列化后的数据和类型', () => {
    call('setStorageSync', { key: 'k', data: '{"a":1}', dataType: 'Object', storageId: 0 });
    call('setStorageSync', { key: 'k', data: 'internal', dataType: 'String', storageId: 3 });
    expect(call('getStorageSync', { key: 'k', storageId: 0 })).toMatchObject({ data: '{"a":1}', dataType: 'Object' });
    expect(call('getStorageSync', { key: 'k', storageId: 3 })).toMatchObject({ data: 'internal' });
  });

  it('读取不存在的 key 返回 fail', () => {
    expect(call('getStorage', { key: 'missing' })).toEqual({ errMsg: 'getStorage:fail data not found' });
  });

  it('info 只统计当前 storageId 的 key，clear 只清当前 storageId', () => {
    expect(storage.info('s0').keys).toEqual(['k']);
    call('clearStorageSync', { storageId: 0 });
    expect(storage.info('s0').keys).toEqual([]);
    expect(storage.info('s3').keys).toEqual(['k']);
  });

  it('不同 appid 的数据互不可见', () => {
    const store = new MemoryStore();
    new MiniProgramStorage(store, 'a').set('s0', 'k', '1');
    expect(new MiniProgramStorage(store, 'b').get('s0', 'k')).toBeNull();
  });
});

describe('FileStore', () => {
  it('支持 USER_DATA_PATH 风格的路径，递归创建目录后读写文件', () => {
    const fs = new FileStore();
    fs.mkdir('http://usr/logs/a', true);
    fs.write('http://usr/logs/a/1.log', 'x');
    fs.write('http://usr/logs/a/1.log', 'y', true);
    expect(fs.read('http://usr/logs/a/1.log').toString()).toBe('xy');
    expect(fs.readdir('http://usr/logs')).toEqual(['a']);
  });

  it('父目录不存在、重复创建、删除非空目录时报错', () => {
    const fs = new FileStore();
    expect(() => fs.write('/a/b.txt', '')).toThrow('no such file or directory');
    fs.mkdir('/a');
    expect(() => fs.mkdir('/a')).toThrow('already exists');
    fs.write('/a/b.txt', '1');
    expect(() => fs.remove('/a', { dir: true })).toThrow('not empty');
    fs.remove('/a', { dir: true, recursive: true });
    expect(fs.stat('/a/b.txt')).toBeUndefined();
  });

  it('预先创建的目录和它们的上级目录不能 rmdir，其中的子目录照常可以', () => {
    const fs = new FileStore(['/__wxa__/usr/s1', '/__wxa__/tmp/s1']);
    fs.mkdir('/__wxa__/usr/s1/sub');
    for (const dirPath of ['/__wxa__/usr/s1', 'http://localhost/__wxa__/usr/s1/', '/__wxa__/usr', '/__wxa__', '/', 'http://usr/']) {
      expect(() => fs.execute('rmdir', { dirPath, recursive: true })).toThrow('operation not permitted');
    }
    fs.execute('rmdir', { dirPath: '/__wxa__/usr/s1/sub' });
    expect(fs.readdir('/__wxa__/usr/s1')).toEqual([]);
    expect(fs.readdir('/__wxa__/tmp/s1')).toEqual([]);
  });
});
