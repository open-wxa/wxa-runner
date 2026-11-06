/**
 * --devtools-login 用的开发者 ticket 从哪来
 *
 * 环境变量 WECHAT_DEV_TICKET 优先。新版开发者工具（Electron）把登录态加密存放，磁盘上只剩旧版留下的、
 * 早已作废的 ticket，所以要向正在运行的开发者工具要：用它的命令行为项目开启自动化接口，
 * 再通过自动化协议的 Tool.getTicket 取当前生效的 ticket。旧版（package.nw）照旧读磁盘上的登录数据。
 *
 * 不调用 Tool.refreshTicket：刷新会让别人手里的 ticket 立即作废，ticket 过期时开发者工具取的时候会自己刷新。
 *
 * 能不能取 ticket 由微信后台按 appid 下发，没开的 appid 在开发者工具里也看不到那个设置项。
 * 这时 wx.login 还有一条路：自动化协议的 App.callWxMethod 不查这道白名单，让模拟器自己调 wx.login 取 code。
 */

import { execFile } from 'child_process';
import { randomUUID } from 'crypto';
import { setTimeout as sleep } from 'timers/promises';
import { WebSocket } from 'ws';
import { DeveloperTicket, findDeveloperTicket, findElectronDevtoolsCli, TICKET_ENV } from '@open-wxa/wxa-runner-extractor';

export type TicketSource = () => Promise<DeveloperTicket | null>;

/** 自动化接口的惯用端口；被占用时开发者工具会换一个，以命令行返回的为准 */
const AUTO_PORT = 9420;
/** 开发者工具没在运行时命令行要先启动它，项目窗口还可能在等用户确认信任 */
const CLI_TIMEOUT = 60_000;
/**
 * 取 ticket 平时 10ms 左右，项目窗口刚打开时第一次约 1s。项目窗口被关掉后开发者工具的后台可能还在监听，
 * 请求不报错而是一直挂着，超时就当自动化接口失效，重新开启
 */
const AUTOMATOR_TIMEOUT = 5_000;
/** 让模拟器调 wx.login 要向微信请求，平时 0.5s；项目窗口刚打开还在编译时要等编译完 */
const LOGIN_TIMEOUT = 20_000;
/** 开启自动化后项目窗口要过一会儿才登记好，之前取 ticket 会报找不到窗口（开发者工具自己的命令行开启后等 8s 再用） */
const WINDOW_TIMEOUT = 10_000;
const WINDOW_RETRY_INTERVAL = 500;

/** 借开发者工具登录态的两条路：要 ticket，或者让它的模拟器自己调 */
export interface DevtoolsSession {
  /** 取开发者 ticket。每次调用都重新取，开发者工具重新登录、刷新 ticket 后不用重启 */
  findTicket: TicketSource;
  /** 让模拟器自己调 wx.login 取 code，不要 ticket。旧版开发者工具没有自动化接口，这条路是 null */
  loginCode: (() => Promise<string>) | null;
}

/**
 * @param projectPath 项目目录（project.config.json 所在目录），开发者工具为它开启自动化接口，项目窗口没开时会打开
 * @param logger 开启自动化接口时告诉用户，因为开发者工具里可能多出一个项目窗口
 * @returns 取不到时抛错，消息是给用户看的原因和处理办法
 */
export function devtoolsSession(projectPath: string, logger: Pick<Console, 'log'>): DevtoolsSession {
  const cli = findElectronDevtoolsCli();
  if (!cli) return { findTicket: async () => findDeveloperTicket(), loginCode: null };

  let automatorPort: Promise<number> | null = null;
  // 同时发起的几次请求共用一次开启；失败了下次请求再试，用户改好设置后不用重启
  const startOnce = () => {
    if (!automatorPort) {
      const starting = startAutomation(cli, projectPath).then(port => {
        logger.log(`[wxa-runner] --devtools-login：已在微信开发者工具里为项目开启自动化接口（端口 ${port}），ticket 从开发者工具实时获取`);
        return port;
      });
      starting.catch(() => {
        if (automatorPort === starting) automatorPort = null;
      });
      automatorPort = starting;
    }
    return automatorPort;
  };

  /** 开发者工具重启过、项目窗口被关掉时，重新开启一次自动化接口再试 */
  const withRestart = async <T>(run: (port: number) => Promise<T>): Promise<T> => {
    const port = startOnce();
    try {
      return await run(await port);
    } catch (error) {
      if (!(error instanceof AutomatorGone)) throw error;
      if (automatorPort === port) automatorPort = null;
      return run(await startOnce());
    }
  };

  // 退回模拟器取 code 是静默的，不说一声用户会奇怪为什么 wx.login 行、手机号不行
  let loginCodeNoticed = false;
  return {
    findTicket: async () => {
      if (process.env[TICKET_ENV]) return { newticket: process.env[TICKET_ENV] };
      return withRestart(port => onceWindowReady(() => requestTicket(port), projectPath));
    },
    loginCode: async () => {
      const code = await withRestart(port => onceWindowReady(() => requestLoginCode(port), projectPath));
      if (!loginCodeNoticed) {
        loginCodeNoticed = true;
        logger.log(
          '[wxa-runner] --devtools-login：微信后台不给这个 appid 取登录票据，wx.login 的 code 改由开发者工具的模拟器获取；' +
            '手机号、服务市场和插件没有这条路，调用时会失败'
        );
      }
      return code;
    }
  };
}

