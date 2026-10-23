/**
 * 模拟手机外壳：刘海、状态栏、导航栏、胶囊按钮、页面容器、tabBar 和系统弹层
 */

import type { DeviceProfile } from '../../types';
import { menuButtonRect, NAVIGATION_BAR_HEIGHT, TAB_BAR_HEIGHT } from '../api/system';
import { element } from './dom';
import { openImagePreview } from './ImagePreview';
import { openPicker, PickerOptions, PickerSession } from './Picker';
import { DEVICE_BEZEL, SHELL_CSS, STAGE_GAP, STAGE_PADDING } from './styles';

export interface NavigationState {
  title: string;
  backgroundColor: string;
  textStyle: string;
  showBack: boolean;
  custom: boolean;
}

export interface TabBarStyle {
  color?: string;
  selectedColor?: string;
  backgroundColor?: string;
  borderStyle?: string;
}

export interface TabBarConfig extends TabBarStyle {
  custom?: boolean;
  list: TabBarItem[];
}

/** 每一项右上角最多一个标记：徽标和红点互相替换 */
export type TabBarMark = { type: 'text'; text: string } | { type: 'redDot' };

export interface TabBarItem {
  pagePath: string;
  text?: string;
  iconPath?: string;
  selectedIconPath?: string;
  /** null 表示清除 */
  mark?: TabBarMark | null;
}

export interface SafeAreaInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ToastOptions {
  title?: string;
  icon?: 'success' | 'error' | 'loading' | 'none';
  image?: string;
  duration?: number;
  mask?: boolean;
}

export interface ModalOptions {
  title?: string;
  content?: string;
  showCancel?: boolean;
  cancelText?: string;
  cancelColor?: string;
  confirmText?: string;
  confirmColor?: string;
  editable?: boolean;
  placeholderText?: string;
}

export interface ActionSheetOptions {
  alertText?: string;
  itemList: string[];
  itemColor?: string;
}

type ScaleMode = 'fit' | '1';

const SCALE_STORAGE_KEY = 'wxa-runner:scale';
const MIN_SCALE = 0.5;
const NOTICE_DURATION = 6000;

/** 手动打开时默认适应窗口；自动化环境默认 1:1，截图和视觉基线不随窗口大小变化 */
function loadScaleMode(): ScaleMode {
  try {
    const saved = localStorage.getItem(SCALE_STORAGE_KEY);
    if (saved === 'fit' || saved === '1') return saved;
  } catch {
    // 存储不可用时用默认值
  }
  return navigator.webdriver ? '1' : 'fit';
}

export class PhoneShell {
  readonly pages: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly slot: HTMLElement;
  private readonly device: HTMLElement;
  private readonly toolbar: HTMLElement;
  private readonly scaleButton: HTMLButtonElement;
  private scaleMode = loadScaleMode();
  private readonly statusBar: HTMLElement;
  private readonly navBar: HTMLElement;
  private readonly capsule: HTMLElement;
  private readonly navTitle: HTMLElement;
  private readonly backButton: HTMLButtonElement;
  private readonly tabBar: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly routeLabel: HTMLElement;
  private toastEl: HTMLElement | null = null;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private noticeEl: HTMLElement | null = null;
  private noticeTimer: ReturnType<typeof setTimeout> | null = null;
  private tabBarConfig: TabBarConfig | null = null;
  private onTabTap: (pagePath: string, index: number) => void = () => undefined;
  private navigation: NavigationState = { title: '', backgroundColor: '#000', textStyle: 'white', showBack: false, custom: false };
  /** 当前页面是 tabBar 页面时为它的路径 */
  private tabBarPath: string | null = null;
  /** wx.hideTabBar 设置，对所有 tab 页生效，直到 wx.showTabBar */
  private tabBarHidden = false;

