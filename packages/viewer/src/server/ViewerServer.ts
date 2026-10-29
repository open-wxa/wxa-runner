/**
 * wxa-runner viewer preview：在本机提供查看器站点和 wx.request 转发
 *
 * 小程序的页面和代码由浏览器里的 Service Worker 从导入的包里应答（runtime/packRoutes.ts），这里不编译、不读项目。
 */

import http from 'http';
import os from 'os';
import express from 'express';
import { handleProxy, listen, LOCAL_HOST_OF_ANY_ADDRESS } from '@open-wxa/wxa-runner-core';
import { PROXY_PREFIX } from '@open-wxa/wxa-runner-core/web';
import { preloadURL, PRELOAD_PATH, resolvePackFiles, resolveViewerSite, viewerIndexHtml, ViewerSiteOptions } from './viewerSite';

export interface ViewerServerOptions extends ViewerSiteOptions {
  /** 不传时从 3000 起找空闲端口；0 使用随机端口；指定的端口被占用时失败。 */
  port?: number;
  /** 默认 localhost；0.0.0.0 或 :: 开放局域网访问。 */
  host?: string;
  /** 打开 url 时自动导入的包，按传入顺序导入，最后一个成为当前项目；只有这些文件会暴露在 /__wxa__/preload/ 下 */
  packs?: string[];
  logger?: Pick<Console, 'warn'>;
}

/** 提供查看器静态资源与本机网络代理；小程序路由由浏览器 Service Worker 处理。 */
export class ViewerServer {
  private readonly site;
  readonly baseLib;
  private readonly packs;
  private server: http.Server | null = null;
  private address = '';

  constructor(private readonly options: ViewerServerOptions = {}) {
    this.site = resolveViewerSite(options);
    this.baseLib = this.site.baseLib;
    this.packs = resolvePackFiles(options.packs);
    if (!this.baseLib.compatible)
      (options.logger ?? console).warn(`[wxa-viewer] 基础库 ${this.baseLib.version} 高于已验证的版本范围，可能无法正常运行`);
  }

  /** 本机访问地址，包含命令行指定包的 preload 参数。 */
  get url(): string {
    return this.address;
  }

  /** 监听所有地址时列出局域网地址，并保留 preload 参数。 */
  get networkUrls(): string[] {
    if (!this.address || !LOCAL_HOST_OF_ANY_ADDRESS.has(this.options.host || 'localhost')) return [];
    const url = new URL(this.address);
    return Object.values(os.networkInterfaces())
      .flat()
      .filter(net => net && net.family === 'IPv4' && !net.internal)
      .map(net => `http://${net!.address}:${url.port}${url.pathname}${url.search}`);
  }

  /** 启动监听并返回 url；不编译项目、不监听文件变化。 */
  async start(): Promise<string> {
    if (this.server) return this.address;
    const app = express();
    app.get(['/', '/index.html'], (_req, res) => res.type('html').send(viewerIndexHtml()));
    app.get('/viewer.json', (_req, res) => res.type('json').send(this.site.viewerJson));
    app.get('/pack-sw.js', (_req, res) => res.type('js').sendFile(this.site.serviceWorker));
    app.get('/__wxa__/runtime/esbuild.wasm', (_req, res) => res.type('application/wasm').sendFile(this.site.wasmPath));
    for (const dir of this.site.runtimeDirs) {
      app.use(
        '/__wxa__/runtime',
        express.static(dir, { index: false, redirect: false })
      );
    }
    app.use('/__baselib__', express.static(this.baseLib.dir, { index: false, redirect: false }));
    app.use(PROXY_PREFIX, express.raw({ type: () => true, limit: '50mb' }), handleProxy);
    app.get(PRELOAD_PATH + ':name', (req, res, next) => {
      const file = this.packs.get(req.params.name);
      if (!file) return next();
      res.type('application/octet-stream').sendFile(file);
    });
    app.use((_req, res) =>
      res.status(404).type('text').send('未找到资源。小程序路由应由 Service Worker 应答；Service Worker 未生效时请返回查看页面重新导入包。')
    );
    const server = http.createServer(app);
    const host = this.options.host || 'localhost';
    const port = await listen(server, this.options.port, host, this.options.logger ?? console);
    this.server = server;
    const localHost = LOCAL_HOST_OF_ANY_ADDRESS.get(host) ?? host;
    const url = new URL(`http://${localHost.includes(':') ? `[${localHost}]` : localHost}:${port}`);
    for (const name of this.packs.keys()) url.searchParams.append('pack', preloadURL(name));
    this.address = this.packs.size ? url.href : url.origin;
    return this.address;
  }

  /** 关闭监听并断开 keep-alive 连接，可重复调用。 */
  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
    this.address = '';
  }
}
