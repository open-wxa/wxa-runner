import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { AppBuilder, rewriteSafeAreaInsets, toJs } from '../../packages/core/src/project/AppBuilder';
import { MiniProgram } from '../../packages/core/src/project/MiniProgram';
import { createProject, hasToolchain } from '../helpers';

function demoProject() {
  return createProject({
    'app.json': { pages: ['pages/a/a', 'pages/b/b'], usingComponents: { comp: '/components/comp/comp' } },
    'app.js': 'App({})',
    'app.wxss': 'page { color: #333; }',
    'pages/a/a.json': {},
    'pages/a/a.wxml': '<view>{{msg}}</view><comp/>',
    'pages/a/a.wxss': '.x { margin: 10rpx; }',
    'pages/a/a.js': "const util = require('../../utils/util.js');\nPage({ data: { msg: util.hi() } })",
    'pages/b/b.json': {},
    'pages/b/b.wxml': '<view>b</view>',
    'pages/b/b.js': 'Page({})',
    'components/comp/comp.json': { component: true },
    'components/comp/comp.wxml': '<view>comp</view>',
    'components/comp/comp.js': 'Component({})',
    'utils/util.js': "module.exports = { hi: () => 'hi' }",
    'utils/esm.js': "import { hi } from './util';\nexport const twice = () => hi() + hi();\n",
    'utils/broken-esm.js': 'export const = 1;',
    // 压缩成一行的 SDK，export 不在行首
    'utils/minified-esm.js': 'const hi=function(){return"hi"};export default hi;',
    'utils/minified-esm-braces.js': 'function a(){return 1}export{a as one};',
    'utils/cjs-like-esm.js': 'var importance=1;module.exports={exported:importance};'
  });
}

