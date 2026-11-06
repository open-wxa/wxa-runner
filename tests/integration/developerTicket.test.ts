/**
 * --devtools-login 用的开发者 ticket 从哪来
 *
 * 新版开发者工具（Electron）把登录态加密存放，磁盘上只剩旧版留下的、早已作废的 ticket：
 * 要用开发者工具的命令行为项目开启自动化接口，再通过自动化协议向正在运行的开发者工具要当前的 ticket。
 * 旧版（package.nw）照旧读磁盘上的登录数据。
 *
 * 开发者工具用假的代替：WXA_DEVTOOLS_PATH 指向临时目录里的安装布局，命令行是记录参数、按预设输出的脚本，
 * 自动化接口是本进程里的 WebSocket 服务。命令行的输出、自动化协议的消息格式取自对 2.02.2609231 的实测。
 * 用户主目录换成临时目录，不读本机真实的登录态（worker 线程里 stub HOME 环境变量对 os.homedir() 无效）。
 */

import fs from 'fs';
import http from 'http';
import os from 'os';
import { once } from 'events';
import { AddressInfo } from 'net';
import path from 'path';
import express from 'express';
import { WebSocketServer } from 'ws';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TICKET_ENV } from '../../packages/extractor/src/devtools';
import { devtoolsSession } from '../../packages/core/src/server/developerTicket';
import { devtoolsLoginRouter } from '../../packages/core/src/server/devtoolsLogin';
import { createProject } from '../helpers';

const HOUR = 3600_000;
const SILENT = { log: () => undefined, warn: () => undefined };

/** 假的开发者工具命令行：记下每次调用的参数，按 reply.json 输出 */
const CLI_SCRIPT = `#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
fs.appendFileSync(path.join(__dirname, 'calls.log'), JSON.stringify(process.argv.slice(2)) + '\\n');
const { stdout, exitCode } = JSON.parse(fs.readFileSync(path.join(__dirname, 'reply.json'), 'utf8'));
process.stdout.write(stdout);
process.exit(exitCode);
`;

const agentStarted = (autoPort: number) => `{
  "command": "agent-start",
  "status": "ok",
  "autoPort": ${autoPort},
  "openedProjectWindow": true,
  "version": "2.02.2609231",
  "requestedAutoPort": 9420
}
`;

/** 服务端口关闭时命令行的输出，退出码是 -10 */
const SERVICE_PORT_DISABLED = `[error] IDE service port disabled. To use CLI Call, please enter y to confirm enabling CLI capability, or manually open IDE -> Settings -> Security Settings, and set Service Port On.
For more details see: https://developers.weixin.qq.com/miniprogram/en/dev/devtools/cli.html
[error] 工具的服务端口已关闭。要使用命令行调用工具，请手动打开工具 -> 设置 -> 安全设置，将服务端口开启。
详细信息: https://developers.weixin.qq.com/miniprogram/dev/devtools/cli.html

[info] 退出
`;

/** 项目路径不对时命令行的输出：退出码是 0，错误对象按 util.inspect 的格式打印 */
const PROJECT_NOT_FOUND = `[error] {
  code: 10,
  message: 'Error: 错误 Error: 该文件路径下项目不存在 (code 10)Error: 该文件路径下项目不存在\\n' +
    '    at j.openProjectWindow (/Applications/wechatwebdevtools.app/Contents/Resources/app.asar/js/963d91fd667ec81273187e17e64b633c.js:2:14160)'
}
`;

type AutomatorReply = { result: object } | { error: { message: string } };

const currentTicket = (ticket: string): AutomatorReply => ({ result: { ticket, expiredTime: Date.now() + HOUR } });
const automatorError = (message: string): AutomatorReply => ({ error: { message } });

const cleanups: (() => unknown)[] = [];

beforeEach(() => {
  vi.stubEnv(TICKET_ENV, '');
  useHome(createProject({}));
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map(cleanup => cleanup()));
});

/**
 * 本机装的开发者工具：electron 是新版，nw 是旧版（package.nw）。两种都带命令行，按本机平台的安装布局放：
 * macOS 是 Contents/MacOS/cli，Windows 是安装目录下经 cmd 运行的 cli.bat
 */