/** 自动化接口连不上或不响应了，消息是重新开启后还这样时给用户看的 */
class AutomatorGone extends Error {}
class WindowNotFound extends Error {}

/**
 * 微信后台不给这个 appid 取票据，本机设置改不出来
 *
 * 不是用户配错了，别的办法也绕不过去，所以单独一类：wx.login 可以退回让模拟器自己调
 */
export class TicketNotAllowed extends Error {}

/**
 * 开启自动化接口后项目窗口还要过一会儿才登记好，这之前取 ticket 和让模拟器调 wx.login 都报找不到窗口，等它就绪
 *
 * @throws 等过 WINDOW_TIMEOUT 还没就绪时，换成中文的处理办法；别的错误原样抛出
 */
async function onceWindowReady<T>(run: () => Promise<T>, projectPath: string): Promise<T> {
  const deadline = Date.now() + WINDOW_TIMEOUT;
  for (;;) {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof WindowNotFound)) throw error;
      if (Date.now() >= deadline) throw new Error(`微信开发者工具里找不到项目窗口，请在微信开发者工具里打开项目 ${projectPath}`);
      await sleep(WINDOW_RETRY_INTERVAL);
    }
  }
}

/**
 * 用开发者工具的命令行为项目开启自动化接口：开发者工具没在运行时启动它，项目窗口已经开着时复用
 *
 * @returns 自动化接口的端口
 */
async function startAutomation(cli: string, projectPath: string): Promise<number> {
  // 开发者工具设了「CLI 访问令牌」时，命令行自己从继承的环境变量 WECHAT_DEVTOOLS_CLI_TOKEN 读取
  const stdout = await runCli(cli, ['agent', 'start', '--project', projectPath, '--auto-port', String(AUTO_PORT), '--lang', 'zh']);
  // 成功时最后打印一段 JSON；失败时退出码多半还是 0，错误以 [error] 开头打印
  let autoPort = NaN;
  try {
    autoPort = Number(JSON.parse(stdout.match(/^\{$[\s\S]*?^\}$/m)?.[0] ?? '').autoPort);
  } catch {
    // 没有 JSON，从输出里找原因
  }
  if (Number.isInteger(autoPort) && autoPort > 0) return autoPort;

  if (stdout.includes('服务端口已关闭')) {
    throw new Error('微信开发者工具的服务端口已关闭，请在开发者工具「设置 → 安全设置」里开启服务端口');
  }
  throw new Error(`微信开发者工具没能为项目开启自动化接口：${cliErrorMessage(stdout)}`);
}

