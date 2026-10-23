/**
 * 开发服务器
 *
 *   /                          宿主页面
 *   /__wxa__/app-info.json     构建信息（__wxConfig、页面列表、设备参数、setup）
 *   /__wxa__/setup.js          编译后的 setup 文件
 *   /__wxa__/appservice.html   逻辑层
 *   /__wxa__/webview/<page>.html  渲染层（路径与页面一致，wxml 里的相对资源路径因此能正确解析）
 *   /__wxa__/module/<file>.js  单个业务 JS 模块（含 workers 目录下的）
 *   /__wxa__/worker.js?id=     Worker 的入口
 *   /__wxa__/service-templates.js、page-templates.js  两层的模板（热更新时重新下发）
 *   /__wxa__/page-styles.js    渲染层的样式（热更新时重新下发）
 *   /__baselib__/*             官方基础库
 *   /__wxa__/proxy/<协议>/<域名><路径>  网络代理，如 /__wxa__/proxy/https/api.example.com/a?b=1
 *   /__wxa__/mock/<协议>/<域名><路径>   被拦截的请求在 Network 面板里的地址，由 Service Worker（runtime/sw.js）返回响应
 *   /__wxa__/fs/<会话>          文件系统接口（FileSystemManager），每个浏览器会话一份文件，会话标识见 runtime/fileSession.ts
 *   /__wxa__/tmp/<会话>         临时文件：POST ?type=png 保存，返回可直接访问的地址（GET 支持分段请求）；对该地址 HEAD 查大小、DELETE 删除
 *   /__wxa__/usr/<会话>/<路径>   用户目录（USER_DATA_PATH）下的文件，image 等组件和 uploadFile 按地址读取
 *   /__wxa__/region/<kind>     地区选择器用的行政区划数据（districts / streets），取自本机开发者工具
 *   /__wxa__/api/*             --devtools-login：wx.login 的 code、手机号，服务市场、插件的请求转发，只允许本机访问
 *   /__wxa__/ws                文件变化通知：热更新（hot）或整页刷新（reload）；开启 forwardConsole 时浏览器从这里发来报错
 *   其余路径                    小程序目录下的静态资源
 */

import { randomUUID } from 'crypto';
import { FileStore } from './FileStore';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';
import express, { Express, NextFunction, Request, Response } from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { readRegionData, resolveBaseLib, ResolvedBaseLib, usesIsolatedContext } from '@open-wxa/wxa-runner-extractor';
import { AppBuilder } from '../project/AppBuilder';
import { MiniProgram } from '../project/MiniProgram';
import { MOCK_PREFIX, PROXY_PREFIX } from '../runtime/networkPanel';
import type { AppInfo, DeviceProfile, ForwardConsole } from '../runtime/types';
import { appserviceHtml, hostHtml, pluginWebviewHtml, subcontextHtml, webviewHtml, workerScript } from './html';
import { ignoreListSourceMap } from './ignoreList';
import { ignoreConsoleHook, printBrowserReports } from './forwardConsole';
import { handleProxy } from './proxy';
import { planHotUpdate } from './hmr';
import { developerTicketSource, TicketSource } from './developerTicket';
import { AppBuild, findPluginPage, PluginStore } from './plugins';
import { devtoolsLoginRouter } from './devtoolsLogin';
import { requireUsableTicket, WechatDevClient } from './wechatDev';
import { bundleSetup, collectSetupEnv, findSetupFile } from './setup';
import { ProjectWatcher, watchProject } from './watcher';

