/**
 * less / sass 编译插件（project.config.json 的 setting.useCompilerPlugins）：
 * 预处理文件按开发者工具的规则编译成同名 .wxss，和原有的 .wxss 一起交给 wcsc
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { MiniProgram } from '../../packages/core/src/project/MiniProgram';
import { ignoredStyleSources, readStyleSetting, StyleMirror } from '../../packages/core/src/project/StyleMirror';
import { createProject } from '../helpers';

/** 开启指定编译插件的小程序项目，项目里没有安装编译器 */
function styledProject(useCompilerPlugins: unknown, files: Record<string, string | object>) {
  return new MiniProgram(createProject({
    'project.config.json': { setting: { useCompilerPlugins } },
    'app.json': { pages: ['pages/a/a'] },
    ...files
  }));
}

/** 同步镜像目录，返回 { 相对路径: 内容 } */
async function mirror(project: MiniProgram): Promise<Record<string, string>> {
  const styles = new StyleMirror(project.styleSetting);
  const { cwd, files } = await styles.sync(project);
  return Object.fromEntries(files.map(file => [file, fs.readFileSync(path.join(cwd, file), 'utf8')]));
}

const compact = (css: string) => css.replace(/\s+/g, ' ').trim();

describe('编译插件设置', () => {
  it('插件可以写成名字或 [名字, 选项]，typescript 等非样式插件忽略', () => {
    const setting = readStyleSetting({ useCompilerPlugins: ['typescript', ['sass', {}], ['less', { globalVars: { gap: '8rpx' } }]] });
    expect(setting.plugins).toEqual(['sass', 'less']);
    expect(setting.lessGlobalVars).toEqual({ gap: '8rpx' });
  });

  it.each([false, undefined, []])('useCompilerPlugins 为 %j 时不开启任何样式插件', value => {
    expect(readStyleSetting({ useCompilerPlugins: value }).plugins).toEqual([]);
    expect(readStyleSetting(undefined).plugins).toEqual([]);
  });

  it('公共文件默认是 app.less、global.sass、global.scss，可以在 lessSetting / sassSetting 里改', () => {
    expect(readStyleSetting({})).toMatchObject({ lessCommonFile: 'app.less', sassCommonFile: 'global.sass', scssCommonFile: 'global.scss' });
    expect(readStyleSetting({ lessSetting: { commonUseFilePath: 'styles/common.less' } }).lessCommonFile).toBe('styles/common.less');
  });

  it('项目里有 .less / .scss 但没有开启对应插件时报告出来（这些样式不会生效）', () => {
    const project = styledProject(false, { 'pages/a/a.less': '', 'pages/a/b.scss': '', 'pages/a/a.wxss': '' });
    expect(ignoredStyleSources(project, project.styleSetting)).toEqual([
      { plugin: 'less', files: ['pages/a/a.less'] },
      { plugin: 'sass', files: ['pages/a/b.scss'] }
    ]);
    const lessOnly = styledProject(['less'], { 'pages/a/a.less': '' });
    expect(ignoredStyleSources(lessOnly, lessOnly.styleSetting)).toEqual([]);
  });
});

describe('less 编译插件', () => {
  it('只有 .less 的页面编译成同名 .wxss：变量和嵌套展开，rpx 原样保留', async () => {
    const files = await mirror(styledProject(['less'], {
      'pages/a/a.less': '@gap: 15rpx;\n.page-container { padding: @gap * 2; .title { color: red; } }'
    }));
    expect(Object.keys(files)).toEqual(['pages/a/a.wxss']);
    expect(compact(files['pages/a/a.wxss'])).toBe('.page-container { padding: 30rpx; } .page-container .title { color: red; }');
  });

  it('同一路径既有 .less 又有 .wxss 时用 .less 的编译结果，与开发者工具一致', async () => {
    const files = await mirror(styledProject(['less'], {
      'pages/a/a.wxss': '/* pages/a/a.wxss */',
      'pages/a/a.less': '.from-less { color: red; }',
      'styles/plain.wxss': '.plain { color: blue; }'
    }));
    expect(files['pages/a/a.wxss']).toContain('.from-less');
    expect(files['styles/plain.wxss']).toBe('.plain { color: blue; }');
  });

  it('每个 .less 都能直接用 app.less 里的变量和 mixin，app.less 自己的规则只输出到 app.wxss', async () => {
    const files = await mirror(styledProject(['less'], {
      'app.less': '@brand: #07c160;\n.rounded() { border-radius: 8rpx; }\n.app-only { color: @brand; }',
      'pages/a/a.less': '.btn { color: @brand; .rounded(); }'
    }));
    expect(compact(files['pages/a/a.wxss'])).toBe('.btn { color: #07c160; border-radius: 8rpx; }');
    expect(files['app.wxss']).toContain('.app-only');
  });

  it('@import 的 .less 编译进来，@import 的 .wxss 原样保留给 wcsc', async () => {
    const files = await mirror(styledProject(['less'], {
      'styles/vars.less': '@red: #f00;',
      'styles/base.wxss': '.base { margin: 0; }',
      'pages/a/a.less': "@import '../../styles/vars.less';\n@import '../../styles/base.wxss';\n.x { color: @red; }"
    }));
    expect(compact(files['pages/a/a.wxss'])).toBe("@import '../../styles/base.wxss'; .x { color: #f00; }");
  });

  it('["less", { globalVars }] 给出的全局变量在每个文件里都能用', async () => {
    const files = await mirror(styledProject([['less', { globalVars: { gap: '12rpx' } }]], {
      'pages/a/a.less': '.x { padding: @gap; }'
    }));
    expect(compact(files['pages/a/a.wxss'])).toBe('.x { padding: 12rpx; }');
  });

  it('编译出错时指出文件和源文件里的行号（自动引用 app.less、全局变量都不影响行号）', async () => {
    const project = styledProject([['less', { globalVars: { gap: '8rpx' } }]], {
      'app.less': '@brand: red;',
      'pages/a/a.less': '.x {\n  color: @missing;\n}'
    });
    await expect(mirror(project)).rejects.toThrow(/pages\/a\/a\.less 编译失败：pages\/a\/a\.less:2:\d+ variable @missing is undefined/);
  });

  it('项目里没有安装 less 时用 wxa-runner 自带的 less 编译', async () => {
    const files = await mirror(styledProject(['less'], { 'pages/a/a.less': '@w: 2rpx; .x { width: @w; }' }));
    expect(compact(files['pages/a/a.wxss'])).toBe('.x { width: 2rpx; }');
  });

  it('项目里安装了 less 时优先用项目里的版本', async () => {
    const files = await mirror(styledProject(['less'], {
      'pages/a/a.less': '.x {}',
      'node_modules/less/package.json': { name: 'less', main: 'index.js' },
      'node_modules/less/index.js': "module.exports = { render: async () => ({ css: '.from-project-less {}' }) };"
    }));
    expect(files['pages/a/a.wxss']).toBe('.from-project-less {}');
  });

  it('源文件删除后，镜像目录里对应的 .wxss 也删除；改回 .wxss 时用 .wxss', async () => {
    const project = styledProject(['less'], { 'pages/a/a.less': '.x { color: red; }', 'pages/a/a.wxss': '.y {}' });
    const styles = new StyleMirror(project.styleSetting);
    const { cwd } = await styles.sync(project);

    fs.rmSync(path.join(project.root, 'pages/a/a.less'));
    await styles.sync(project);
    expect(fs.readFileSync(path.join(cwd, 'pages/a/a.wxss'), 'utf8')).toBe('.y {}');

    fs.rmSync(path.join(project.root, 'pages/a/a.wxss'));
    expect((await styles.sync(project)).files).toEqual([]);
    expect(fs.existsSync(path.join(cwd, 'pages/a/a.wxss'))).toBe(false);
    styles.dispose();
    expect(fs.existsSync(cwd)).toBe(false);
  });
});

