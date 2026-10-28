/**
 * 打包、试装、发布全部 npm 包。CI（.github/workflows/release.yml）和首次手动发布都用它：
 *
 *   node scripts/release.mjs            打包 → 在新目录里安装并试跑 → 发布到 npm
 *   node scripts/release.mjs --dry-run  只打包和试跑，不发布
 *
 * 需要先 pnpm build。npm 上已有的版本会跳过，发布中途失败后可以直接重跑。
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REGISTRY = 'https://registry.npmjs.org/';
// 被依赖的包先发，发布过程中有人安装也不会缺依赖
const PACKAGE_DIRS = ['extractor', 'compiler', 'core', 'playwright', 'cli'];

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dryRun = process.argv.includes('--dry-run');

try {
  const packages = readPackages();
  const version = checkVersion(packages);
  const tarballs = pack(packages);
  await smokeTest(tarballs, version);
  if (dryRun) {
    console.log(`\n--dry-run：${version} 打包和试跑都通过，没有发布`);
  } else {
    publish(packages, tarballs, version);
  }
} catch (error) {
  console.error(`\n${error.message}`);
  process.exit(1);
}

function readPackages() {
  // private 的包（如 packages/viewer）不发布，也不参与版本号检查
  const dirs = fs.readdirSync(path.join(root, 'packages'))
    .filter(dir => fs.existsSync(path.join(root, 'packages', dir, 'package.json')))
    .filter(dir => !JSON.parse(fs.readFileSync(path.join(root, 'packages', dir, 'package.json'), 'utf8')).private);
  const unlisted = dirs.filter(dir => !PACKAGE_DIRS.includes(dir));
  if (unlisted.length) throw new Error(`packages/${unlisted.join('、packages/')} 不在 PACKAGE_DIRS 里，请加到发布顺序中`);

  return PACKAGE_DIRS.map(name => {
    const dir = path.join(root, 'packages', name);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return { dir, name: manifest.name, version: manifest.version };
  });
}

/** 各包版本号必须一致；release.yml 发布时还必须与 release-please 打的 tag（RELEASE_TAG）一致 */
function checkVersion(packages) {
  const versions = new Set(packages.map(pkg => pkg.version));
  if (versions.size > 1) {
    throw new Error(`各包版本号不一致：${packages.map(pkg => `${pkg.name}@${pkg.version}`).join('、')}`);
  }
  const [version] = versions;
  const tag = process.env.RELEASE_TAG;
  if (tag && tag !== `v${version}`) throw new Error(`tag ${tag} 与包的版本号 ${version} 不一致`);
  return version;
}

function pack(packages) {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-runner-pack-'));
  return packages.map(pkg => {
    // pnpm pack 会把 workspace:* 换成实际版本号，npm pack 不会
    run('pnpm', ['pack', '--pack-destination', outDir], { cwd: pkg.dir });
    const file = path.join(outDir, `${pkg.name.replace(/^@/, '').replace('/', '-')}-${pkg.version}.tgz`);
    if (!fs.existsSync(file)) throw new Error(`没有找到 ${pkg.name} 的打包结果 ${file}`);
    return file;
  });
}

/** 像外部用户一样在新目录里用 npm 安装：wxa-runner dev 能启动示例项目，编译器和基础库都找得到 */
async function smokeTest(tarballs, version) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-runner-smoke-'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'wxa-runner-smoke', private: true }));
  console.log(`在 ${dir} 安装打包出的 ${tarballs.length} 个包`);
  run('npm', ['install', '--no-audit', '--no-fund', ...tarballs], { cwd: dir });

  const bin = path.join(dir, 'node_modules', '.bin', 'wxa-runner');
  const printed = run(bin, ['--version'], { cwd: dir }).trim();
  if (printed !== version) throw new Error(`wxa-runner --version 输出 ${printed}，应为 ${version}`);
  run('node', ['-e', "require('@open-wxa/wxa-runner-playwright')"], { cwd: dir });

  const port = await freePort();
  const project = path.join(root, 'examples', 'hello-world');
  const server = spawn(bin, ['dev', project, '--host', '127.0.0.1', '--port', String(port), '--no-watch'], { cwd: dir });
  let output = '';
  try {
    const started = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(false), 60_000);
      const onData = chunk => {
        output += chunk;
        if (output.includes('已启动')) {
          clearTimeout(timer);
          resolve(true);
        }
      };
      server.stdout.on('data', onData);
      server.stderr.on('data', onData);
      server.on('exit', () => resolve(false));
    });
    if (!started) throw new Error(`wxa-runner dev 没有启动：\n${output}`);

    // appservice.html 要先编译小程序，能返回就说明找到了编译器；__baselib__ 是选中的基础库目录
    for (const url of ['/', '/__wxa__/runtime/host.js', '/__wxa__/appservice.html', '/__baselib__/WAService.js']) {
      const res = await fetch(`http://127.0.0.1:${port}${url}`);
      if (!res.ok) throw new Error(`GET ${url} 返回 ${res.status}：\n${await res.text()}`);
    }
    // Linux 上没有开发者工具，用的只能是随依赖安装的内置基础库
    if (process.platform === 'linux' && !output.includes('（内置）')) {
      throw new Error(`没有用上内置基础库：\n${output}`);
    }
  } finally {
    server.kill();
  }
  console.log(output.trim());
  fs.rmSync(dir, { recursive: true, force: true });
  console.log('试跑通过');
}

function publish(packages, tarballs, version) {
  // 带 - 的预发布版本（如 0.2.0-beta.1）发到 next，默认安装的 latest 不变
  const tag = version.includes('-') ? 'next' : 'latest';
  packages.forEach((pkg, i) => {
    if (isPublished(pkg)) {
      console.log(`跳过 ${pkg.name}@${pkg.version}：npm 上已有这个版本`);
      return;
    }
    console.log(`\n发布 ${pkg.name}@${pkg.version}（${tag}）`);
    // stdio 继承终端：本机手动发布时 npm 要在这里输入 2FA 验证码
    run('npm', ['publish', tarballs[i], '--access', 'public', '--tag', tag, '--registry', REGISTRY], { stdio: 'inherit' });
  });
}

function isPublished(pkg) {
  try {
    const args = ['view', `${pkg.name}@${pkg.version}`, 'version', '--registry', REGISTRY];
    return run('npm', args, { stdio: ['ignore', 'pipe', 'ignore'] }).trim() === pkg.version;
  } catch {
    // 包还不存在时 npm view 返回 404
    return false;
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], ...options });
}
