#!/usr/bin/env node

// 先于加载依赖检查：npm / npx 对 engines 只警告，低版本照样能启动，到用 fetch 等时才报看不懂的错
const requiredNode = Number(/\d+/.exec(require('../package.json').engines.node)[0]);
if (Number(process.versions.node.split('.')[0]) < requiredNode) {
  console.error(`wxa-runner 需要 Node.js ${requiredNode} 及以上，当前是 ${process.versions.node}。请先切换 Node.js 版本，如 nvm use 22`);
  process.exit(1);
}

const { Command, Option } = require('commander');
const chalk = require('chalk');
const path = require('path');
const { spawn } = require('child_process');

const program = new Command();

program
  .name('wxa-runner')
  .description('在浏览器中用官方基础库运行微信小程序')
  .version(require('../package.json').version);

program
  .command('dev <project-path>')
  .description('启动开发服务器')
  .option('-p, --port <port>', '端口号', '3000')
  .option('--host <host>', '监听地址', 'localhost')
  .option('-b, --baselib <version>', '基础库版本（默认使用本机已安装的最新兼容版本）')
  .option('--setup <file>', '小程序启动前执行的 setup 文件（默认使用项目目录下的 wxa.setup.ts / .js / .mjs）')
  .option('--no-setup', '不执行 setup 文件')
  .option('--no-watch', '不监听文件变化')
  .option('-o, --open', '启动后打开浏览器')
  .option('--devtools-login', '借本机微信开发者工具的登录态访问微信后台：真实的 code 和手机号、服务市场、插件')
  // 旧名，开发服务器会提示改用 --devtools-login
  .addOption(new Option('--real-login').hideHelp())
  .action(async (projectPath, options) => {
    const { DevServer } = require('@open-wxa/wxa-runner-core');

    try {
      const server = new DevServer({
        projectPath: path.resolve(process.cwd(), projectPath),
        port: parseInt(options.port, 10),
        host: options.host,
        baseLibVersion: options.baselib,
        setup: options.setup,
        watch: options.watch,
        devtoolsLogin: options.devtoolsLogin,
        realLogin: options.realLogin
      });
      const url = await server.start();

      console.log('');
      console.log(chalk.green('  wxa-runner 已启动'));
      console.log(`  地址      ${chalk.cyan(url)}`);
      console.log(`  项目      ${server.project.root}`);
      console.log(`  基础库    ${server.baseLib.version}${server.baseLib.source === 'bundled' ? '（内置）' : ''}`);
      if (server.setupFile) console.log(`  setup     ${server.setupFile}`);
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

const baselib = program.command('baselib').description('管理官方基础库');

baselib
  .command('list')
  .description('列出可用的基础库：本机微信开发者工具已下载的和内置的')
  .action(() => {
    const { listBaseLibs, MAX_COMPATIBLE_VERSION } = require('@open-wxa/wxa-runner-extractor');
    const libs = listBaseLibs();
    if (libs.length === 0) {
      console.log(chalk.yellow('没有找到基础库，请先安装并打开一次微信开发者工具，或重新安装依赖以安装内置基础库'));
      return;
    }
    const defaultLib = libs.find(lib => lib.compatible);
    for (const lib of libs) {
      const source = lib.source === 'bundled' ? chalk.cyan(' (内置)') : '';
      const mark = lib === defaultLib ? chalk.green(' (默认)') : lib.compatible ? '' : chalk.gray(` (> ${MAX_COMPATIBLE_VERSION}，暂不支持)`);
      console.log(`  ${lib.version}${source}${mark}`);
    }
  });

baselib
  .command('extract [version]')
  .description('解包基础库到缓存目录（dev 命令会自动执行；内置基础库无需解包，直接输出所在目录）')
  .action(version => {
    const { resolveBaseLib } = require('@open-wxa/wxa-runner-extractor');
    try {
      const lib = resolveBaseLib({ version });
      console.log(`${chalk.green('✓')} 基础库 ${lib.version} → ${lib.dir}`);
    } catch (error) {
      console.error(chalk.red(error.message));
      process.exit(1);
    }
  });

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

program.parse();