describe('JS 模块包装', () => {
  const root = demoProject();
  const builder = new AppBuilder(new MiniProgram(root));

  it('CommonJS 文件原样包进 define，首行与包装头同一行，行号保持一致', () => {
    const script = builder.getModuleScript('pages/a/a.js');
    expect(script.startsWith('define("pages/a/a.js", function(require, module, exports, window, document,')).toBe(true);
    expect(script.split('\n')[1]).toBe('Page({ data: { msg: util.hi() } })');
  });

  it('使用 import/export 的文件转换为 CommonJS，并带 source map', () => {
    const script = builder.getModuleScript('utils/esm.js');
    expect(script).toContain('require("./util")');
    expect(script).not.toMatch(/^\s*import /m);
    expect(script).toContain('sourceMappingURL=data:application/json');
  });

  it('压缩成一行、export 不在行首的文件也转换为 CommonJS，能正常加载', () => {
    expect(runModule(builder.getModuleScript('utils/minified-esm.js')).default()).toBe('hi');
    expect(runModule(builder.getModuleScript('utils/minified-esm-braces.js')).one()).toBe(1);
  });

  it('CommonJS 文件里出现 exports、importance 等字样，不当作 ES Module 转换', () => {
    const script = builder.getModuleScript('utils/cjs-like-esm.js');
    expect(script).toContain('var importance=1;module.exports={exported:importance};');
    expect(script).not.toContain('sourceMappingURL');
    expect(runModule(script)).toEqual({ exported: 1 });
  });

  it('转换失败时输出控制台错误而不是让整个逻辑层崩溃', () => {
    expect(builder.getModuleScript('utils/broken-esm.js')).toMatch(/^console\.error\(".*utils\/broken-esm\.js 转换失败/);
  });
});

/** 像逻辑层一样执行 define 包装好的模块，返回它的 module.exports */
function runModule(script: string): any {
  const module = { exports: {} };
  new Function('define', script)((_id: string, factory: Function) => factory(() => ({}), module, module.exports));
  return module.exports;
}

describe('toJs', () => {
  it('转义 </script> 和行分隔符，结果仍是等价的 JSON', () => {
    const value = { a: '</script><b>', b: 'x\u2028y\u2029z' };
    const code = toJs(value);
    expect(code).not.toContain('</script>');
    expect(code).not.toMatch(/[\u2028\u2029]/);
    expect(JSON.parse(code)).toEqual(value);
  });
});

describe('安全区 env() 改写', () => {
  it('env() 与 iOS 11 的 constant() 都改写成宿主按页面下发的 CSS 变量', () => {
    expect(rewriteSafeAreaInsets('a{padding-bottom:env(safe-area-inset-bottom);margin-top:constant(safe-area-inset-top)}'))
      .toBe('a{padding-bottom:var(--wxa-safe-area-inset-bottom);margin-top:var(--wxa-safe-area-inset-top)}');
  });

  it('保留 fallback，包括 wcsc 把 rpx 拆成数组片段的情况', () => {
    expect(rewriteSafeAreaInsets('calc(20px + env( safe-area-inset-left , 10px))'))
      .toBe('calc(20px + var(--wxa-safe-area-inset-left , 10px))');
    expect(rewriteSafeAreaInsets('"b{padding:env(safe-area-inset-right, ",[0,20],")}"'))
      .toBe('"b{padding:var(--wxa-safe-area-inset-right, ",[0,20],")}"');
  });

  it('其他 env() 变量和普通文本不动', () => {
    const css = 'a{height:env(keyboard-inset-height);content:"safe-area-inset-bottom"}';
    expect(rewriteSafeAreaInsets(css)).toBe(css);
  });
});

describe('增量构建标记', () => {
  const builder = new AppBuilder(new MiniProgram(demoProject()));

  it('只有小程序源文件的变化才需要重新构建', () => {
    expect(builder.invalidate(['images/logo.png'])).toBe(false);
    expect(builder.invalidate(['pages/a/a.js'])).toBe(true);
    expect(builder.invalidate(['pages/a/a.wxss'])).toBe(true);
    expect(builder.invalidate(['pages/a/a.less'])).toBe(true);
    expect(builder.invalidate(['styles/theme.scss'])).toBe(true);
    // less / sass 可以引用 .css
    expect(builder.invalidate(['styles/theme.css'])).toBe(true);
  });
});

describe.skipIf(!hasToolchain())('完整构建', () => {
  it('生成逻辑层和渲染层需要的全部产物', async () => {
    const root = demoProject();
    const result = await new AppBuilder(new MiniProgram(root)).build();

    expect(result.pages).toEqual(['pages/a/a', 'pages/b/b']);
    expect(result.components).toEqual(['components/comp/comp']);
    expect(result.modules).toEqual(expect.arrayContaining(['app.js', 'pages/a/a.js', 'utils/util.js']));

    // 逻辑层：先注册组件和页面的 json/wxml，再 require app.js，最后按组件→页面顺序 require
    const svc = result.serviceBootstrap;
    expect(svc).toContain('__wxAppCode__["pages/a/a.json"] = {"usingComponents":{"comp":"/components/comp/comp"}}');
    expect(svc.indexOf('require("app.js")')).toBeLessThan(svc.indexOf('require("components/comp/comp.js")'));
    expect(svc.indexOf('require("components/comp/comp.js")')).toBeLessThan(svc.indexOf('require("pages/a/a.js")'));
    expect(svc).toContain('__wxRoute = "pages/a/a"');

    // 渲染层：完整 $gwx、公共样式、每个页面的样式函数
    expect(result.pageFrame).toContain('__wxAppCode__["pages/a/a.wxml"] = $gwx("./pages/a/a.wxml")');
    expect(result.pageFrame).toContain('__wxAppCode__["pages/a/a.wxss"] = setCssToHead');
    expect(result.pageFrame).toContain('color: #333');
    expect(result.wxConfig.entryPagePath).toBe('pages/a/a.html');
  });

  it.each(['workers', 'workers/', './workers', { path: 'workers', isSubpackage: true }])
  ('workers 目录下的 JS 不进逻辑层，单独作为 Worker 的模块：%j', async workers => {
    const root = createProject({
      'app.json': { pages: ['pages/a/a'], workers },
      'app.js': 'App({})',
      'pages/a/a.json': {},
      'pages/a/a.wxml': '<view>a</view>',
      'pages/a/a.js': 'Page({})',
      'workers/index.js': "require('./utils/math.js');",
      'workers/utils/math.js': 'module.exports = {};'
    });
    const builder = new AppBuilder(new MiniProgram(root));
    const result = await builder.build();

    expect(result.modules).toEqual(['app.js', 'pages/a/a.js']);
    expect(result.serviceBootstrap).not.toContain('require("workers/');
    expect(result.workerModules).toEqual(['workers/index.js', 'workers/utils/math.js']);
    expect(builder.getModuleScript('workers/utils/math.js')).toMatch(/^define\("workers\/utils\/math\.js", function\(/);
  });

  it('没有配置 workers 时没有 Worker 的模块', async () => {
    const result = await new AppBuilder(new MiniProgram(demoProject())).build();
    expect(result.workerModules).toEqual([]);
  });

  it('文件未变化时复用上次结果，变化后版本号递增', async () => {
    const root = demoProject();
    const builder = new AppBuilder(new MiniProgram(root));
    const first = await builder.build();
    expect(await builder.build()).toBe(first);

    fs.writeFileSync(path.join(root, 'pages/b/b.wxml'), '<view>changed</view>');
    builder.invalidate(['pages/b/b.wxml']);
    const second = await builder.build();
    expect(second.version).toBe(first.version + 1);
    expect(second.pageFrame).toContain('changed');
  });

  it('并发请求共享同一次构建', async () => {
    const builder = new AppBuilder(new MiniProgram(demoProject()));
    const [a, b] = await Promise.all([builder.build(), builder.build()]);
    expect(a).toBe(b);
  });

  it('构建进行中又有文件变化时，拿到的结果包含这次变化', async () => {
    const root = demoProject();
    const builder = new AppBuilder(new MiniProgram(root));
    await builder.build();

    fs.writeFileSync(path.join(root, 'pages/b/b.wxml'), '<view>first</view>');
    builder.invalidate(['pages/b/b.wxml']);
    const running = builder.build();
    fs.writeFileSync(path.join(root, 'pages/b/b.wxml'), '<view>second</view>');
    builder.invalidate(['pages/b/b.wxml']);
    const [stale, latest] = await Promise.all([running, builder.build()]);

    // 进行中的那次构建可能已经读过旧文件，必须另起一次
    expect(latest.version).toBeGreaterThan(stale.version);
    expect(latest.pageFrame).toContain('second');
  });

  it('热更新用的渲染层模板只含模板，不含样式（重复执行样式代码会累积 rpx 重算回调）', async () => {
    const result = await new AppBuilder(new MiniProgram(demoProject())).build();
    expect(result.pageTemplates).toContain('__wxAppCode__["pages/a/a.wxml"] = $gwx("./pages/a/a.wxml")');
    expect(result.pageTemplates).not.toContain('setCssToHead');
    expect(result.pageTemplates).not.toContain('color: #333');
  });

  it('热更新用的渲染层样式含公共样式和各页面的样式，不含模板', async () => {
    const result = await new AppBuilder(new MiniProgram(demoProject())).build();
    expect(result.pageStyles).toContain('color: #333');
    expect(result.pageStyles).toContain('__wxAppCode__["pages/a/a.wxss"] = setCssToHead');
    expect(result.pageStyles).not.toContain('$gwx');
  });

  it('app.wxss 和页面样式 @import 的共享样式文件一起编译（uni-app 的 common/main.wxss）', async () => {
    const root = demoProject();
    fs.mkdirSync(path.join(root, 'common'));
    fs.mkdirSync(path.join(root, 'styles'));
    fs.writeFileSync(path.join(root, 'common/main.wxss'), '.from-common { color: red; }');
    fs.writeFileSync(path.join(root, 'styles/shared.wxss'), '.from-shared { margin: 20rpx; }');
    fs.writeFileSync(path.join(root, 'app.wxss'), "@import './common/main.wxss';\npage { color: #333; }");
    fs.writeFileSync(path.join(root, 'pages/a/a.wxss'), "@import '../../styles/shared.wxss';\n.x { margin: 10rpx; }");

    const result = await new AppBuilder(new MiniProgram(root)).build();
    expect(result.pageFrame).toContain('from-common');
    expect(result.pageFrame).toContain('from-shared');
  });

  it('编译失败时抛出编译器的错误信息，修复后可以重新构建', async () => {
    const root = demoProject();
    const builder = new AppBuilder(new MiniProgram(root));
    fs.writeFileSync(path.join(root, 'pages/b/b.wxml'), '<view>');
    await expect(builder.build()).rejects.toThrow(/pages\/b\/b\.wxml/);

    fs.writeFileSync(path.join(root, 'pages/b/b.wxml'), '<view>ok</view>');
    builder.invalidate(['pages/b/b.wxml']);
    await expect(builder.build()).resolves.toMatchObject({ pages: ['pages/a/a', 'pages/b/b'] });
  });
});

describe.skipIf(!hasToolchain())('完整构建：less 编译插件', () => {
  /** issue #85 的项目结构：开启 less 插件，有的页面只有 .less，有的 .wxss 只是一行注释的空壳 */
  function lessProject() {
    return createProject({
      'project.config.json': { setting: { useCompilerPlugins: ['less'] } },
      'app.json': { pages: ['pages/only-less/index', 'pages/stub/index'] },
      'app.js': 'App({})',
      'app.less': '@brand: #07c160;\npage { color: @brand; }',
      'pages/only-less/index.json': {},
      'pages/only-less/index.wxml': '<view class="page-container">a</view>',
      'pages/only-less/index.less': 'page { padding: 20rpx } .page-container { padding: 30rpx; .title { color: @brand; } }',
      'pages/stub/index.json': {},
      'pages/stub/index.wxml': '<view>b</view>',
      'pages/stub/index.wxss': '/* pages/stub/index.wxss */',
      'pages/stub/index.less': '.from-less { margin: 10rpx; }'
    });
  }

  it('只有 .less 的页面和 .wxss 是空壳的页面，样式都注册进渲染层', async () => {
    const result = await new AppBuilder(new MiniProgram(lessProject())).build();
    expect(result.pageStyles).toContain('__wxAppCode__["pages/only-less/index.wxss"] = setCssToHead');
    expect(result.pageStyles).toContain('page-container');
    expect(result.pageStyles).toContain('from-less');
    // app.less 编译成 app.wxss，进公共样式
    expect(result.pageStyles).toContain('#07c160');
  });

  it('修改 .less 后重新编译，样式随之更新', async () => {
    const root = lessProject();
    const builder = new AppBuilder(new MiniProgram(root));
    await builder.build();

    fs.writeFileSync(path.join(root, 'pages/only-less/index.less'), '.changed-in-less { color: red; }');
    expect(builder.invalidate(['pages/only-less/index.less'])).toBe(true);
    expect((await builder.build()).pageStyles).toContain('changed-in-less');
  });

  it('less 引用的 .css 修改后重新编译，样式随之更新', async () => {
    const root = lessProject();
    fs.mkdirSync(path.join(root, 'styles'));
    fs.writeFileSync(path.join(root, 'styles/theme.css'), '.theme-old { color: red; }');
    fs.writeFileSync(path.join(root, 'pages/only-less/index.less'), "@import (less) '../../styles/theme.css';");
    const builder = new AppBuilder(new MiniProgram(root));
    expect((await builder.build()).pageStyles).toContain('theme-old');

    fs.writeFileSync(path.join(root, 'styles/theme.css'), '.theme-new { color: red; }');
    expect(builder.invalidate(['styles/theme.css'])).toBe(true);
    expect((await builder.build()).pageStyles).toContain('theme-new');
  });

  it('开发中在 project.config.json 里关掉 less 插件，重新编译后改用 .wxss，不用重启', async () => {
    const root = lessProject();
    const builder = new AppBuilder(new MiniProgram(root));
    expect((await builder.build()).pageStyles).toContain('from-less');

    fs.writeFileSync(path.join(root, 'project.config.json'), JSON.stringify({ setting: { useCompilerPlugins: false } }));
    builder.invalidate(['project.config.json']);
    const result = await builder.build();
    expect(result.pageStyles).not.toContain('from-less');
    expect(result.pageStyles).not.toContain('page-container');
  });

  it('less 编译失败时构建失败并指出文件，修复后可以重新构建', async () => {
    const root = lessProject();
    const builder = new AppBuilder(new MiniProgram(root));
    fs.writeFileSync(path.join(root, 'pages/only-less/index.less'), '.x { color: @missing; }');
    await expect(builder.build()).rejects.toThrow(/pages\/only-less\/index\.less 编译失败/);

    fs.writeFileSync(path.join(root, 'pages/only-less/index.less'), '.x { color: red; }');
    builder.invalidate(['pages/only-less/index.less']);
    await expect(builder.build()).resolves.toMatchObject({ pages: ['pages/only-less/index', 'pages/stub/index'] });
  });
});