describe('sass 编译插件', () => {
  it('.scss 和缩进语法的 .sass 都编译成同名 .wxss，覆盖同名 .wxss', async () => {
    const files = await mirror(styledProject(['sass'], {
      'pages/a/a.wxss': '/* stub */',
      'pages/a/a.scss': '$gap: 10rpx;\n.x { padding: $gap * 2; .y { color: red; } }',
      'pages/b/b.sass': '.z\n  margin: 4rpx\n'
    }));
    expect(compact(files['pages/a/a.wxss'])).toBe('.x { padding: 20rpx; } .x .y { color: red; }');
    expect(compact(files['pages/b/b.wxss'])).toBe('.z { margin: 4rpx; }');
  });

  it('每个文件可以通过 global 命名空间使用 global.scss', async () => {
    const files = await mirror(styledProject(['sass'], {
      'global.scss': '$brand: #07c160;',
      'styles/_mixins.scss': '@mixin rounded { border-radius: 8rpx; }',
      'pages/a/a.scss': "@use '../../styles/mixins';\n.btn { color: global.$brand; @include mixins.rounded; }"
    }));
    expect(compact(files['pages/a/a.wxss'])).toBe('.btn { color: #07c160; border-radius: 8rpx; }');
  });

  it('_ 开头的 .scss 也编译成同名 .wxss：它可能就是页面自己的样式，开发者工具同样不跳过', async () => {
    const files = await mirror(styledProject(['sass'], {
      'pages/a/_a.wxss': '/* stub */',
      'pages/a/_a.scss': '.underscore-page { color: red; }'
    }));
    expect(compact(files['pages/a/_a.wxss'])).toBe('.underscore-page { color: red; }');
  });

  it('项目里装的旧版 sass 只有 renderSync 时用它编译', async () => {
    const files = await mirror(styledProject(['sass'], {
      'pages/a/a.sass': '.x\n  color: red\n',
      'node_modules/sass/package.json': { name: 'sass', main: 'index.js' },
      'node_modules/sass/index.js':
        "module.exports = { renderSync: o => ({ css: Buffer.from('/* legacy ' + o.indentedSyntax + ' */ ' + o.data.trim()) }) };"
    }));
    expect(files['pages/a/a.wxss']).toBe('/* legacy true */ .x\n  color: red');
  });

  it('@import 的 .wxss 原样保留给 wcsc，普通 .css 引用不受影响', async () => {
    const files = await mirror(styledProject(['sass'], {
      'pages/a/a.scss': "@import '../../styles/base.wxss';\n@import 'https://example.com/a.css';\n.x { color: red; }"
    }));
    expect(files['pages/a/a.wxss']).toContain("@import '../../styles/base.wxss';");
    expect(files['pages/a/a.wxss']).toContain('https://example.com/a.css');
  });

  it('项目里没有安装 sass 时用 wxa-runner 自带的 sass 编译', async () => {
    const files = await mirror(styledProject(['sass'], { 'pages/a/a.scss': '$w: 2rpx; .x { width: $w; }' }));
    expect(compact(files['pages/a/a.wxss'])).toBe('.x { width: 2rpx; }');
  });

  it('less 和 sass 都开启时，在 useCompilerPlugins 里排在后面的插件优先', async () => {
    const files = await mirror(styledProject(['less', 'sass'], {
      'pages/a/a.less': '.from-less {}',
      'pages/a/a.scss': '.from-scss { color: red; }'
    }));
    expect(files['pages/a/a.wxss']).toContain('.from-scss');
  });
});