/** @returns 命令行的标准输出；命令行退出码不为 0 时也返回，由调用方从输出里找原因 */
function runCli(cli: string, args: string[]): Promise<string> {
  // Windows 上是 cli.bat，要经 cmd 运行，路径里常有空格（Program Files）
  const bat = cli.endsWith('.bat');
  const [file, fileArgs] = bat ? [`"${cli}"`, args.map(arg => `"${arg}"`)] : [cli, args];
  return new Promise((resolve, reject) => {
    const child = execFile(file, fileArgs, { shell: bat, timeout: CLI_TIMEOUT, windowsHide: true }, (error, stdout) => {
      if (error?.killed) {
        reject(new Error(`微信开发者工具的命令行 ${CLI_TIMEOUT / 1000}s 内没有完成，请看开发者工具里是否有等待确认的弹窗（如信任项目、扫码登录）`));
      } else if (error && !stdout) {
        reject(new Error(`运行微信开发者工具的命令行失败：${error.message}`));
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.end();
  });
}

/**
 * 命令行把错误对象按 util.inspect 的格式打印，原因在 message 的第一行。
 * util.inspect 默认用单引号，字符串里有单引号时改用双引号，两种都有时用反引号
 */
function cliErrorMessage(stdout: string): string {
  // oxlint-disable-next-line no-control-regex -- 去掉命令行输出里的 ANSI 颜色
  const output = stdout.replace(/\x1b\[[0-9;]*m/g, '');
  const start = output.indexOf('[error]');
  const error = (start < 0 ? output : output.slice(start + '[error]'.length)).trim();
  const message = error.match(/message: (['"`])((?:\\.|(?!\1)[^\\])*?)(?:\\n|\1)/)?.[2];
  return message ?? (error.replace(/\s+/g, ' ').slice(0, 200) || '命令行没有输出');
}

/**
 * 发一条自动化协议命令：一条 WebSocket，{ id, method, params } → { id, result | error }
 *
 * 开发者工具会把别的自动化会话的消息也广播给每个连接，自己的回包还会收到两遍，按 id 认第一条
 */
function sendCommand(port: number, method: string, params: object, timeout: number): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    const id = `wxa-runner-${randomUUID()}`;
    const socket = new WebSocket(`ws://127.0.0.1:${port}`);
    const settle = (finish: () => void) => {
      clearTimeout(timer);
      socket.removeAllListeners().on('error', () => undefined).terminate();
      finish();
    };
    const timer = setTimeout(
      () => settle(() => reject(new AutomatorGone(`微信开发者工具的自动化接口 ${timeout / 1000}s 内没有响应，请确认开发者工具里打开了项目窗口`))),
      timeout
    );
    const gone = () => settle(() => reject(new AutomatorGone(`连不上微信开发者工具的自动化接口（端口 ${port}），请确认开发者工具在运行`)));

    socket.on('error', gone);
    socket.on('close', gone);
    socket.on('open', () => socket.send(JSON.stringify({ id, method, params })));
    socket.on('message', data => {
      let message;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      if (message?.id !== id) return;
      if (message.error) settle(() => reject(explainAutomatorError(String(message.error.message))));
      else settle(() => resolve(message.result ?? {}));
    });
  });
}

/** 通过自动化协议取开发者工具当前的 ticket */
async function requestTicket(port: number): Promise<DeveloperTicket> {
  const result = await sendCommand(port, 'Tool.getTicket', {}, AUTOMATOR_TIMEOUT);
  if (typeof result.ticket !== 'string') throw new Error('微信开发者工具没有返回登录票据');
  return { newticket: result.ticket, expiredAt: result.expiredTime };
}

/**
 * 让开发者工具的模拟器自己调 wx.login，取真实的 code
 *
 * App.callWxMethod 不查 Tool.getTicket 那道白名单，所以 appid 取不到票据时这条路还通。
 * code 由模拟器向微信换取，实测能用 appsecret 换到 session_key。
 * 在开发者工具里 mock 过 wx.login 时，这里拿到的是 mock 值
 */
async function requestLoginCode(port: number): Promise<string> {
  const result = await sendCommand(port, 'App.callWxMethod', { method: 'login', args: [{}] }, LOGIN_TIMEOUT);
  const { code, errMsg } = result.result ?? {};
  if (typeof code !== 'string' || !code) {
    throw new Error(`微信开发者工具的模拟器没有返回 code${errMsg ? `：${errMsg}` : ''}`);
  }
  return code;
}

/** 开发者工具给的是英文，换成处理办法 */
function explainAutomatorError(message: string): Error {
  if (message.includes('GUI project window is not found')) return new WindowNotFound(message);
  // 开发者工具先查后台下发的白名单，再查本机设置，两步失败的提示只差后半句
  if (message.includes('navigate to security settings')) {
    return new Error('微信开发者工具不允许获取登录票据，请在开发者工具「设置 → 安全设置」里打开「允许获取工具登录票据」');
  }
  if (message.includes('not allow to get')) {
    return new TicketNotAllowed(
      '微信开发者工具不给这个 appid 取登录票据：是否允许由微信后台下发，这个 appid 没有开，' +
        '「设置 → 安全设置」里也就不显示「允许获取工具登录票据」，本机改不了。' +
        'wx.login 会自动改由开发者工具的模拟器获取；手机号和服务市场请去掉 --devtools-login，' +
        `用 setup 的 mock 造数据，或另取一张票据用环境变量 ${TICKET_ENV} 传进来`
    );
  }
  if (message.includes('need to login')) return new Error('微信开发者工具未登录，请先在开发者工具里登录');
  return new Error(`微信开发者工具返回错误：${message}`);
}