  constructor(root: HTMLElement, private readonly profile: DeviceProfile) {
    const style = document.createElement('style');
    style.textContent = SHELL_CSS;
    document.head.appendChild(style);

    // 刘海屏的状态栏比传统机型（20px）高，以此区分是否绘制刘海
    const hasNotch = profile.statusBarHeight > 20;
    const capsule = menuButtonRect(profile);
    root.innerHTML = `
      <div class="wxa-stage">
        <div class="wxa-device-slot">
          <div class="wxa-device${hasNotch ? ' has-notch' : ''}" style="width:${profile.screenWidth}px;height:${profile.screenHeight}px;--wxa-safe-bottom:${profile.safeAreaBottom}px">
            <div class="wxa-statusbar" style="height:${profile.statusBarHeight}px">
              <span class="wxa-statusbar-time">9:41</span>
              <span class="wxa-statusbar-icons">${STATUS_ICONS}</span>
            </div>
            <div class="wxa-navbar">
              <button class="wxa-navbar-back" title="返回" aria-label="返回">${BACK_ICON}</button>
              <span class="wxa-navbar-loading"></span><span class="wxa-navbar-title"></span>
            </div>
            <div class="wxa-pages"></div>
            <div class="wxa-tabbar is-hidden"></div>
            <div class="wxa-capsule" style="top:${capsule.top}px;left:${capsule.left}px;width:${capsule.width}px;height:${capsule.height}px">
              <span class="wxa-capsule-more">${MORE_ICON}</span><span class="wxa-capsule-close">${CLOSE_ICON}</span>
            </div>
            <div class="wxa-overlay"></div>
            ${hasNotch ? '<div class="wxa-notch"></div>' : ''}
            ${profile.safeAreaBottom ? '<div class="wxa-home-indicator"></div>' : ''}
          </div>
        </div>
        <div class="wxa-toolbar">
          <span class="wxa-route"></span><button class="wxa-scale"></button><button class="wxa-reload">刷新</button>
        </div>
      </div>`;

    this.stage = root.querySelector('.wxa-stage')!;
    this.slot = root.querySelector('.wxa-device-slot')!;
    this.device = root.querySelector('.wxa-device')!;
    this.toolbar = root.querySelector('.wxa-toolbar')!;
    this.scaleButton = root.querySelector('.wxa-scale')!;
    this.statusBar = root.querySelector('.wxa-statusbar')!;
    this.navBar = root.querySelector('.wxa-navbar')!;
    this.capsule = root.querySelector('.wxa-capsule')!;
    this.navTitle = root.querySelector('.wxa-navbar-title')!;
    this.backButton = root.querySelector('.wxa-navbar-back')!;
    this.pages = root.querySelector('.wxa-pages')!;
    this.tabBar = root.querySelector('.wxa-tabbar')!;
    this.overlay = root.querySelector('.wxa-overlay')!;
    this.routeLabel = root.querySelector('.wxa-route')!;
    root.querySelector('.wxa-reload')!.addEventListener('click', () => location.reload());

    this.scaleButton.addEventListener('click', () => {
      this.scaleMode = this.scaleMode === 'fit' ? '1' : 'fit';
      try {
        localStorage.setItem(SCALE_STORAGE_KEY, this.scaleMode);
      } catch {
        // 只影响记住选择
      }
      this.applyScale();
    });
    window.addEventListener('resize', () => this.applyScale());
    this.applyScale();
  }

  /**
   * 窗口放不下时整体缩小手机。只用 transform：iframe 内的布局、字号、坐标都不变，
   * Playwright 也能正确换算点击位置；CSS zoom 会让 Playwright 点击错位。
   * transform 不改变占位，所以由外层 slot 按缩放后的尺寸占位。
   */
  private applyScale() {
    const width = this.profile.screenWidth + DEVICE_BEZEL * 2;
    const height = this.profile.screenHeight + DEVICE_BEZEL * 2;
    let scale = 1;
    if (this.scaleMode === 'fit') {
      const availableWidth = window.innerWidth - STAGE_PADDING * 2;
      const availableHeight = window.innerHeight - STAGE_PADDING * 2 - STAGE_GAP - this.toolbar.offsetHeight;
      const fit = Math.floor(Math.min(availableWidth / width, availableHeight / height) * 100) / 100;
      scale = Math.min(1, Math.max(MIN_SCALE, fit));
    }
    this.slot.style.width = `${width * scale}px`;
    this.slot.style.height = `${height * scale}px`;
    this.device.style.left = this.device.style.top = `${DEVICE_BEZEL * scale}px`;
    this.device.style.transform = scale === 1 ? '' : `scale(${scale})`;
    this.scaleButton.textContent = `${Math.round(scale * 100)}%`;
    this.scaleButton.title = this.scaleMode === 'fit' ? '适应窗口，点击切换为实际大小' : '实际大小，点击切换为适应窗口';
  }

  onBack(handler: () => void) {
    this.backButton.addEventListener('click', handler);
  }

  setTabBar(config: TabBarConfig | undefined, onTap: (pagePath: string, index: number) => void) {
    this.tabBarConfig = config && config.list?.length && !config.custom ? config : null;
    this.onTabTap = onTap;
  }

  setRoute(route: string) {
    this.routeLabel.textContent = route;
  }

