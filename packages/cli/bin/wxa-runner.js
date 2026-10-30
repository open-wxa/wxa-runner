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
  .option('-p, --port <port>', '端口号（默认 3000，被占用时换用后面空闲的端口）')
  .option('--host [host]', '监听地址，不带值时监听所有地址，局域网也能访问', 'localhost')
  .option('-b, --baselib <version>', '基础库版本（默认使用本机已安装的最新兼容版本）')
  .option('--setup <file>', '小程序启动前执行的 setup 文件（默认使用项目目录下的 wxa.setup.ts / .js / .mjs）')
  .option('--no-setup', '不执行 setup 文件')
  .option('--no-watch', '不监听文件变化')
  .option('-o, --open', '启动后打开浏览器')
  .option('--forward-console', '浏览器里的 console.warn / console.error 也转发到终端（检测到编程助手时默认开启）')
  .option('--no-forward-console', '浏览器里的报错不转发到终端')
  .option('--devtools-login', '借本机微信开发者工具的登录态访问微信后台：真实的 code 和手机号、服务市场、插件')
  .option('--webview-window', 'web-view 的网页在新窗口打开：网页和模拟器域名不同时，Cookie 也能正常使用')
  .option('--extension <module>', '加载开发服务器扩展（npm 包名或文件路径），可以写多次', (value, previous) => [...previous, value], [])
  // 旧名，开发服务器会提示改用 --devtools-login
  .addOption(new Option('--real-login').hideHelp())
  .action(async (projectPath, options) => {
    const { DevServer } = require('@open-wxa/wxa-runner-core');
    const resolvedProjectPath = path.resolve(process.cwd(), projectPath);

    try {
      const extensions = [];
      for (const name of options.extension) extensions.push(await loadExtension(name, resolvedProjectPath));
      const forward = await resolveForwardConsole(options.forwardConsole);
      const server = new DevServer({
        projectPath: resolvedProjectPath,
        extensions,
        port: options.port === undefined ? undefined : parseInt(options.port, 10),
        host: options.host === true ? '0.0.0.0' : options.host,
        baseLibVersion: options.baselib,
        setup: options.setup,
        watch: options.watch,
        devtoolsLogin: options.devtoolsLogin,
        realLogin: options.realLogin,
        forwardConsole: forward.mode,
        webViewWindow: options.webviewWindow
      });
      const url = await server.start();

      console.log('');
      console.log(chalk.green('  wxa-runner 已启动'));
      console.log(`  地址      ${chalk.cyan(url)}`);
      server.extensionEntries.forEach(entry => console.log(`  ${bannerLabel(entry.label)}${chalk.cyan(url + entry.path)}`));
      const networkUrls = server.networkUrls;
      if (networkUrls.length === 0) {
        console.log(`  局域网    ${chalk.gray('加 --host 开放局域网访问')}`);
      }
      networkUrls.forEach((networkUrl, i) => console.log(`  ${i === 0 ? '局域网' : '      '}    ${chalk.cyan(networkUrl)}`));
      console.log(`  控制台    ${describeForwardConsole(forward)}`);
      console.log(`  项目      ${server.project.root}`);
      console.log(`  基础库    ${server.baseLib.version}${server.baseLib.source === 'bundled' ? '（内置）' : ''}`);
      if (server.setupFile) console.log(`  setup     ${server.setupFile}`);
      console.log('');

      // 有扩展页面时打开第一个：扩展页面通常把小程序嵌在里面
      if (options.open) openBrowser(url + (server.extensionEntries[0]?.path ?? ''));

      const shutdown = () => server.close().then(() => process.exit(0));
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    } catch (error) {
      console.error(chalk.red('\n启动失败：'), error.message);
      process.exit(1);
    }
  });

// 查看器：把小程序打成 .wxapack，不带源码在浏览器里运行。实现在 @open-wxa/wxa-viewer 里，执行时才加载：
// wxa-runner 不依赖它，只用 dev 的人不会因此多装 esbuild-wasm 等依赖
const viewer = program
  .command('viewer')
  .description('查看器：把小程序打成 .wxapack，不带源码在浏览器里运行（需要 @open-wxa/wxa-viewer）');

viewer
  .command('pack <project-path>')
  .description('把小程序编译成 .wxapack 包')
  .option('-o, --out <file>', '输出文件（默认在当前目录按 appid 或项目目录名命名）')
  .option('-b, --baselib <version>', '基础库版本（默认使用本机已安装的最新兼容版本）')
  .option('--setup <file>', '打进包里的 setup 文件（默认使用项目目录下的 wxa.setup.ts / .js / .mjs）')
  .option('--no-setup', '不打包 setup 文件')
  .action(async (projectPath, options) => {
    try {
      const fs = require('fs');
      const { createPack } = loadViewer();
      const resolvedProjectPath = path.resolve(projectPath);
      const { bytes, manifest, warnings } = await createPack({
        projectPath: resolvedProjectPath,
        baseLibVersion: options.baselib,
        setup: options.setup,
        logger: { warn() {} }
      });
      const configFile = path.join(resolvedProjectPath, 'project.config.json');
      const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
      const output = path.resolve(options.out || `${config.appid || path.basename(resolvedProjectPath)}.wxapack`);
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
      console.error(chalk.red('\n打包失败：'), error.message);
      process.exit(1);
    }
  });

