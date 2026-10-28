/**
 * 原生 tabBar 的外观：按 app.json 的 tabBar 配置和当前页面算出每一项的颜色、图标和文字，
 * 与 DOM 无关（PhoneShell.renderTabBar 照着画），未配置的样式取微信的默认值
 */

import type { TabBarConfig, TabBarItem, TabBarMark } from './PhoneShell';

export interface TabBarView {
  background: string;
  borderTopColor: string;
  items: TabBarItemView[];
}

export interface TabBarItemView {
  pagePath: string;
  selected: boolean;
  color: string;
  /** 图标地址，没有图标时为 null */
  icon: string | null;
  text: string;
  mark: TabBarMark | null;
}

/** @param selectedPath 当前页面是 tabBar 页面时为它的路径 */
export function tabBarView(config: TabBarConfig, selectedPath: string | null): TabBarView {
  return {
    background: config.backgroundColor || '#f7f7f7',
    borderTopColor: config.borderStyle === 'white' ? 'rgba(255,255,255,.3)' : 'rgba(0,0,0,.1)',
    items: config.list.map(item => itemView(config, item, item.pagePath === selectedPath))
  };
}

function itemView(config: TabBarConfig, item: TabBarItem, selected: boolean): TabBarItemView {
  const icon = selected ? item.selectedIconPath || item.iconPath : item.iconPath;
  return {
    pagePath: item.pagePath,
    selected,
    color: selected ? config.selectedColor || '#07c160' : config.color || '#7a7e83',
    icon: icon ? iconUrl(icon) : null,
    text: item.text || '',
    mark: item.mark || null
  };
}

/** 网络图片原样使用，包内路径相对小程序根目录 */
function iconUrl(path: string): string {
  return /^https?:\/\//.test(path) ? path : '/' + path.replace(/^\//, '');
}
