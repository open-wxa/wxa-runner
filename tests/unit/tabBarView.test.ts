/**
 * 原生 tabBar 的外观：按 app.json 的 tabBar 配置和当前页面，算出外壳要画的每一项
 */

import { describe, expect, it } from 'vitest';
import { tabBarView } from '../../packages/core/src/runtime/host/ui/tabBarView';

const list = [
  { pagePath: 'pages/index/index', text: '首页', iconPath: 'images/home.png', selectedIconPath: 'images/home-on.png' },
  { pagePath: 'pages/me/me', text: '我的', iconPath: '/images/me.png' }
];

describe('原生 tabBar 外观', () => {
  it('当前页面对应的项用选中颜色和选中图标，其他项用普通颜色和图标', () => {
    const { items } = tabBarView({ list, color: '#999', selectedColor: '#f00' }, 'pages/index/index');

    expect(items[0]).toMatchObject({ selected: true, color: '#f00', icon: '/images/home-on.png', text: '首页' });
    expect(items[1]).toMatchObject({ selected: false, color: '#999', icon: '/images/me.png', text: '我的' });
  });

  it('选中的项没配选中图标时沿用普通图标', () => {
    expect(tabBarView({ list }, 'pages/me/me').items[1]).toMatchObject({ selected: true, icon: '/images/me.png' });
  });

  it('没配颜色、背景和边框时用微信的默认样式', () => {
    const view = tabBarView({ list }, 'pages/index/index');

    expect(view).toMatchObject({ background: '#f7f7f7', borderTopColor: 'rgba(0,0,0,.1)' });
    expect(view.items.map(item => item.color)).toEqual(['#07c160', '#7a7e83']);
  });

  it('borderStyle 为 white 时边框是浅色', () => {
    expect(tabBarView({ list, borderStyle: 'white', backgroundColor: '#000' }, null))
      .toMatchObject({ background: '#000', borderTopColor: 'rgba(255,255,255,.3)' });
  });

  it('网络图片原样使用，包内路径不论开头有没有斜杠都从站点根目录取', () => {
    const view = tabBarView({ list: [{ pagePath: 'a', iconPath: 'https://cdn.example.com/a.png' }, ...list] }, null);

    expect(view.items.map(item => item.icon)).toEqual(['https://cdn.example.com/a.png', '/images/home.png', '/images/me.png']);
  });

  it('没有图标和文字的项给出空图标和空文字，徽标和红点原样带上', () => {
    const view = tabBarView({ list: [{ pagePath: 'a', mark: { type: 'redDot' } }, { pagePath: 'b', mark: null }] }, null);

    expect(view.items).toEqual([
      expect.objectContaining({ pagePath: 'a', icon: null, text: '', mark: { type: 'redDot' } }),
      expect.objectContaining({ pagePath: 'b', icon: null, text: '', mark: null })
    ]);
  });
});
