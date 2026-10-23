import path from 'path';
import { describe, expect, it } from 'vitest';
import { MiniProgram } from '../../packages/core/src/project/MiniProgram';
import { createWxConfig } from '../../packages/core/src/project/wxConfig';
import { createProject } from '../helpers';

function sampleProject() {
  return createProject({
    'project.config.json': { appid: 'wx123', miniprogramRoot: 'src/' },
    'src/app.json': {
      pages: ['pages/home/home', 'pages/list/list'],
      subPackages: [
        { root: 'pkg', pages: ['detail/detail'] },
        { root: 'solo', pages: ['entry'], independent: true }
      ],
      usingComponents: { 'g-button': '/components/button/button', 'g-rel': 'components/rel/rel' },
      tabBar: { list: [{ pagePath: 'pages/home/home', text: '首页' }] },
      window: { navigationBarTitleText: 'Demo' }
    },
    'src/pages/home/home.json': { usingComponents: { card: '../../components/card/card' }, navigationBarTitleText: 'Home' },
    'src/pages/list/list.json': { usingComponents: { 'van-cell': '@vant/weapp/cell/index' } },
    'src/pkg/detail/detail.json': {},
    'src/solo/entry.json': {},
    'src/components/button/button.json': { component: true },
    'src/components/rel/rel.json': { component: true },
    'src/components/card/card.json': {
      component: true,
      usingComponents: { inner: './inner' },
      componentGenerics: { slotted: { default: '/components/button/button' } }
    },
    'src/components/card/inner.json': { component: true },
    'src/miniprogram_npm/@vant/weapp/cell/index.json': { component: true, usingComponents: { icon: '../icon/index' } },
    'src/miniprogram_npm/@vant/weapp/icon/index.json': { component: true },
    'src/app.js': '',
    'src/node_modules/lib/index.js': '',
    'src/.hidden/x.js': '',
    'src/sitemap.json': {}
  });
}