export interface DevServerOptions {
  projectPath: string;
  /** 不传时从 3000 起找空闲的端口；指定的端口被占用时启动失败；传 0 使用随机端口 */
  port?: number;
  /** 监听地址，默认 localhost；0.0.0.0 或 :: 时局域网也能访问 */
  host?: string;
  /** 指定基础库版本，默认使用本机已安装的最新兼容版本 */
  baseLibVersion?: string;
  baseLibCacheDir?: string;
  watch?: boolean;
  device?: Partial<DeviceProfile>;
  /**
   * 小程序启动前执行的 setup 文件；默认使用项目目录下的 wxa.setup.ts / .js / .mjs，传 false 不使用
   * 环境变量在构造时读取，只暴露 WXA_ 前缀的变量
   */
  setup?: string | false;
  /** 浏览器端运行时（host.js / frame.js）所在目录，默认取构建产物 */
  runtimeDir?: string;
  /**
   * 借本机微信开发者工具的登录态访问微信后台：真实的 wx.login code 和手机号、服务市场、插件。
   * 要先登录开发者工具，会真实请求微信
   */
  devtoolsLogin?: boolean;
  /** @deprecated 改名为 devtoolsLogin */
  realLogin?: boolean;
  /**
   * 把浏览器里的报错打印到终端：'errors' 转发运行时错误和未实现 API 的提醒，'all' 再加上 console.warn / console.error。
   * 默认不转发；命令行默认 'errors'，检测到编程助手时 'all'
   */
  forwardConsole?: ForwardConsole;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export const DEFAULT_DEVICE: DeviceProfile = {
  model: 'iPhone X',
  screenWidth: 375,
  screenHeight: 812,
  pixelRatio: 3,
  statusBarHeight: 44,
  safeAreaBottom: 34,
  system: 'iOS 16.0',
  platform: 'devtools'
};

export class DevServer {
  readonly project: MiniProgram;
  readonly builder: AppBuilder;
  readonly baseLib: ResolvedBaseLib;
  /** 生效的 setup 文件绝对路径，没有时为 null */
  readonly setupFile: string | null;
  private readonly setupEnv: Record<string, string>;
  private readonly device: DeviceProfile;
  private readonly logger: Pick<Console, 'log' | 'warn' | 'error'>;
  private readonly app: Express;
  private server: http.Server | null = null;
  private sockets: WebSocketServer | null = null;
  private watcher: ProjectWatcher | null = null;
  private address = '';
  private lanAccess = false;
  /** 运行时生成的临时文件（canvas 导出、拍照等），随服务器进程存在 */
  private readonly fileSessions = new Map<string, FileStore>();
  private readonly devtoolsLogin: boolean;
  /** 开启 --devtools-login 时才有 */
  private readonly ticketSource: TicketSource | null;
  private readonly plugins: PluginStore;

  constructor(private readonly options: DevServerOptions) {
    this.logger = options.logger || console;
    this.project = new MiniProgram(path.resolve(options.projectPath));
    this.baseLib = resolveBaseLib({ version: options.baseLibVersion, cacheDir: options.baseLibCacheDir });
    if (!this.baseLib.compatible) {
      this.logger.warn(`[wxa-runner] 基础库 ${this.baseLib.version} 高于已验证的版本范围，可能无法正常运行`);
    }
    if (options.realLogin !== undefined && options.devtoolsLogin === undefined) {
      this.logger.warn('[wxa-runner] realLogin（--real-login）已改名为 devtoolsLogin（--devtools-login），旧名以后会移除');
    }
    this.devtoolsLogin = (options.devtoolsLogin ?? options.realLogin) === true;
    this.ticketSource = this.devtoolsLogin ? developerTicketSource(this.project.projectPath, this.logger) : null;
    this.plugins = new PluginStore(this.ticketSource && new WechatDevClient(this.project.appid, this.ticketSource), this.logger);
    this.device = { ...DEFAULT_DEVICE, ...options.device };
    this.builder = new AppBuilder(this.project);
    this.setupFile = resolveSetupFile(options.setup, this.project.projectPath);
    this.setupEnv = collectSetupEnv(process.env);
    this.app = this.createApp();
  }

  /** 本机访问的地址 */
  get url(): string {
    return this.address;
  }

  /** 局域网里其他设备访问的地址，每块网卡一个；只监听本机时为空 */
  get networkUrls(): string[] {
    if (!this.lanAccess) return [];
    const { port } = new URL(this.address);
    return Object.values(os.networkInterfaces())
      .flat()
      .filter(net => net && net.family === 'IPv4' && !net.internal)
      .map(net => `http://${net!.address}:${port}`);
  }