  setNavigation(state: Partial<NavigationState>) {
    this.navigation = { ...this.navigation, ...state };
    const { title, backgroundColor, textStyle, showBack, custom } = this.navigation;
    const color = textStyle === 'black' ? '#000' : '#fff';

    this.navTitle.textContent = title;
    this.backButton.style.visibility = showBack ? 'visible' : 'hidden';
    this.navBar.classList.toggle('is-hidden', custom);
    this.navBar.style.background = backgroundColor;
    this.navBar.style.color = color;
    // 自定义导航栏时页面从屏幕顶部开始绘制，状态栏浮在页面上；
    // 与微信一致，状态栏文字和胶囊配色仍跟随 navigationBarTextStyle
    this.statusBar.style.background = custom ? 'transparent' : backgroundColor;
    this.statusBar.style.color = color;
    this.capsule.classList.toggle('is-light', textStyle !== 'black');
    this.statusBar.style.position = custom ? 'absolute' : '';
    this.statusBar.style.left = this.statusBar.style.right = custom ? '0' : '';
    this.statusBar.style.zIndex = custom ? '5' : '';
  }

  getNavigation(): NavigationState {
    return { ...this.navigation };
  }

  setNavigationLoading(loading: boolean) {
    this.navBar.classList.toggle('is-loading', loading);
  }

  /** 该页面是否显示原生 tabBar（自定义 tabBar、被 wx.hideTabBar 隐藏的都不算） */
  hasTabBar(pagePath: string): boolean {
    return !this.tabBarHidden && !!this.tabBarConfig?.list.some(item => item.pagePath === pagePath);
  }

  setTabBarHidden(hidden: boolean) {
    this.tabBarHidden = hidden;
    this.renderTabBar(this.tabBarPath);
  }

  /** 没有原生 tabBar（未配置或自定义 tabBar）时什么都不做 */
  updateTabBarStyle(style: TabBarStyle) {
    if (!this.tabBarConfig) return;
    Object.assign(this.tabBarConfig, definedOnly(style));
    this.renderTabBar(this.tabBarPath);
  }

  /** 返回 false 表示 index 越界；没有原生 tabBar 时什么都不做 */
  updateTabBarItem(index: number, item: Partial<Omit<TabBarItem, 'pagePath'>>): boolean {
    if (!this.tabBarConfig) return true;
    const target = this.tabBarConfig.list[index];
    if (!target) return false;
    Object.assign(target, definedOnly(item));
    this.renderTabBar(this.tabBarPath);
    return true;
  }

  /**
   * 页面窗口里 env(safe-area-inset-*) 的取值：窗口贴着屏幕边缘的一侧才有安全区。
   * 默认导航栏下窗口在导航栏下方，tabBar 页面的窗口止于 tabBar 上方。
   */
  safeAreaInsetsFor(pagePath: string, navigation: Pick<NavigationState, 'custom'>): SafeAreaInsets {
    return {
      top: navigation.custom ? this.profile.statusBarHeight : 0,
      right: 0,
      bottom: this.hasTabBar(pagePath) ? 0 : this.profile.safeAreaBottom,
      left: 0
    };
  }

  /** 当前页面是 tabBar 页面时传入它的路径，否则传 null */
  renderTabBar(selectedPath: string | null) {
    const config = this.tabBarConfig;
    this.tabBarPath = selectedPath;
    const visible = this.tabBarVisible();
    this.tabBar.classList.toggle('is-hidden', !visible);
    if (!config || !visible) return;

    this.tabBar.style.background = config.backgroundColor || '#f7f7f7';
    this.tabBar.style.borderTopColor = config.borderStyle === 'white' ? 'rgba(255,255,255,.3)' : 'rgba(0,0,0,.1)';
    this.tabBar.innerHTML = '';
    config.list.forEach((item, index) => {
      const selected = item.pagePath === selectedPath;
      const el = document.createElement('div');
      el.className = 'wxa-tabbar-item' + (selected ? ' is-selected' : '');
      el.dataset.pagePath = item.pagePath;
      el.style.color = selected ? (config.selectedColor || '#07c160') : (config.color || '#7a7e83');
      const icon = selected ? item.selectedIconPath || item.iconPath : item.iconPath;
      const iconBox = element('span', 'wxa-tabbar-icon');
      if (icon) {
        const img = document.createElement('img');
        img.src = /^https?:\/\//.test(icon) ? icon : '/' + icon.replace(/^\//, '');
        iconBox.appendChild(img);
        el.appendChild(iconBox);
      }
      const text = element('span', 'wxa-tabbar-text', item.text || '');
      el.appendChild(text);
      // 没有图标时标记挂在文字右上角
      if (item.mark) (icon ? iconBox : text).appendChild(markElement(item.mark));
      el.addEventListener('click', () => this.onTabTap(item.pagePath, index));
      this.tabBar.appendChild(el);
    });
  }