viewer
  .command('preview [packs...]')
  .description('在本机打开查看器，打开时自动导入传入的包')
  .option('-p, --port <port>', '端口号（默认 3000，被占用时换用后面空闲的端口）')
  .option('--host [host]', '监听地址，不带值时监听所有地址，局域网也能访问', 'localhost')
  .option('-b, --baselib <version>', '基础库版本（默认使用本机已安装的最新兼容版本）')
  .option('-o, --open', '启动后打开浏览器')
  .action(async (packs, options) => {
    try {
      const { ViewerServer } = loadViewer();
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

viewer
  .command('export <out-dir>')
  .description('导出查看器：纯静态站点 site/，和转发 wx.request 的处理函数 proxy.mjs')
  .option('-b, --baselib <version>', '基础库版本（默认使用本机已安装的最新兼容版本）')
  .option('--force', '输出目录不为空时也写入，覆盖之前导出的文件')
  .option('--pack <file>', '默认包，可以写多次：浏览器里还没有项目时自动导入', (file, packs) => packs.concat(file), [])
  .action(async (outDir, options) => {
    try {
      const { exportViewer } = loadViewer();
      const output = exportViewer(outDir, { baseLibVersion: options.baselib, force: options.force, packs: options.pack });
      console.log('');
      console.log(chalk.green('  查看器已导出'));
      console.log(`  静态站点  ${chalk.cyan(path.join(output, 'site'))}`);
      options.pack.forEach((file, i) => console.log(`  ${i === 0 ? '默认包' : '      '}    ${path.basename(file)}`));
      console.log(`  请求转发  ${chalk.cyan(path.join(output, 'proxy.mjs'))}`);
      console.log('  下一步    把 site/ 交给任意静态托管；要转发 wx.request 时，把 /__wxa__/proxy/ 开头的请求交给 proxy.mjs');
      console.log('');
    } catch (error) {
      console.error(chalk.red('\n导出失败：'), error.message);
      process.exit(1);
    }
  });

/** @throws 没装 @open-wxa/wxa-viewer 时，消息里说明怎么装 */
function loadViewer() {
  try {
    return require('@open-wxa/wxa-viewer');
  } catch (error) {
    // 只处理查看器本身找不到；它内部依赖缺失等别的错误照常抛出
    if (error.code === 'MODULE_NOT_FOUND' && error.message.includes("'@open-wxa/wxa-viewer'")) {
      throw new Error('查看器命令需要 @open-wxa/wxa-viewer，请先安装：npm i -D @open-wxa/wxa-viewer');
    }
    throw error;
  }
}

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

/**
 * 加载 --extension 指定的扩展。扩展装在用户项目里，从 wxa-runner 自己的安装位置不一定找得到（如 pnpm 不提升依赖时），
 * 所以依次从项目目录、当前目录、wxa-runner 自身查找。CommonJS 和 ES 模块都可以，
 * 默认导出可以是扩展对象，也可以是不带参数调用后返回扩展的函数
 */
async function loadExtension(name, projectPath) {
  const { createRequire } = require('module');
  const { pathToFileURL } = require('url');
  const request = name.startsWith('.') ? path.resolve(name) : name;
  let resolved = null;
  for (const base of [path.join(projectPath, 'package.json'), path.join(process.cwd(), 'package.json'), __filename]) {
    try {
      resolved = createRequire(base).resolve(request);
      break;
    } catch (error) {
      if (error.code === 'MODULE_NOT_FOUND') continue;
      // 装了但解析不出入口，如 exports 只给了 import 条件：按 require 的规则解析，找不到可用的入口
      throw new Error(`扩展 ${name} 加载失败：${error.message.split('\n')[0]}。package.json 的 exports 要提供 require 或 default 条件`);
    }
  }
  if (!resolved) {
    console.error(chalk.red(`\n找不到扩展 ${name}：`), chalk.cyan(`npm i -D ${name}`));
    process.exit(1);
  }
  // 用 import() 而不是 require()：Node.js 22.12 之前 require() 不能加载 ES 模块，之后也不能加载带顶层 await 的。
  // import() 拿到的 default 对 CommonJS 是 module.exports，所以 exports.default 还要再取一层
  const exported = (await import(pathToFileURL(resolved).href)).default;
  const candidate = exported?.default ?? exported;
  const extension = typeof candidate === 'function' ? candidate() : candidate;
  if (!extension || typeof extension.name !== 'string' || typeof extension.setup !== 'function') {
    throw new Error(`${name} 不是 wxa-runner 的扩展：默认导出要有 name 和 setup()，或是返回这样的对象的函数`);
  }
  return extension;
}

/** 启动信息左列的标签补到 10 列宽，与「地址      」对齐；中文字符占两列 */
function bannerLabel(label) {
  const width = [...label].reduce((sum, ch) => sum + (ch.charCodeAt(0) > 0xff ? 2 : 1), 0);
  return label + ' '.repeat(Math.max(10 - width, 2));
}

/**
 * 没指定 --forward-console / --no-forward-console 时：编程助手自己启动开发服务器时只看得到终端，
 * console.warn / console.error 也转发；人在自己的终端里启动时用浏览器的开发者工具看，只转发报错
 */
async function resolveForwardConsole(option) {
  if (option === false) return { mode: false };
  if (option === true) return { mode: 'all' };
  const { determineAgent } = require('@vercel/detect-agent');
  const { isAgent, agent } = await determineAgent();
  return isAgent ? { mode: 'all', agent: agent.name } : { mode: 'errors' };
}

function describeForwardConsole({ mode, agent }) {
  if (!mode) return chalk.gray('不转发浏览器里的报错');
  if (mode === 'errors') return `转发报错到终端${chalk.gray('，加 --forward-console 再转发 console.warn / console.error')}`;
  return `转发报错和 console.warn / console.error 到终端${agent ? chalk.gray(`（检测到编程助手 ${agent}）`) : ''}`;
}

function openBrowser(url) {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  spawn(command, args, { stdio: 'ignore', detached: true }).unref();
}

program.parse();
