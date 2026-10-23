/**
 * 界面 API：toast / loading / modal / actionSheet / 导航栏 / tabBar
 */

import type { NavigationState, PhoneShell, TabBarItem, TabBarMark } from '../ui/PhoneShell';
import { ApiHandler, fail, ok } from './registry';

export interface UiApiOptions {
  shell: PhoneShell;
  /** 修改当前页面的导航栏状态（随页面保存，返回时恢复） */
  updateNavigation: (state: Partial<NavigationState>) => void;
  /** 隐藏或显示原生 tabBar（对所有 tab 页生效） */
  setTabBarHidden: (hidden: boolean) => void;
}

export function createUiApis({ shell, updateNavigation, setTabBarHidden }: UiApiOptions): Record<string, ApiHandler> {
  const updateTabBarItem = (api: string, index: unknown, item: Partial<TabBarItem>) =>
    shell.updateTabBarItem(Number(index), item) ? undefined : fail(api, 'tabbar item not found');

  return {
    showToast: args => shell.showToast(args),
    hideToast: () => shell.hideToast(),
    showLoading: args => shell.showToast({ ...args, icon: 'loading', duration: 0 }),
    hideLoading: () => shell.hideToast(),
    showModal: async (args, { api }) => ok(api, await shell.showModal(args)),
    showActionSheet: async (args, { api }) => {
      const tapIndex = await shell.showActionSheet(args);
      return tapIndex === null ? fail(api, 'cancel') : ok(api, { tapIndex });
    },

    setNavigationBarTitle: args => updateNavigation({ title: String(args.title ?? '') }),
    setNavigationBarColor: args => updateNavigation({
      backgroundColor: args.backgroundColor,
      textStyle: String(args.frontColor).toLowerCase() === '#000000' ? 'black' : 'white'
    }),
    showNavigationBarLoading: () => shell.setNavigationLoading(true),
    hideNavigationBarLoading: () => shell.setNavigationLoading(false),
    hideTabBar: () => setTabBarHidden(true),
    showTabBar: () => setTabBarHidden(false),
    // 基础库把 removeTabBarBadge、showTabBarRedDot、hideTabBarRedDot 都转成 setTabBarBadge，用 type 区分；
    // 徽标文字超长时基础库已经换成 ...
    setTabBarBadge: (args, { api }) => updateTabBarItem(api, args.index, { mark: tabBarMark(args) }),
    setTabBarItem: (args, { api }) => updateTabBarItem(api, args.index, {
      text: args.text,
      iconPath: args.iconPath,
      selectedIconPath: args.selectedIconPath
    }),
    setTabBarStyle: args => shell.updateTabBarStyle({
      color: args.color,
      selectedColor: args.selectedColor,
      backgroundColor: args.backgroundColor,
      borderStyle: args.borderStyle
    }),
    hideHomeButton: () => undefined,
    setBackgroundColor: () => undefined,
    setBackgroundTextStyle: () => undefined,
    startPullDownRefresh: () => undefined,
    stopPullDownRefresh: () => undefined
  };
}

function tabBarMark(args: { type?: string; badgeValue?: unknown }): TabBarMark | null {
  if (args.type === 'text') return { type: 'text', text: String(args.badgeValue ?? '') };
  if (args.type === 'redDot') return { type: 'redDot' };
  return null;
}