  private tabBarVisible(): boolean {
    return this.tabBarPath !== null && this.hasTabBar(this.tabBarPath);
  }

  /** 页面可用高度，与 getSystemInfo().windowHeight 对应；tabBar 会连同底部安全区一起占掉 */
  windowHeight(): number {
    return this.profile.screenHeight
      - this.screenTop()
      - (this.tabBarVisible() ? TAB_BAR_HEIGHT + this.profile.safeAreaBottom : 0);
  }

  /** 页面窗口顶部到屏幕顶部的距离，与 getWindowInfo().screenTop 对应 */
  screenTop(): number {
    return this.navigation.custom ? 0 : this.profile.statusBarHeight + NAVIGATION_BAR_HEIGHT;
  }

  showToast(options: ToastOptions) {
    this.hideToast();
    const icon = options.image ? 'image' : options.icon || 'success';
    const wrapper = document.createElement('div');
    if (options.mask) wrapper.appendChild(maskElement(false));

    const toast = document.createElement('div');
    toast.className = 'wxa-toast' + (icon === 'none' ? '' : ' has-icon');
    toast.setAttribute('role', 'alert');
    if (icon === 'loading') {
      toast.appendChild(element('div', 'wxa-toast-spinner'));
    } else if (icon === 'image') {
      const img = document.createElement('img');
      img.src = options.image!;
      img.width = img.height = 40;
      toast.appendChild(img);
    } else if (icon !== 'none') {
      toast.appendChild(element('div', 'wxa-toast-icon', icon === 'error' ? '✕' : '✓'));
    }
    toast.appendChild(element('div', 'wxa-toast-title', options.title || ''));
    wrapper.appendChild(toast);

    this.overlay.appendChild(wrapper);
    this.toastEl = wrapper;
    if (icon !== 'loading' || options.duration) {
      this.toastTimer = setTimeout(() => this.hideToast(), options.duration ?? 1500);
    }
  }

  hideToast() {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = null;
    this.toastEl?.remove();
    this.toastEl = null;
  }

  showModal(options: ModalOptions): Promise<{ confirm: boolean; cancel: boolean; content?: string }> {
    return new Promise(resolve => {
      const wrapper = document.createElement('div');
      wrapper.appendChild(maskElement(true));
      const modal = element('div', 'wxa-modal');
      modal.setAttribute('role', 'dialog');
      if (options.title) modal.appendChild(element('div', 'wxa-modal-title', options.title));
      if (options.content && !options.editable) modal.appendChild(element('div', 'wxa-modal-content', options.content));

      let input: HTMLInputElement | null = null;
      if (options.editable) {
        input = document.createElement('input');
        input.className = 'wxa-modal-input';
        input.value = options.content || '';
        input.placeholder = options.placeholderText || '';
        modal.appendChild(input);
      }

      const actions = element('div', 'wxa-modal-actions');
      const close = (confirm: boolean) => {
        wrapper.remove();
        resolve({ confirm, cancel: !confirm, ...(options.editable ? { content: input!.value } : {}) });
      };
      if (options.showCancel !== false) {
        const cancel = element('button', 'wxa-modal-cancel', options.cancelText || '取消');
        cancel.style.color = options.cancelColor || '#000';
        cancel.addEventListener('click', () => close(false));
        actions.appendChild(cancel);
      }
      const confirm = element('button', 'wxa-modal-confirm', options.confirmText || '确定');
      confirm.style.color = options.confirmColor || '#576b95';
      confirm.addEventListener('click', () => close(true));
      actions.appendChild(confirm);
      modal.appendChild(actions);

      wrapper.appendChild(modal);
      this.overlay.appendChild(wrapper);
    });
  }