describe('MiniProgram 项目解析', () => {
  const project = new MiniProgram(sampleProject());
  const app = project.readAppJson();

  it('按 project.config.json 的 miniprogramRoot 定位代码目录并读取 appid', () => {
    expect(path.basename(project.root)).toBe('src');
    expect(project.appid).toBe('wx123');
  });

  it('页面列表包含分包页面', () => {
    expect(project.allPages(app)).toEqual(['pages/home/home', 'pages/list/list', 'pkg/detail/detail', 'solo/entry']);
  });

  it('全局组件展开到页面，能解析到的引用都换成组件的绝对路径', () => {
    const json = project.readUnitJson('pages/home/home', app);
    expect(json.usingComponents).toEqual({
      card: '/components/card/card',
      'g-button': '/components/button/button',
      'g-rel': '/components/rel/rel'
    });
    expect(json.navigationBarTitleText).toBe('Home');
  });

  // 基础库运行时只把引用和当前路径拼在一起，不查找 miniprogram_npm、不补 /index
  describe('组件引用解析成组件路径', () => {
    const refs = new MiniProgram(createProject({
      'app.json': {
        pages: ['pages/index/index', 'pages/own/own', 'solo/entry'],
        subPackages: [{ root: 'pkg', pages: [] }, { root: 'solo', pages: ['entry'], independent: true }],
        usingComponents: {
          'my-btn': 'my-ui/btn',
          'g-dir': '/components/dir',
          'g-missing': 'components/missing/missing',
          'g-private': 'plugin-private://wxid/comp'
        }
      },
      'pages/index/index.json': { usingComponents: { box: '../../components/box/box', 'own-npm': 'my-ui/icon', 'own-dir': '../../components/dir' } },
      'pages/own/own.json': { usingComponents: { 'my-btn': '../../components/box/box', plugin: 'plugin://p/comp' } },
      'solo/entry.json': {},
      'components/box/box.json': { component: true, componentGenerics: { slotted: { default: 'my-ui/icon' }, bare: true } },
      'components/dir/index.json': { component: true },
      'miniprogram_npm/my-ui/btn/index.json': { component: true, usingComponents: { icon: '../icon/index' } },
      'miniprogram_npm/my-ui/icon/index.json': { component: true },
      'pkg/miniprogram_npm/sub-ui/index.json': { component: true }
    }));
    const refsApp = refs.readAppJson();
    const using = (id: string) => refs.readUnitJson(id, refsApp).usingComponents;

    it('全局按包名引用的 npm 组件在页面和组件里都能用，组件被收集到', () => {
      expect(using('pages/index/index')['my-btn']).toBe('/miniprogram_npm/my-ui/btn/index');
      expect(using('components/box/box')['my-btn']).toBe('/miniprogram_npm/my-ui/btn/index');
      expect(refs.collectUnits(refsApp).components).toContain('miniprogram_npm/my-ui/btn/index');
    });

    it('页面自己按包名引用 npm 组件、省略目录的 /index 时也解析好', () => {
      expect(using('pages/index/index')).toMatchObject({
        box: '/components/box/box',
        'own-npm': '/miniprogram_npm/my-ui/icon/index',
        'own-dir': '/components/dir/index'
      });
    });

    it('全局的绝对路径省略 /index 时补全', () => {
      expect(using('pages/index/index')['g-dir']).toBe('/components/dir/index');
    });

    it('抽象节点的默认实现同样解析，没有默认实现的保持原样', () => {
      expect(refs.readUnitJson('components/box/box', refsApp).componentGenerics).toEqual({
        slotted: { default: '/miniprogram_npm/my-ui/icon/index' },
        bare: true
      });
    });

    it('页面自己声明的同名组件仍然优先', () => {
      expect(using('pages/own/own')['my-btn']).toBe('/components/box/box');
    });

    it('插件组件原样保留，解析不到的全局相对引用照旧换算成相对当前页面的路径', () => {
      expect(using('pages/own/own').plugin).toBe('plugin://p/comp');
      expect(using('pages/index/index')['g-private']).toBe('plugin-private://wxid/comp');
      expect(using('pages/index/index')['g-missing']).toBe('../../components/missing/missing');
    });

    it('独立分包、主包和分包 miniprogram_npm 里的组件不展开全局引用', () => {
      expect(using('solo/entry')).toEqual({});
      expect(using('miniprogram_npm/my-ui/btn/index')).toEqual({ icon: '/miniprogram_npm/my-ui/icon/index' });
      expect(using('pkg/miniprogram_npm/sub-ui/index')).toEqual({});
    });
  });

  it('页面自己声明的同名组件优先于全局组件', () => {
    const custom = new MiniProgram(createProject({
      'app.json': { pages: ['p/p'], usingComponents: { x: '/a/a' } },
      'p/p.json': { usingComponents: { x: '/b/b' } }
    }));
    expect(custom.readUnitJson('p/p', custom.readAppJson()).usingComponents.x).toBe('/b/b');
  });

  it('递归收集组件：相对路径、绝对路径、npm 包和抽象节点默认实现', () => {
    const { components } = project.collectUnits(app);
    expect(components.sort()).toEqual([
      'components/button/button',
      'components/card/card',
      'components/card/inner',
      'components/rel/rel',
      'miniprogram_npm/@vant/weapp/cell/index',
      'miniprogram_npm/@vant/weapp/icon/index'
    ]);
  });

  it('插件组件和不存在的组件被忽略', () => {
    expect(project.resolveComponent('pages/home/home', 'plugin://x/y')).toBeNull();
    expect(project.resolveComponent('pages/home/home', './missing')).toBeNull();
  });

  it('列文件时跳过 node_modules、隐藏目录和指定目录', () => {
    expect(project.listFiles(['.js'])).toEqual(['app.js']);
  });

  it('app.json 不合法时给出文件名', () => {
    const broken = createProject({ 'app.json': '{ pages: ' });
    expect(() => new MiniProgram(broken).readAppJson()).toThrow(/app\.json 不是合法的 JSON/);
  });

  it('缺少 app.json 时报错', () => {
    expect(() => new MiniProgram(createProject({ 'a.js': '' }))).toThrow('没有 app.json');
  });
});

describe('__wxConfig', () => {
  const project = new MiniProgram(sampleProject());
  const app = project.readAppJson();
  const { pages } = project.collectUnits(app);
  const unitJson = new Map(pages.map(id => [id, project.readUnitJson(id, app)]));
  const config = createWxConfig({ app, pages, unitJson, appid: 'wx123', subPackages: project.subPackages(app) });

  it('入口页面和 tabBar 路径带 .html 后缀', () => {
    expect(config.entryPagePath).toBe('pages/home/home.html');
    expect(config.tabBar.list[0].pagePath).toBe('pages/home/home.html');
  });

  it('每个页面（含分包）都有 window 配置，全局窗口配置带默认值', () => {
    expect(Object.keys(config.page)).toEqual(pages.map(p => p + '.html'));
    expect(config.page['pages/home/home.html'].window.navigationBarTitleText).toBe('Home');
    expect(config.global.window).toMatchObject({ navigationBarTitleText: 'Demo', backgroundColor: '#ffffff' });
  });

  it('包含基础库运行需要的账号与启动信息', () => {
    expect(config.accountInfo.appId).toBe('wx123');
    expect(config.appLaunchInfo).toEqual({ scene: 1001, path: 'pages/home/home', query: {} });
    expect(config.platform).toBe('devtools');
  });
});