  async start(): Promise<string> {
    // 先构建一次：编译错误在终端里立即可见
    try {
      const build = await this.builder.build();
      this.logger.log(`[wxa-runner] 编译完成：${build.pages.length} 个页面，${build.components.length} 个组件，${build.durationMs}ms`);
    } catch (error) {
      this.logger.error(`[wxa-runner] 编译失败：\n${(error as Error).message}`);
    }

    const server = http.createServer(this.app);
    // 浏览器只发来报错，单条用不了 64KB
    this.sockets = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
    this.sockets.on('connection', socket => {
      // 消息超过 maxPayload 等协议错误时 ws 会断开这个连接；没有监听器的 error 事件会让整个进程退出
      socket.on('error', () => undefined);
      if (this.options.forwardConsole) printBrowserReports(socket, this.logger);
    });
    server.on('upgrade', (req, socket, head) => {
      if (req.url?.startsWith('/__wxa__/ws')) {
        this.sockets!.handleUpgrade(req, socket, head, ws => this.sockets!.emit('connection', ws, req));
      } else {
        socket.destroy();
      }
    });

    const host = this.options.host || 'localhost';
    const port = await listen(server, this.options.port, host, this.logger);
    this.server = server;
    this.lanAccess = LOCAL_HOST_OF_ANY_ADDRESS.has(host);
    this.address = `http://${LOCAL_HOST_OF_ANY_ADDRESS.get(host) ?? host}:${port}`;

    if (this.options.watch !== false) this.startWatching();
    // 启动时先取一次：新版开发者工具要先为项目开启自动化接口，第一次 wx.login 就不用等；不可用时在终端提示原因
    this.ticketSource?.()
      .then(requireUsableTicket)
      .catch(error => this.logger.warn(`[wxa-runner] 开发者工具的登录态暂不可用（--devtools-login）：${error.message}`));
    return this.address;
  }