  showActionSheet(options: ActionSheetOptions): Promise<number | null> {
    return new Promise(resolve => {
      const wrapper = document.createElement('div');
      const mask = maskElement(true);
      const sheet = element('div', 'wxa-actionsheet');
      const close = (index: number | null) => {
        wrapper.remove();
        resolve(index);
      };

      if (options.alertText) sheet.appendChild(element('div', 'wxa-actionsheet-alert', options.alertText));
      options.itemList.forEach((text, index) => {
        const button = element('button', 'wxa-actionsheet-item', text);
        button.style.color = options.itemColor || '#000';
        button.addEventListener('click', () => close(index));
        sheet.appendChild(button);
      });
      const cancel = element('button', 'wxa-actionsheet-cancel', '取消');
      cancel.addEventListener('click', () => close(null));
      sheet.appendChild(cancel);
      mask.addEventListener('click', () => close(null));

      wrapper.append(mask, sheet);
      this.overlay.appendChild(wrapper);
    });
  }

  showPicker(options: PickerOptions): PickerSession {
    return openPicker(this.overlay, options);
  }

  showImagePreview(urls: string[], current: number) {
    openImagePreview(this.overlay, urls, current);
  }

  /**
   * 在手机外面提示 wxa-runner 自身的问题（如借用开发者工具登录态失败），不混进小程序的界面。
   * 同一时间只显示一条，新的替换旧的：业务代码反复重试时不会堆满屏幕
   */
  showNotice(title: string, message: string) {
    this.hideNotice();
    const notice = element('div', 'wxa-notice');
    notice.setAttribute('role', 'alert');
    const text = element('div', 'wxa-notice-text');
    text.append(element('div', 'wxa-notice-title', title), element('div', 'wxa-notice-message', message));
    const close = element('button', 'wxa-notice-close', '×');
    close.setAttribute('aria-label', '关闭');
    close.addEventListener('click', () => this.hideNotice());
    notice.append(element('span', 'wxa-notice-icon', '!'), text, close);

    this.stage.appendChild(notice);
    this.noticeEl = notice;
    this.noticeTimer = setTimeout(() => this.hideNotice(), NOTICE_DURATION);
  }

  hideNotice() {
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = null;
    this.noticeEl?.remove();
    this.noticeEl = null;
  }

  showError(message: string) {
    this.clearError();
    const el = element('div', 'wxa-error', message);
    this.device.appendChild(el);
  }

  clearError() {
    this.device.querySelector('.wxa-error')?.remove();
  }
}

function markElement(mark: TabBarMark): HTMLElement {
  return mark.type === 'redDot' ? element('span', 'wxa-tabbar-dot') : element('span', 'wxa-tabbar-badge', mark.text);
}

/** wx 接口没传的字段是 undefined，合并时不能覆盖原值 */
function definedOnly<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function maskElement(dim: boolean): HTMLElement {
  return element('div', 'wxa-mask' + (dim ? ' is-dim' : ''));
}

const BACK_ICON = '<svg width="12" height="20" viewBox="0 0 12 20"><path d="M10 2 2 10l8 8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const MORE_ICON = '<svg width="22" height="8" viewBox="0 0 22 8" fill="currentColor"><circle cx="3.5" cy="4" r="2.3"/><circle cx="11" cy="4" r="3.3"/><circle cx="18.5" cy="4" r="2.3"/></svg>';

const CLOSE_ICON = '<svg width="20" height="20" viewBox="0 0 20 20"><circle cx="10" cy="10" r="8.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="10" cy="10" r="3.4" fill="currentColor"/></svg>';

const STATUS_ICONS = [
  // 信号
  '<svg width="17" height="11" viewBox="0 0 17 11" fill="currentColor"><rect x="0" y="7" width="3" height="4" rx=".8"/><rect x="4.6" y="5" width="3" height="6" rx=".8"/><rect x="9.2" y="2.6" width="3" height="8.4" rx=".8"/><rect x="13.8" y="0" width="3" height="11" rx=".8"/></svg>',
  // Wi-Fi
  '<svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor"><path d="M8 11.2L5.45 8.65A3.6 3.6 0 0 1 10.55 8.65ZM2.77 5.97A7.4 7.4 0 0 1 13.23 5.97L11.68 7.52A5.2 5.2 0 0 0 4.32 7.52ZM0.08 3.28A11.2 11.2 0 0 1 15.92 3.28L14.36 4.84A9 9 0 0 0 1.64 4.84Z"/></svg>',
  // 电池
  '<svg width="25" height="12" viewBox="0 0 25 12"><rect x=".5" y=".5" width="21.5" height="11" rx="3.2" fill="none" stroke="currentColor" stroke-opacity=".4"/><rect x="2" y="2" width="18.5" height="8" rx="1.8" fill="currentColor"/><path d="M23.4 4v4a2.2 2.2 0 0 0 0-4z" fill="currentColor" fill-opacity=".45"/></svg>'
].join('');
