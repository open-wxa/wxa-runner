/**
 * 查看器和 wxa-runner-core 的边界：查看器只用 core 的公开导出，core 不知道查看器的存在。
 * 守住这条线，查看器以后才能原样搬到独立仓库，core 也不会因为查看器长出只有它用的东西
 */

import fs from 'fs';
import { createRequire } from 'module';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../../helpers';

// esbuild 是 core 的依赖，仓库根目录没有
const { build } = createRequire(path.join(REPO_ROOT, 'packages/core/package.json'))('esbuild') as { build(options: object): Promise<unknown> };

const VIEWER_SRC = path.join(REPO_ROOT, 'packages/viewer/src');
const CORE_SRC = path.join(REPO_ROOT, 'packages/core/src');
const CORE_EXPORTS = new Set(['@open-wxa/wxa-runner-core', '@open-wxa/wxa-runner-core/web', '@open-wxa/wxa-runner-core/setup']);
/** 跑在浏览器、Service Worker、Cloudflare Worker 里的部分，只能用 core 不依赖 Node 的 /web */
const BROWSER_SIDE = ['page', 'sw', 'proxy.ts', 'store.ts', 'pack/format.ts'];

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? sourceFiles(file) : file.endsWith('.ts') ? [file] : [];
  });
}

function imports(file: string): string[] {
  const code = fs.readFileSync(file, 'utf8');
  return [...code.matchAll(/(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g)].map(match => match[1]);
}

describe('查看器与 core 的边界', () => {
  it('查看器的源码只通过公开导出引用 core，相对路径不伸出自己的包', () => {
    const violations = sourceFiles(VIEWER_SRC).flatMap(file =>
      imports(file)
        .filter(specifier => {
          if (specifier.startsWith('.')) return !path.resolve(path.dirname(file), specifier).startsWith(path.join(REPO_ROOT, 'packages/viewer') + path.sep);
          return specifier.startsWith('@open-wxa/wxa-runner-core') && !CORE_EXPORTS.has(specifier);
        })
        .map(specifier => `${path.relative(REPO_ROOT, file)} → ${specifier}`)
    );
    expect(violations).toEqual([]);
  });

  it('查看器在浏览器里运行的部分只用 core 的 /web 入口', () => {
    const browserFiles = sourceFiles(VIEWER_SRC).filter(file =>
      BROWSER_SIDE.some(part => path.relative(VIEWER_SRC, file).split(path.sep).join('/').startsWith(part))
    );
    const violations = browserFiles.flatMap(file =>
      imports(file).filter(specifier => specifier === '@open-wxa/wxa-runner-core').map(() => path.relative(REPO_ROOT, file))
    );
    expect(browserFiles.length).toBeGreaterThan(0);
    expect(violations).toEqual([]);
  });

  it('源码里没有某个部署平台专用的代码：导出的是纯静态站点和标准 Fetch 处理函数，接到哪个平台由使用者决定', () => {
    const files = [...sourceFiles(VIEWER_SRC), ...sourceFiles(CORE_SRC)];
    const violations = files.filter(file => /cloudflare|wrangler|vercel|netlify/i.test(fs.readFileSync(file, 'utf8'))).map(file => path.relative(REPO_ROOT, file));
    expect(violations).toEqual([]);
  });

  it('wxa-runner 命令行只在开发依赖里引用查看器：npm 用户装 wxa-runner 时不会装上它', () => {
    const cli = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/cli/package.json'), 'utf8'));
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      expect(Object.keys(cli[field] ?? {}), field).not.toContain('@open-wxa/wxa-viewer');
    }
  });

  it('core 不引用查看器', () => {
    const violations = sourceFiles(CORE_SRC).filter(file => imports(file).some(specifier => /wxa-viewer|packages\/viewer/.test(specifier)));
    expect(violations).toEqual([]);
  });

  it('core 的 /web 入口能按浏览器平台打包，不依赖 Node', async () => {
    await expect(
      build({ entryPoints: [path.join(CORE_SRC, 'web.ts')], bundle: true, platform: 'browser', format: 'esm', write: false, logLevel: 'silent' })
    ).resolves.toBeTruthy();
  });
});
