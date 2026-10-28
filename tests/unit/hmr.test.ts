/**
 * 热更新的分流：哪些改动能热更新，哪些必须整页刷新；以及 Page() 页面换上新代码时保留哪些状态
 */

import { describe, expect, it } from 'vitest';
import { swapMethods } from '../../packages/core/src/runtime/host/hmr';
import { planHotUpdate } from '../../packages/core/src/server/hmr';

const units = { pages: ['pages/index/index', 'pages/detail/detail'], components: ['components/badge/badge'] };

describe('热更新分流', () => {
  it('页面和组件自己的 WXML 改动走模板热更新', () => {
    expect(planHotUpdate(['pages/index/index.wxml', 'components/badge/badge.wxml'], units)).toEqual({
      templates: ['pages/index/index', 'components/badge/badge'],
      scripts: [],
      styles: []
    });
  });

  it('页面和组件的 JS 改动走逻辑热更新', () => {
    expect(planHotUpdate(['pages/detail/detail.js', 'components/badge/badge.js'], units)).toEqual({
      templates: [],
      scripts: ['pages/detail/detail', 'components/badge/badge'],
      styles: []
    });
  });

  it('页面和组件的 WXSS 改动走样式热替换', () => {
    expect(planHotUpdate(['pages/index/index.wxss', 'components/badge/badge.wxss'], units)).toEqual({
      templates: [],
      scripts: [],
      styles: ['pages/index/index', 'components/badge/badge']
    });
  });

  it('less / sass 源文件和它们引用的 .css 改动走样式热替换', () => {
    expect(planHotUpdate(['pages/index/index.less', 'components/badge/badge.scss', 'app.less', 'styles/_vars.sass', 'styles/theme.css'], units)).toEqual({
      templates: [],
      scripts: [],
      styles: ['pages/index/index', 'components/badge/badge', 'app', 'styles/_vars', 'styles/theme']
    });
  });

  it.each([
    ['app.wxss', 'app'],
    ['styles/common.wxss', 'styles/common']
  ])('%s 这类公共样式（app.wxss、被 @import 的文件）改动也走样式热替换', (file, id) => {
    expect(planHotUpdate([file], units)).toEqual({ templates: [], scripts: [], styles: [id] });
  });

  it('同一次保存里页面的 WXML、JS 和 WXSS 一起热更新', () => {
    expect(planHotUpdate(['pages/index/index.wxml', 'pages/index/index.js', 'pages/index/index.wxss'], units)).toEqual({
      templates: ['pages/index/index'],
      scripts: ['pages/index/index'],
      styles: ['pages/index/index']
    });
  });

  it('同一个文件连续变化只更新一次', () => {
    expect(planHotUpdate(['pages/index/index.js', 'pages/index/index.js'], units)).toEqual({
      templates: [],
      scripts: ['pages/index/index'],
      styles: []
    });
  });

  it.each([
    ['app.js', 'App 只在启动时执行'],
    ['app.json', '配置决定页面和组件结构'],
    ['pages/index/index.json', '配置决定页面和组件结构'],
    ['utils/format.js', '普通模块要沿依赖图更新，尚未支持'],
    ['utils/format.wxs', 'wxs 会被多个模板引用'],
    ['templates/item.wxml', '被 import / include 的模板会影响多个页面'],
    ['wxa.setup.js', 'setup 必须在启动前执行'],
    ['../wxa.setup.ts', 'setup 必须在启动前执行']
  ])('%s 改动需要整页刷新（%s）', file => {
    expect(planHotUpdate([file], units)).toBeNull();
  });

  it('一次保存里只要有一个文件不能热更新，就整页刷新', () => {
    expect(planHotUpdate(['pages/index/index.wxml', 'app.js'], units)).toBeNull();
  });
});

describe('Page() 页面换上新代码', () => {
  /** 活着的页面实例：setData 合并进 data */
  const livePage = (fields: Record<string, unknown>) => {
    const page: Record<string, any> = {
      ...fields,
      setData(patch: Record<string, unknown>) {
        Object.assign(page.data, patch);
      }
    };
    return page;
  };

  it('方法一律换成新的', () => {
    const page = livePage({ data: {}, onTap: () => 'old' });
    swapMethods(page, { onTap: () => 'new', onShare: () => 'share' });

    expect(page.onTap()).toBe('new');
    expect(page.onShare()).toBe('share');
  });

  it('运行时改过的 data 保持不动，新代码新增的 data 字段补上，改了初始值的不生效', () => {
    const page = livePage({ data: { count: 5 } });
    swapMethods(page, { data: { count: 0, tab: 'all' } });

    expect(page.data).toEqual({ count: 5, tab: 'all' });
  });

  it('其他非函数字段同样视为状态：已有的不覆盖，新增的补上', () => {
    const page = livePage({ data: {}, pageSize: 20 });
    swapMethods(page, { pageSize: 50, cacheKey: 'list' });

    expect(page).toMatchObject({ pageSize: 20, cacheKey: 'list' });
  });

  it('新代码没有 data 时不调用 setData', () => {
    const page = livePage({ data: { count: 1 } });
    page.setData = () => {
      throw new Error('不应调用 setData');
    };
    expect(() => swapMethods(page, { onTap() {} })).not.toThrow();
  });
});
