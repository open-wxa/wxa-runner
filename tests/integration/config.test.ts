/**
 * 配置文件 wxa.config.* 的加载与类型（命令行怎么用见 cli.test.ts）
 *
 * .ts 配置转成 JS 后写在配置文件旁边再加载，加载完删掉。
 * 类型只在编辑器和 tsc 里起作用：esbuild 转换时会擦掉 import type，命令行用例证明不了类型可用。
 */

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { loadConfigFile } from '../../packages/core/src/server/config';
import { createProject, REPO_ROOT } from '../helpers';

const TSC = path.join(REPO_ROOT, 'node_modules/typescript/bin/tsc');
const coreTypesBuilt = fs.existsSync(path.join(REPO_ROOT, 'packages/core/dist/index.d.ts'));

describe('配置文件 wxa.config.ts', () => {
  it('加载 TypeScript 写的配置，加载完不在项目里留下转换出的文件', async () => {
    const dir = createProject({ 'wxa.config.ts': 'const port: number = 4000;\nexport default { port };' });

    const config = await loadConfigFile(path.join(dir, 'wxa.config.ts'), () => undefined);

    expect(config.port).toBe(4000);
    expect(fs.readdirSync(dir)).toEqual(['wxa.config.ts']);
  });

  it.skipIf(!coreTypesBuilt)('用 import type 引用 wxa-runner 的 WxaConfig 时，各种写法都通过类型检查，拼错的配置项报错', () => {
    const dir = createProject({
      'wxa.config.ts': `
        import type { WxaConfig } from 'wxa-runner';

        const inspector = () => ({ name: 'inspector', setup: () => ({}) });

        export default {
          project: './dist/dev/mp-weixin',
          host: true,
          setup: false,
          extensions: ['@open-wxa/wxa-inspector', './local-ext.js', inspector, inspector()],
          // @ts-expect-error 拼错的配置项：WxaConfig 解析失败退化成 any 时这里不报错，tsc 随之失败
          baseLibVersion: '3.7.0'
        } satisfies WxaConfig;`
    });
    fs.mkdirSync(path.join(dir, 'node_modules'));
    fs.symlinkSync(path.join(REPO_ROOT, 'packages/cli'), path.join(dir, 'node_modules/wxa-runner'), 'dir');

    const result = spawnSync(process.execPath, [TSC, '--noEmit', '--strict', '--module', 'nodenext', '--moduleResolution', 'nodenext', '--target', 'es2022', 'wxa.config.ts'], {
      cwd: dir,
      encoding: 'utf8'
    });

    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
