import { describe, expect, it } from 'vitest';
import { MiniProgram } from '../../packages/core/src/project/MiniProgram';
import { createWxConfig } from '../../packages/core/src/project/wxConfig';
import { createProject } from '../helpers';

const APPID = 'wx0000000000000001';
const EXT_APPID = 'wx0000000000000002';

/** 一个最小项目；files 用来覆盖或追加文件（如 ext.json） */
function project(files: Record<string, string | object> = {}): string {
  return createProject({
    'project.config.json': { appid: APPID, miniprogramRoot: '' },
    'app.json': { pages: ['pages/a/a'], window: { navigationBarTitleText: '普通' } },
    'app.js': 'App({})',
    'pages/a/a.json': {},
    'pages/a/a.wxml': '<view>a</view>',
    'pages/a/a.js': 'Page({})',
    ...files
  });
}

function buildConfig(projectPath: string) {
  const program = new MiniProgram(projectPath);
  const app = program.applyExtJson(program.readAppJson());
  const pages = program.allPages(app);
  const unitJson = new Map(pages.map(id => [id, program.readUnitJson(id, app)]));
  program.applyExtPages(unitJson);
  return createWxConfig({
    app,
    pages,
    unitJson,
    appid: program.runtimeAppid,
    subPackages: program.subPackages(app),
    extJson: program.activeExtJson()
  });
}

describe('ext.json（三方平台代开发）', () => {
  it('没有 ext.json 时走普通模式：appid 用 project.config.json，ext 为空', () => {
    const program = new MiniProgram(project());
    expect(program.activeExtJson()).toBeNull();
    expect(program.runtimeAppid).toBe(APPID);

    const config = buildConfig(program.projectPath);
    expect(config.appname).toBe(APPID);
    expect(config.accountInfo.appId).toBe(APPID);
    expect(config.ext).toEqual({});
    expect(config.extAppid).toBe('');
    expect(config.extEnable).toBe(false);
  });

  it('有 ext.json 时自动走代开发模式：运行时 appid、ext、账号信息都用授权方', () => {
    const ext = { runtimeEnv: 'test', appId: EXT_APPID, proxy: { enabled: false } };
    const program = new MiniProgram(project({
      'ext.json': { extEnable: true, extAppid: EXT_APPID, ext, 自定义配置: { theme: 'dark' } }
    }));

    expect(program.runtimeAppid).toBe(EXT_APPID);

    const config = buildConfig(program.projectPath);
    expect(config.appname).toBe(EXT_APPID);
    expect(config.accountInfo.appId).toBe(EXT_APPID);
    expect(config.extAppid).toBe(EXT_APPID);
    expect(config.extEnable).toBe(true);
    // 基础库的 wx.getExtConfig / getExtConfigSync 直接读这个字段
    expect(config.ext).toEqual(ext);
  });

  it('extEnable 为 false 时不生效，回到普通模式', () => {
    const program = new MiniProgram(project({
      'ext.json': { extEnable: false, extAppid: EXT_APPID, ext: { a: 1 } }
    }));
    expect(program.activeExtJson()).toBeNull();
    expect(program.runtimeAppid).toBe(APPID);
    expect(buildConfig(program.projectPath).ext).toEqual({});
  });

  it('extEnable 没写时按不启用处理，与微信文档的必填约定一致', () => {
    const program = new MiniProgram(project({
      'ext.json': { extAppid: EXT_APPID, ext: { a: 1 } }
    }));
    expect(program.activeExtJson()).toBeNull();
    expect(program.runtimeAppid).toBe(APPID);
    expect(buildConfig(program.projectPath).ext).toEqual({});
  });

  it('ext.json 只合并 app.json 允许覆盖的字段，自定义配置不会污染小程序配置', () => {
    const program = new MiniProgram(project({
      'ext.json': {
        extEnable: true,
        extAppid: EXT_APPID,
        ext: {},
        window: { navigationBarTitleText: '代开发标题' },
        tabBar: { list: [{ pagePath: 'pages/a/a', text: '首页' }] },
        自定义配置: { theme: 'dark' }
      }
    }));

    const app = program.applyExtJson(program.readAppJson());
    expect(app.window).toEqual({ navigationBarTitleText: '代开发标题' });
    expect(app.tabBar?.list[0].pagePath).toBe('pages/a/a');
    expect(app.自定义配置).toBeUndefined();
  });

  it('extPages 覆盖指定页面的配置', () => {
    const program = new MiniProgram(project({
      'ext.json': {
        extEnable: true,
        extAppid: EXT_APPID,
        ext: {},
        extPages: { 'pages/a/a': { navigationBarTitleText: '授权方标题' } }
      }
    }));

    const config = buildConfig(program.projectPath);
    expect(config.page['pages/a/a.html'].window.navigationBarTitleText).toBe('授权方标题');
  });
});