function installDevtools(kind: 'electron' | 'nw') {
  const windows = process.platform === 'win32';
  const root = createProject(
    windows
      ? {
          [kind === 'electron' ? 'resources/app.asar.unpacked/package.json' : 'code/package.nw/package.json']: {},
          'cli.bat': `@"${process.execPath}" "%~dp0cli.js" %*\r\n`,
          'cli.js': CLI_SCRIPT
        }
      : {
          [kind === 'electron' ? 'Contents/Resources/app.asar.unpacked/package.json' : 'Contents/Resources/package.nw/package.json']: {},
          'Contents/MacOS/cli': CLI_SCRIPT
        }
  );
  const dir = windows ? root : path.join(root, 'Contents/MacOS');
  fs.writeFileSync(path.join(dir, 'reply.json'), JSON.stringify({ stdout: '', exitCode: 0 }));
  if (!windows) fs.chmodSync(path.join(dir, 'cli'), 0o755);
  vi.stubEnv('WXA_DEVTOOLS_PATH', root);

  return {
    /** 之后每次调用命令行都这样输出 */
    reply(stdout: string, exitCode = 0) {
      fs.writeFileSync(path.join(dir, 'reply.json'), JSON.stringify({ stdout, exitCode }));
    },
    /** 每次调用命令行的参数 */
    calls(): string[][] {
      const log = path.join(dir, 'calls.log');
      return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    },
    /** 让开发者工具开启过自动化的项目，每开启一次记一次 */
    automatedProjects(): string[] {
      return this.calls()
        .filter(args => args[0] === 'agent' && args[1] === 'start')
        .map(args => args[args.indexOf('--project') + 1]);
    }
  };
}

/** 用户主目录换成 dir；Windows 上开发者工具的用户数据在 %LOCALAPPDATA% 下，也一并换到 dir 里 */
function useHome(dir: string) {
  vi.spyOn(os, 'homedir').mockReturnValue(dir);
  vi.stubEnv('LOCALAPPDATA', path.join(dir, 'AppData/Local'));
}

/** 用户数据目录里一个账号的登录数据，是旧版开发者工具以明文写下的 */
function homeWithSavedTicket(newticket: string): string {
  const userData =
    process.platform === 'darwin'
      ? 'Library/Application Support/微信开发者工具'
      : process.platform === 'win32'
        ? 'AppData/Local/微信开发者工具/User Data'
        : '.config/wechat_devtools';
  const profile = path.join(userData, '50a7d9210159a32f006158795f893857/WeappLocalData');
  return createProject({
    [`${profile}/hash_key_map_2.json`]: { a1b2: 'reduxPersist:user' },
    [`${profile}/localstorage_a1b2.json`]: { currentUser: { newticket, ticketExpiredTime: Date.now() + HOUR, loginStatus: 'SUCCESS' } }
  });
}

/**
 * 开发者工具开启的自动化接口：按方法名回包，reply 返回 null 时不回。
 * 和真实的一样，回包前会广播别的自动化会话的消息（broadcast），每条回包发两遍
 */
async function startAutomator(
  reply: (method: string) => AutomatorReply | null,
  broadcast = [JSON.stringify({ id: 'another-session', result: { ticket: 'not-for-you' } })]
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', socket => {
    socket.on('message', data => {
      const { id, method } = JSON.parse(String(data));
      broadcast.forEach(message => socket.send(message));
      const result = reply(method);
      if (!result) return;
      const response = JSON.stringify({ id, ...result });
      socket.send(response);
      socket.send(response);
    });
  });
  const close = () => {
    server.clients.forEach(client => client.terminate());
    return new Promise(resolve => server.close(resolve));
  };
  cleanups.push(close);
  return { port: (server.address() as AddressInfo).port, close };
}

/** 微信服务器：记下每次收到的 ticket，都回一个 code */
function stubWechat(): string[] {
  const received: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    received.push(new URL(url).searchParams.get('newticket')!);
    return new Response(JSON.stringify({ baseresponse: { errcode: 0 }, code: `code-${received.length}` }));
  });
  return received;
}