  async close() {
    await this.watcher?.close();
    this.sockets?.clients.forEach(client => client.terminate());
    this.sockets?.close();
    const server = this.server;
    this.server = null;
    if (server) {
      // 浏览器和 fetch 的 keep-alive 连接会让 close() 一直等到超时
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    this.fileSessions.clear();
  }

  private createApp(): Express {
    const app = express();
    const root = this.project.root;
    const noStore = (res: Response) => res.setHeader('Cache-Control', 'no-store');

    app.get('/', (_req, res) => {
      noStore(res);
      res.type('html').send(hostHtml());
    });

    app.get('/favicon.ico', (_req, res) => {
      res.status(204).end();
    });

    app.get('/__wxa__/app-info.json', async (_req, res) => {
      noStore(res);
      const base = {
        appid: this.project.appid,
        baseLibVersion: this.baseLib.version,
        device: this.device,
        devtoolsLogin: this.devtoolsLogin,
        forwardConsole: this.options.forwardConsole ?? false
      };
      try {
        // 宿主打开小程序时先取 app-info：这时重新决定用哪些插件，之后的请求都按这个结果
        const build = await this.plugins.refresh(await this.builder.build());
        const info: AppInfo = { ...base, version: build.version, wxConfig: build.wxConfig, pages: build.pages };
        if (this.setupFile) info.setup = await this.setupInfo(this.setupFile);
        res.json(info);
      } catch (error) {
        res.json({ ...base, version: 0, wxConfig: {}, pages: [], buildError: (error as Error).message });
      }
    });

    app.get('/__wxa__/setup.js', async (_req, res) => {
      noStore(res);
      if (!this.setupFile) {
        res.status(404).type('text').send('没有 setup 文件');
        return;
      }
      try {
        res.type('js').send(await bundleSetup(this.setupFile));
      } catch (error) {
        res.status(500).type('text').send((error as Error).message);
      }
    });

    app.get('/__wxa__/appservice.html', this.withBuild((build, req, res) => {
      const launchPath = String(req.query.path || '').replace(/^\//, '');
      const launch = build.pages.includes(launchPath)
        ? { path: launchPath, query: Object.fromEntries(new URLSearchParams(String(req.query.query || ''))) }
        : { path: build.pages[0], query: {} };
      res.type('html').send(appserviceHtml(build, launch, { hot: this.hotEnabled, isolated: usesIsolatedContext(this.baseLib.version) }));
    }));

    app.get('/__wxa__/subcontext.html', (req, res) => {
      const id = Number(req.query.id);
      if (!Number.isInteger(id) || id <= 0) {
        res.status(400).type('text').send('子上下文 id 无效');
        return;
      }
      res.type('html').send(subcontextHtml(id, req.query.empty === '1'));
    });

    app.get(/^\/__wxa__\/webview\/(.+)\.html$/, this.withBuild((build, req, res, next) => {
      const pagePath = decodeURIComponent(req.params[0]);
      if (!build.pages.includes(pagePath)) return next();
      const pluginPage = findPluginPage(build, pagePath);
      res.type('html').send(pluginPage
        ? pluginWebviewHtml(build, pluginPage.plugin, pluginPage.innerPath, pagePath, Number(req.query.id))
        : webviewHtml(build, pagePath, Number(req.query.id), { hot: this.hotEnabled }));
    }));

    // 插件的逻辑层、渲染层代码
    app.get('/__wxa__/plugin/:provider/:version/:file(appservice.js|pageframe.js)', this.withBuild((build, req, res, next) => {
      const { provider, version, file } = req.params;
      const code = build.plugins.find(plugin => plugin.provider === provider && plugin.version === version)?.files.get(`/${file}`);
      if (!code) return next();
      res.type('js').send(code);
    }));
    // 插件页面里的图片等资源：基础库把插件里的相对路径和 / 开头的路径都改写成站点根下的 /__plugin__/<插件 appid>/…
    app.get(/^\/__plugin__\/([^/]+)(\/.+)$/, this.withBuild((build, req, res, next) => {
      const file = build.plugins.find(plugin => plugin.provider === req.params[0])?.files.get(decodeURIComponent(req.params[1]));
      if (!file) return next();
      res.type(path.extname(req.params[1]) || 'application/octet-stream').send(file);
    }));

    app.get(/^\/__wxa__\/module\/(.+\.js)$/, this.withBuild((build, req, res) => {
      const id = decodeURIComponent(req.params[0]);
      if (!build.modules.includes(id) && !build.workerModules.includes(id)) {
        res.status(404).type('js').send(`console.error(${JSON.stringify(`[wxa-runner] 模块 ${id} 不存在`)})`);
        return;
      }
      res.type('js').send(this.builder.getModuleScript(id));
    }));

    app.get('/__wxa__/worker.js', this.withBuild((build, _req, res) => {
      const hasWorker = fs.existsSync(path.join(this.baseLib.dir, 'WAWorker.js'));
      res.type('js').send(workerScript(build, { version: this.baseLib.version, hasWorker }));
    }));

    app.get('/__wxa__/service-bootstrap.js', this.withBuild((build, _req, res) => {
      res.type('js').send(build.serviceBootstrap);
    }));

    app.get('/__wxa__/service-templates.js', this.withBuild((build, _req, res) => {
      res.type('js').send(build.serviceTemplates);
    }));

    app.get('/__wxa__/page-templates.js', this.withBuild((build, _req, res) => {
      res.type('js').send(build.pageTemplates);
    }));

    app.get('/__wxa__/page-styles.js', this.withBuild((build, _req, res) => {
      res.type('js').send(build.pageStyles);
    }));

    app.get('/__wxa__/page-frame.js', this.withBuild((build, _req, res) => {
      res.type('js').send(build.pageFrame);
    }));

    app.get('/__wxa__/runtime/frame.js.map', (_req, res, next) => {
      const file = path.join(this.runtimeDir(), 'frame.js.map');
      if (!fs.existsSync(file)) return next();
      res.type('json').send(ignoreConsoleHook(fs.readFileSync(file, 'utf8')));
    });
    app.use('/__wxa__/runtime', express.static(this.runtimeDir(), {
      cacheControl: false,
      // Service Worker 默认只能接管自己所在目录下的页面，宿主页面在根路径
      setHeaders: (res, file) => {
        if (path.basename(file) === 'sw.js') res.setHeader('Service-Worker-Allowed', '/');
      }
    }));
    // 基础库脚本加入 DevTools 的忽略列表，原始代码就是脚本本身（换个地址，免得和脚本混为一个文件）
    const sourceMaps = new Map<string, string>();
    app.get(/^\/__baselib__\/(.+\.js)\.map$/, (req, res, next) => {
      const file = path.resolve(this.baseLib.dir, req.params[0]);
      if (!file.startsWith(this.baseLib.dir + path.sep) || !fs.existsSync(file)) return next();
      if (!sourceMaps.has(file)) sourceMaps.set(file, ignoreListSourceMap(fs.readFileSync(file, 'utf8'), `${path.basename(file)}?original`));
      res.type('json').send(sourceMaps.get(file));
    });
    app.use('/__baselib__', express.static(this.baseLib.dir, {
      maxAge: '1d',
      setHeaders: (res, file) => {
        if (file.endsWith('.js')) res.setHeader('SourceMap', `${path.basename(file)}.map`);
      }
    }));
    // 用 app.use 而不是 app.all('…/*')：后者会先解码路径，见 handleProxy
    app.use(PROXY_PREFIX, express.raw({ type: () => true, limit: '100mb' }), handleProxy);
    // 被拦截的请求本该由 Service Worker 返回响应，到这里说明它没有生效
    app.use(MOCK_PREFIX, (_req, res) => {
      res.status(503).type('text').send('这个请求已被拦截规则拦下，这里只用于在 Network 面板里显示它。'
        + 'Service Worker 没有生效（如 DevTools 勾选了 Bypass for network），看不到拦截规则给出的响应');
    });

    // 每个浏览器会话一份 FileStore：刷新复用，不同的浏览器上下文（Playwright 的每个用例）互不可见。
    // 会话标识要拼进文件地址，只接受 fileSession() 生成的格式；不合法时返回 null
    const sessionFiles = (session: string): FileStore | null => {
      if (!/^[a-z0-9-]{1,80}$/i.test(session)) return null;
      let files = this.fileSessions.get(session);
      if (!files) {
        files = new FileStore([`/__wxa__/usr/${session}`, `/__wxa__/tmp/${session}`]);
        this.fileSessions.set(session, files);
      }
      return files;
    };
    app.post('/__wxa__/fs/:session', express.json({ limit: '150mb' }), (req, res) => {
      const files = sessionFiles(req.params.session);
      if (!files) {
        res.status(400).json({ error: `invalid filesystem session ${req.params.session}` });
        return;
      }
      // 文件不存在等是接口的正常失败，照样返回 200，免得每次失败都在浏览器控制台留下一条请求错误（基础库启动时就会探测不存在的文件）
      try {
        res.json({ result: files.execute(req.body.operation, req.body.args || {}) });
      } catch (error) {
        res.json({ error: (error as Error).message });
      }
    });

    // 返回完整的 http 地址：image、video 组件只原样使用 http(s) 地址。
    app.post('/__wxa__/tmp/:session', express.raw({ type: () => true, limit: '100mb' }), (req, res) => {
      const type = String(req.query.type || 'png');
      if (!/^[a-z0-9]+$/i.test(type)) {
        res.status(400).type('text').send(`非法的文件类型 ${type}`);
        return;
      }
      const files = sessionFiles(req.params.session);
      if (!files) {
        res.status(400).type('text').send(`非法的会话标识 ${req.params.session}`);
        return;
      }
      const filePath = `/__wxa__/tmp/${req.params.session}/${randomUUID()}.${type}`;
      files.write(filePath, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
      res.json({ url: `${req.protocol}://${req.get('host')}${filePath}` });
    });
    app.get('/__wxa__/region/:kind', (req, res) => {
      const kind = req.params.kind;
      const data = kind === 'districts' || kind === 'streets' ? readRegionData(kind) : null;
      if (!data) {
        res.status(404).end();
        return;
      }
      res.type('text/plain; charset=utf-8').set('Cache-Control', 'public, max-age=86400').send(data);
    });

    app.get<{ kind: string; session: string; 0: string }>('/__wxa__/:kind(usr|tmp)/:session/*', (req, res) => {
      const files = this.fileSessions.get(req.params.session);
      const node = files?.stat(`/__wxa__/${req.params.kind}/${req.params.session}/` + req.params[0]);
      if (!node || node.dir) {
        res.status(404).end();
        return;
      }
      const data = node.data;
      res.type(path.extname(req.params[0]));
      // 每次写入更新版本号，追加和 Range 请求不再对整份文件计算哈希。
      res.setHeader('ETag', `"${node.etag}"`);
      // 支持分段请求，video 组件播放临时文件时才能跳转（不支持时浏览器认为视频不能跳转，seek 不起作用）
      res.setHeader('Accept-Ranges', 'bytes');
      const ranges = req.range(data.length);
      if (ranges === -1) {
        res.status(416).setHeader('Content-Range', `bytes */${data.length}`);
        res.end();
        return;
      }
      if (Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length === 1) {
        const { start, end } = ranges[0];
        res.status(206).setHeader('Content-Range', `bytes ${start}-${end}/${data.length}`);
        res.send(data.subarray(start, end + 1));
        return;
      }
      res.send(data);
    });
    app.delete<{ session: string; 0: string }>('/__wxa__/tmp/:session/*', (req, res) => {
      try {
        const files = this.fileSessions.get(req.params.session);
        if (!files) throw new Error('file not exist');
        files.remove(`/__wxa__/tmp/${req.params.session}/` + req.params[0], { dir: false });
        res.status(204).end();
      } catch {
        res.status(404).end();
      }
    });

    if (this.ticketSource) app.use('/__wxa__/api', devtoolsLoginRouter(this.project.appid, this.ticketSource));

    // 渲染层页面路径下的相对资源（如 ../../images/a.png）
    app.use('/__wxa__/webview', express.static(root));
    app.use(express.static(root));

    app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
      this.logger.error('[wxa-runner]', error);
      res.status(500).type('text').send(error.message);
    });

    return app;
  }

  /** 先编译一遍 setup：编译错误随 app-info 交给宿主显示，而不是让浏览器 import 失败 */
  private async setupInfo(file: string): Promise<NonNullable<AppInfo['setup']>> {
    try {
      await bundleSetup(file);
      return { env: this.setupEnv };
    } catch (error) {
      return { env: this.setupEnv, error: (error as Error).message };
    }
  }

  /** 构建结果并入这次打开小程序时决定用的插件 */
  private async currentBuild(): Promise<AppBuild> {
    return this.plugins.current(await this.builder.build());
  }

  /** 需要构建结果的路由；构建失败时返回错误文本 */
  private withBuild(handler: (build: AppBuild, req: Request, res: Response, next: NextFunction) => void) {
    return async (req: Request, res: Response, next: NextFunction) => {
      res.setHeader('Cache-Control', 'no-store');
      let build: AppBuild;
      try {
        build = await this.currentBuild();
      } catch (error) {
        res.status(500).type('text').send((error as Error).message);
        return;
      }
      try {
        handler(build, req, res, next);
      } catch (error) {
        next(error);
      }
    };
  }

  private runtimeDir(): string {
    const candidates = [
      this.options.runtimeDir,
      path.join(__dirname, 'runtime'),
      path.join(__dirname, '../runtime'),
      path.join(__dirname, '../../dist/runtime')
    ].filter((dir): dir is string => !!dir);
    const found = candidates.find(dir => fs.existsSync(path.join(dir, 'host.js')));
    if (!found) {
      throw new Error('找不到浏览器端运行时（host.js），请先执行 pnpm build');
    }
    return found;
  }

  /** 只在监听文件变化时打开基础库的热更新开关，跑测试（watch: false）时运行环境与真机一致 */
  private get hotEnabled(): boolean {
    return this.options.watch !== false;
  }

  private startWatching() {
    // 上次编译失败时页面上显示着错误，修好后整页刷新才能清掉
    let lastBuildFailed = false;

    // 项目目录下的 setup 文件不一定在小程序根目录（miniprogramRoot）里
    const watched = [this.project.root];
    if (this.setupFile && path.relative(this.project.root, this.setupFile).startsWith('..')) watched.push(this.setupFile);

    this.watcher = watchProject(this.project.root, watched, async ({ files, structural }) => {
      const reloadOnly = structural || lastBuildFailed;
      this.builder.invalidate(files);
      const label = files.length > 3 ? `${files.slice(0, 3).join(', ')} 等 ${files.length} 个文件` : files.join(', ');

      try {
        const build = await this.builder.build();
        lastBuildFailed = false;
        const plan = reloadOnly ? null : planHotUpdate(files, build);
        this.logger.log(`[wxa-runner] ${label} 已更新，重新编译 ${build.durationMs}ms${plan ? '，热更新' : ''}`);
        this.broadcast(plan ? { type: 'hot', version: build.version, ...plan } : { type: 'reload' });
      } catch (error) {
        lastBuildFailed = true;
        const message = (error as Error).message;
        this.logger.error(`[wxa-runner] 编译失败：\n${message}`);
        this.broadcast({ type: 'error', message });
      }
    });
  }

  private broadcast(message: Record<string, unknown>) {
    const data = JSON.stringify(message);
    this.sockets?.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    });
  }
}

