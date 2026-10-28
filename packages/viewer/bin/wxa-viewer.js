#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const path = require('path');
const { spawn } = require('child_process');

const program = new Command();

program
  .name('wxa-viewer')
  .description('把小程序打成 .wxapack，不带源码在浏览器里运行')
  .version(require('../package.json').version);

program
  .command('build <project-path>')
  .description('把小程序编译成 .wxapack 包')
  .option('-o, --out <file>', '输出文件（默认在当前目录按 appid 或项目目录名命名）')
  .option('-b, --baselib <version>', '基础库版本（默认使用本机已安装的最新兼容版本）')
  .option('--setup <file>', '包内的 setup 文件（默认使用项目目录下的 wxa.setup.ts / .js / .mjs）')
  .option('--no-setup', '不包含 setup 文件')
  .action(async (projectPath, options) => {
    try {
      const fs = require('fs');
      const { createPack } = require('../dist/index.js');
      const resolvedProjectPath = path.resolve(projectPath);
      const { bytes, manifest, warnings } = await createPack({
        projectPath: resolvedProjectPath,
        baseLibVersion: options.baselib,
        setup: options.setup,
        logger: { warn() {} }
      });
      const configFile = path.join(resolvedProjectPath, 'project.config.json');
      const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
      const name = config.appid || path.basename(resolvedProjectPath);
      const output = path.resolve(options.out || `${name}.wxapack`);
      fs.writeFileSync(output, bytes);

      console.log('');
      console.log(chalk.green('  wxapack 已生成'));
      console.log(`  包路径    ${chalk.cyan(output)}`);
      console.log(`  大小      ${(bytes.byteLength / 1024).toFixed(1)} KB（${bytes.byteLength} 字节）`);
      console.log(`  页面      ${manifest.build.pages.length}`);
      console.log(`  基础库    ${manifest.baseLib.version}`);
      warnings.forEach(warning => console.warn(chalk.yellow(`  警告      ${warning}`)));
      console.log('');
    } catch (error) {
      console.error(chalk.red('\n构建失败：'), error.message);
      process.exit(1);
    }
  });

program
  .command('preview [packs...]')
  .description('在本机打开查看器，打开时自动导入传入的包')
  .option('-p, --port <port>', '端口号（默认 3000，被占用时换用后面空闲的端口）')
  .option('--host [host]', '监听地址，不带值时监听所有地址，局域网也能访问', 'localhost')
  .option('-b, --baselib <version>', '基础库版本（默认使用本机已安装的最新兼容版本）')
  .option('-o, --open', '启动后打开浏览器')
  .action(async (packs, options) => {
    try {
      const { ViewerServer } = require('../dist/index.js');
      const server = new ViewerServer({
        packs: packs.map(file => path.resolve(file)),
        port: options.port === undefined ? undefined : parseInt(options.port, 10),
        host: options.host === true ? '0.0.0.0' : options.host,
        baseLibVersion: options.baselib
      });
      const url = await server.start();
      console.log('');
      console.log(chalk.green('  查看器已启动'));
      console.log(`  地址      ${chalk.cyan(url)}`);
      const networkUrls = server.networkUrls;
      if (!networkUrls.length) console.log(`  局域网    ${chalk.gray('加 --host 开放局域网访问')}`);
      networkUrls.forEach((networkUrl, i) => console.log(`  ${i === 0 ? '局域网' : '      '}    ${chalk.cyan(networkUrl)}`));
      console.log(`  基础库    ${server.baseLib.version}${server.baseLib.source === 'bundled' ? '（内置）' : ''}`);
      console.log('');
      if (options.open) openBrowser(url);
      const shutdown = () => server.close().then(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (error) {
      console.error(chalk.red('\n启动失败：'), error.message);
      process.exit(1);
    }
  });

program
  .command('export <out-dir>')
  .description('导出查看器：纯静态站点 site/，和转发 wx.request 的处理函数 proxy.mjs')
  .option('-b, --baselib <version>', '基础库版本（默认使用本机已安装的最新兼容版本）')
  .option('--force', '输出目录不为空时也写入，覆盖之前导出的文件')
  .action(async (outDir, options) => {
    try {
      const { exportViewer } = require('../dist/index.js');
      const output = exportViewer(outDir, { baseLibVersion: options.baselib, force: options.force });
      console.log('');
      console.log(chalk.green('  查看器已导出'));
      console.log(`  静态站点  ${chalk.cyan(path.join(output, 'site'))}`);
      console.log(`  请求转发  ${chalk.cyan(path.join(output, 'proxy.mjs'))}`);
      console.log(`  下一步    把 site/ 交给任意静态托管；要转发 wx.request 时，把 /__wxa__/proxy/ 开头的请求交给 proxy.mjs，见 README`);
      console.log('');
    } catch (error) {
      console.error(chalk.red('\n导出失败：'), error.message);
      process.exit(1);
    }
  });

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

program.parse();