/** 按开发服务器的方式挂上开发者工具登录态的接口，返回调用 wx.login 的函数 */
async function serveDevtoolsLogin(projectPath: string) {
  const app = express();
  const devtools = devtoolsSession(projectPath, SILENT);
  app.use('/__wxa__/api', devtoolsLoginRouter('wx-app', devtools.findTicket, devtools.loginCode));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  cleanups.push(() => new Promise(resolve => server.close(resolve)));
  const { port } = server.address() as AddressInfo;

  return (): Promise<{ status: number; body: any }> =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, path: '/__wxa__/api/login', method: 'POST' }, res => {
        let text = '';
        res.on('data', chunk => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode!, body: JSON.parse(text) }));
      });
      req.on('error', reject);
      req.end();
    });
}

describe('新版开发者工具（Electron）', () => {
  it('开发者用开发者工具当前的 ticket 换到 code，不用磁盘上残留的旧 ticket', async () => {
    // Given 磁盘上有旧版开发者工具留下的 ticket，正在运行的开发者工具里当前的是另一个
    useHome(homeWithSavedTicket('saved-on-disk'));
    const devtools = installDevtools('electron');
    devtools.reply(agentStarted((await startAutomator(() => currentTicket('live'))).port));
    const project = createProject({});
    const login = await serveDevtoolsLogin(project);
    const wechat = stubWechat();

    // When
    const result = await login();

    // Then 微信收到的是开发者工具当前的 ticket，开发者工具为这个项目开启了自动化
    expect(result).toEqual({ status: 200, body: { code: 'code-1' } });
    expect(wechat).toEqual(['live']);
    expect(devtools.automatedProjects()).toEqual([project]);
  });

  it('开发者工具换了 ticket 后，下一次登录就用新的；自动化只开启一次', async () => {
    const devtools = installDevtools('electron');
    let ticket = 'before';
    devtools.reply(agentStarted((await startAutomator(() => currentTicket(ticket))).port));
    const project = createProject({});
    const login = await serveDevtoolsLogin(project);
    const wechat = stubWechat();

    await login();
    ticket = 'after';
    await login();

    expect(wechat).toEqual(['before', 'after']);
    expect(devtools.automatedProjects()).toEqual([project]);
  });

  it('自动化接口广播了不是对象的消息时，开发者照样能登录', async () => {
    const devtools = installDevtools('electron');
    devtools.reply(agentStarted((await startAutomator(() => currentTicket('t'), ['null', '42', '"text"', 'not json'])).port));
    const login = await serveDevtoolsLogin(createProject({}));
    const wechat = stubWechat();

    expect((await login()).status).toBe(200);
    expect(wechat).toEqual(['t']);
  });

  it('同时发起的几次登录只让开发者工具开启一次自动化', async () => {
    const devtools = installDevtools('electron');
    devtools.reply(agentStarted((await startAutomator(() => currentTicket('t'))).port));
    const project = createProject({});
    const login = await serveDevtoolsLogin(project);
    stubWechat();

    const results = await Promise.all([login(), login(), login()]);

    expect(results.map(result => result.status)).toEqual([200, 200, 200]);
    expect(devtools.automatedProjects()).toEqual([project]);
  });

  it('自动化端口没了（开发者工具重启、项目窗口被关掉）后，开发者不用重启 wxa-runner 也能登录', async () => {
    // Given 开发者工具重启过，或者项目窗口被关掉，原来的自动化端口没了
    const devtools = installDevtools('electron');
    const first = await startAutomator(() => currentTicket('first'));
    devtools.reply(agentStarted(first.port));
    const project = createProject({});
    const login = await serveDevtoolsLogin(project);
    const wechat = stubWechat();
    await login();
    await first.close();
    devtools.reply(agentStarted((await startAutomator(() => currentTicket('second'))).port));

    // When
    const result = await login();

    // Then 重新为项目开启了自动化
    expect(result.status).toBe(200);
    expect(wechat).toEqual(['first', 'second']);
    expect(devtools.automatedProjects()).toEqual([project, project]);
  });

  it('项目窗口被关掉、自动化接口不再响应时，重新开启自动化后开发者能登录', async () => {
    // 开发者工具的后台还在监听端口，但没有项目窗口时请求一直挂着，直到项目窗口重新打开
    const devtools = installDevtools('electron');
    const automator = await startAutomator(() => (devtools.automatedProjects().length < 2 ? null : currentTicket('t')));
    devtools.reply(agentStarted(automator.port));
    const project = createProject({});
    const login = await serveDevtoolsLogin(project);
    const wechat = stubWechat();

    expect((await login()).status).toBe(200);
    expect(wechat).toEqual(['t']);
    expect(devtools.automatedProjects()).toEqual([project, project]);
  });

  it('项目窗口刚打开、开发者工具还认不出它时，等它认出来后开发者能登录', async () => {
    // 开发者工具开启自动化后立即返回，这时项目窗口可能还没登记好，取 ticket 会报找不到窗口
    const devtools = installDevtools('electron');
    const project = createProject({});
    let requests = 0;
    const automator = await startAutomator(() =>
      ++requests <= 2 ? automatorError(`GUI project window is not found for project ${project}`) : currentTicket('t')
    );
    devtools.reply(agentStarted(automator.port));
    const login = await serveDevtoolsLogin(project);
    const wechat = stubWechat();

    expect((await login()).status).toBe(200);
    expect(wechat).toEqual(['t']);
  });

  it('开发者工具一直找不到项目窗口时，提示开发者在开发者工具里打开项目，不请求微信', async () => {
    const devtools = installDevtools('electron');
    const project = createProject({});
    const automator = await startAutomator(() => automatorError(`GUI project window is not found for project ${project}`));
    devtools.reply(agentStarted(automator.port));
    const login = await serveDevtoolsLogin(project);
    const wechat = stubWechat();

    const { status, body } = await login();

    expect(status).toBe(500);
    expect(body.error).toContain('在微信开发者工具里打开项目');
    expect(body.error).toContain(project);
    expect(wechat).toEqual([]);
  });

  it('开发者工具不允许获取登录票据时，告诉开发者在哪里打开，不请求微信', async () => {
    const devtools = installDevtools('electron');
    // 模拟器那条路故意给成功：本机设置没开是用户能自己解决的，不该悄悄换路把问题盖掉
    const automator = await startAutomator(method =>
      method === 'App.callWxMethod'
        ? { result: { result: { code: 'code-from-simulator', errMsg: 'login:ok' } } }
        : automatorError('ticket is not allow to get, navigate to security settings and turn it on')
    );
    devtools.reply(agentStarted(automator.port));
    const login = await serveDevtoolsLogin(createProject({}));
    const wechat = stubWechat();

    const { status, body } = await login();

    expect(status).toBe(500);
    expect(body.error).toContain('设置 → 安全设置');
    expect(body.error).toContain('允许获取工具登录票据');
    expect(wechat).toEqual([]);
  });

  it('appid 不在微信后台的白名单里时，wx.login 让模拟器自己调，不请求微信', async () => {
    const devtools = installDevtools('electron');
    const automator = await startAutomator(method =>
      method === 'App.callWxMethod'
        ? { result: { result: { code: 'code-from-simulator', errMsg: 'login:ok' } } }
        : automatorError('ticket is not allow to get')
    );
    devtools.reply(agentStarted(automator.port));
    const login = await serveDevtoolsLogin(createProject({}));
    const wechat = stubWechat();

    const { status, body } = await login();

    expect(status).toBe(200);
    expect(body.code).toBe('code-from-simulator');
    // 没有 ticket，根本没法请求微信后台
    expect(wechat).toEqual([]);
  });

  it('项目窗口还没登记好时，等它就绪再让模拟器调 wx.login', async () => {
    const devtools = installDevtools('electron');
    let calls = 0;
    const automator = await startAutomator(method => {
      if (method !== 'App.callWxMethod') return automatorError('ticket is not allow to get');
      // 开启自动化后窗口要过一会儿才登记好，这之前实测就是这句
      calls += 1;
      return calls === 1
        ? automatorError('GUI project window is not found for project /x')
        : { result: { result: { code: 'code-from-simulator', errMsg: 'login:ok' } } };
    });
    devtools.reply(agentStarted(automator.port));
    const login = await serveDevtoolsLogin(createProject({}));

    const { status, body } = await login();

    expect(status).toBe(200);
    expect(body.code).toBe('code-from-simulator');
    expect(calls).toBe(2);
  });

  it('白名单之外且模拟器也取不到 code 时，说清是微信后台不给票据', async () => {
    const devtools = installDevtools('electron');
    const automator = await startAutomator(method =>
      method === 'App.callWxMethod' ? { result: { result: { errMsg: 'login:fail' } } } : automatorError('ticket is not allow to get')
    );
    devtools.reply(agentStarted(automator.port));
    const login = await serveDevtoolsLogin(createProject({}));
    const wechat = stubWechat();

    const { status, body } = await login();

    expect(status).toBe(500);
    expect(body.error).toContain('login:fail');
    expect(wechat).toEqual([]);
  });

  it('取票据失败不是白名单的缘故时，不换成模拟器那条路，照旧报原因', async () => {
    const devtools = installDevtools('electron');
    const automator = await startAutomator(method =>
      method === 'App.callWxMethod' ? { result: { result: { code: 'code-from-simulator', errMsg: 'login:ok' } } } : automatorError('need to login')
    );
    devtools.reply(agentStarted(automator.port));
    const login = await serveDevtoolsLogin(createProject({}));
    const wechat = stubWechat();

    const { status, body } = await login();

    expect(status).toBe(500);
    expect(body.error).toContain('未登录');
    expect(wechat).toEqual([]);
  });

  it('开发者工具没登录时提示开发者先登录', async () => {
    const devtools = installDevtools('electron');
    devtools.reply(agentStarted((await startAutomator(() => automatorError('need to login'))).port));
    const login = await serveDevtoolsLogin(createProject({}));
    stubWechat();

    expect((await login()).body.error).toContain('微信开发者工具未登录');
  });

  it('服务端口关着时提示开发者去开启，开启后不用重启就能登录', async () => {
    const devtools = installDevtools('electron');
    devtools.reply(SERVICE_PORT_DISABLED, 246);
    const login = await serveDevtoolsLogin(createProject({}));
    const wechat = stubWechat();

    const { status, body } = await login();
    expect(status).toBe(500);
    expect(body.error).toContain('设置 → 安全设置');
    expect(body.error).toContain('服务端口');

    // 用户开启服务端口后再登录
    devtools.reply(agentStarted((await startAutomator(() => currentTicket('t'))).port));
    expect((await login()).status).toBe(200);
    expect(wechat).toEqual(['t']);
  });

  it('开发者工具命令行出错时，开发者看到命令行给出的原因', async () => {
    const devtools = installDevtools('electron');
    devtools.reply(PROJECT_NOT_FOUND);
    const login = await serveDevtoolsLogin(createProject({}));
    stubWechat();

    const { status, body } = await login();

    expect(status).toBe(500);
    expect(body.error).toContain('该文件路径下项目不存在');

    // 原因里有英文撇号时，util.inspect 改用双引号
    devtools.reply(`[error] {
  code: 10,
  message: "Error: can't open project (code 10)\\n" +
    '    at j.openProjectWindow (/Applications/wechatwebdevtools.app/Contents/Resources/app.asar/js/a.js:2:1)'
}
`);
    expect((await login()).body.error).toContain("can't open project (code 10)");

    // 直接打印出来的对象不是 JSON
    devtools.reply(`{
  code: 10,
  message: 'Error: 项目未被信任'
}
`);
    expect((await login()).body.error).toContain('项目未被信任');
  });
});

describe('其它 ticket 来源', () => {
  it(`设置了环境变量 ${TICKET_ENV} 时用它，不让开发者工具开启自动化`, async () => {
    vi.stubEnv(TICKET_ENV, 'from-env');
    const devtools = installDevtools('electron');
    const login = await serveDevtoolsLogin(createProject({}));
    const wechat = stubWechat();

    expect((await login()).status).toBe(200);
    expect(wechat).toEqual(['from-env']);
    expect(devtools.calls()).toEqual([]);
  });

  it('旧版开发者工具（package.nw）照旧用磁盘上保存的 ticket', async () => {
    useHome(homeWithSavedTicket('saved-on-disk'));
    const devtools = installDevtools('nw');
    const login = await serveDevtoolsLogin(createProject({}));
    const wechat = stubWechat();

    expect((await login()).status).toBe(200);
    expect(wechat).toEqual(['saved-on-disk']);
    expect(devtools.calls()).toEqual([]);
  });
});