const DEFAULT_PORT = 3000;
/** 监听所有地址时，本机访问用的地址：0.0.0.0 只监听 IPv4，localhost 可能解析到 IPv6 的 ::1 */
const LOCAL_HOST_OF_ANY_ADDRESS = new Map([['0.0.0.0', '127.0.0.1'], ['::', 'localhost']]);

/** 开始监听，返回实际的端口。没指定端口时从 3000 起往后找空闲的，换了端口在终端提示 */
async function listen(server: http.Server, port: number | undefined, host: string, logger: Pick<Console, 'warn'>): Promise<number> {
  for (let candidate = port ?? DEFAULT_PORT; ; candidate++) {
    // 系统允许别的进程单独占着本机地址上的同一端口，这时打开本机地址会进到那边
    const taken = (LOCAL_HOST_OF_ANY_ADDRESS.has(host) && (await takenOnLoopback(candidate))) || !(await bind(server, candidate, host));
    if (!taken) {
      const actual = (server.address() as net.AddressInfo).port;
      if (port === undefined && actual !== DEFAULT_PORT) logger.warn(`[wxa-runner] 端口 ${DEFAULT_PORT} 已被占用，改用 ${actual}`);
      return actual;
    }
    if (port !== undefined) throw new Error(`端口 ${port} 已被占用：先关闭占用它的进程，或用 --port 换一个端口`);
  }
}

/** 返回 false 表示端口已被占用 */
function bind(server: net.Server, port: number, host: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const onError = (error: NodeJS.ErrnoException) => (error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
    server.once('error', onError);
    server.listen(port, host, () => {
      server.off('error', onError);
      resolve(true);
    });
  });
}

async function takenOnLoopback(port: number): Promise<boolean> {
  for (const address of ['127.0.0.1', '::1']) {
    const probe = net.createServer();
    // 没有这个地址（如关掉了 IPv6）时不算占用
    const free = await bind(probe, port, address).catch(() => true);
    if (!free) return true;
    await new Promise(resolve => probe.close(resolve));
  }
  return false;
}

function resolveSetupFile(option: string | false | undefined, projectPath: string): string | null {
  if (option === false) return null;
  if (!option) return findSetupFile(projectPath);
  const file = path.resolve(option);
  if (!fs.existsSync(file)) throw new Error(`找不到 setup 文件：${file}`);
  return file;
}
