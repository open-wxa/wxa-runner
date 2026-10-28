/**
 * 热更新：不刷新宿主，应用样式、模板和页面逻辑的改动，保留页面状态（哪些改动能热更新见 server/hmr.ts）
 *
 * 样式在每个渲染层里原地替换（见 updateStyles）；模板和逻辑借助基础库为开发者工具准备的接口
 * __virtualDOM__.updateWxAppCode（开关见 server/html.ts）：
 * - 模板：按模板路径更新，基础库用实例当前的 data 重新渲染
 * - Page() 构造的页面：不走基础库按 .js 路径的更新——那会重新挂载页面（onUnload → onLoad），data 回到初始值。
 *   这里把新方法换到活着的页面实例上，再重新注册 Page，之后新打开的页面用新代码
 * - Component() 构造的页面和组件（uni-app 的页面也是）：状态常在框架自己的实例里（如 Vue 的 setup），
 *   换方法保不住，交给基础库按 .js 路径重新挂载这些实例；页面栈、globalData、其他页面不受影响
 */

import type { Host } from './Host';

export interface HotUpdate {
  version: number;
  templates: string[];
  scripts: string[];
  styles: string[];
}

/**
 * @throws 拿不到新代码、新代码执行出错、模块没有调用 Page() / Component() 等无法热更新的情况；调用方应整页刷新
 */
export async function applyHotUpdate(host: Host, update: HotUpdate): Promise<void> {
  const code = await fetchHotCode(update);

  // 与路由串行：跳转进行到一半时页面列表和实例都不稳定
  await host.enqueueRoute(async () => {
    const service = host.serviceWindow() as any;
    if (!service?.__virtualDOM__?.updateWxAppCode) throw new Error('基础库的热更新开关没有打开');
    const pageWindows = host.livePages().flatMap(page => (page.win ? [page.win as any] : []));

    if (code.pageStyles !== null) {
      for (const win of pageWindows) updateStyles(win, code.pageStyles);
    }
    if (code.templates) {
      // 渲染层先换上新模板，逻辑层随后发出的重新渲染指令才能对上
      for (const win of pageWindows) updateTemplates(win, code.templates.page, update.templates);
      updateTemplates(service, code.templates.service, update.templates);
    }
    update.scripts.forEach((id, index) => updateScript(service, host, id, code.scripts[index]));
  });
}

interface HotCode {
  /** 没有样式改动时为 null */
  pageStyles: string | null;
  /** 渲染层和逻辑层各自的模板代码；没有模板改动时为 null */
  templates: { page: string; service: string } | null;
  /** 与 update.scripts 一一对应 */
  scripts: string[];
}

/** 只取这次改动涉及的代码，带上版本号避开缓存 */
async function fetchHotCode(update: HotUpdate): Promise<HotCode> {
  const v = `?v=${update.version}`;
  const [pageStyles, templates, scripts] = await Promise.all([
    update.styles.length > 0 ? fetchText(`/__wxa__/page-styles.js${v}`) : null,
    update.templates.length > 0
      ? Promise.all([fetchText(`/__wxa__/page-templates.js${v}`), fetchText(`/__wxa__/service-templates.js${v}`)])
        .then(([page, service]) => ({ page, service }))
      : null,
    Promise.all(update.scripts.map(id => fetchText(`/__wxa__/module/${encodeURI(id)}.js${v}`)))
  ]);
  return { pageStyles, templates, scripts };
}

/**
 * 重新执行公共样式（app.wxss、被 @import 的文件），再重放这个渲染层用过的页面和组件样式。
 * 不区分改了哪个文件：没改的样式写回相同的内容
 *
 * 基础库按「路径:组件 class 前缀」登记样式表，同一个 key 再次写入时原地替换 <style> 的内容。
 * 每次写入会多登记一个 rpx 重算回调（窗口尺寸变化时重新生成样式），回调按登记顺序执行，最新的样式最后写入
 *
 * 不用基础库为 .wxss 登记的 updateWxAppCode 回调：它按组件的方式注入页面样式，页面里合法的 ID、标签选择器
 * 每次都会报「组件中不允许」的警告，page-isolated 的页面还会换成带组件前缀的另一份样式、旧样式留在原处
 */
function updateStyles(win: any, code: string) {
  const sheets: Record<string, StyleSheetEntry> | undefined = win.__styleSheetManager2__?._pathMap;
  if (!sheets) throw new Error('基础库没有样式表管理器，无法热替换样式');
  const applied = Object.keys(sheets);
  runScript(win, code);

  for (const key of applied) {
    const [, file, classPrefix] = /^\.\/(.+\.wxss):(.*)$/.exec(key) || [];
    // app.wxss 等公共样式没有注册到 __wxAppCode__，执行 code 时已经替换
    const inject = file && win.__wxAppCode__[file];
    if (typeof inject === 'function') inject(classPrefix);
  }
  restoreSheetOrder(Object.values(sheets));
  // 与基础库自己更新样式后一样通知组件重新布局，如 movable-area 重新计算尺寸
  win.wx.triggerPageReRender();
}

interface StyleSheetEntry {
  inserted: boolean;
  style: HTMLStyleElement;
}

/**
 * 加载时为空的样式表只登记、不插入页面，第一次写入内容时追加在 head 末尾，排到了本该在它后面的样式之后。
 * 按登记顺序（即加载时的注入顺序）挪回原位，层叠结果才与刷新后一致
 */
function restoreSheetOrder(sheets: StyleSheetEntry[]) {
  let next: HTMLStyleElement | null = null;
  for (const { inserted, style } of sheets.reverse()) {
    // 被基础库移出页面的不参与排序，如 page-isolated 页面里的 app.wxss
    if (!inserted || !style.isConnected) continue;
    if (next && style.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_PRECEDING) next.before(style);
    next = style;
  }
}

function updateTemplates(win: any, code: string, units: string[]) {
  // wcc 生成的模板把编译结果缓存在 __WXML_GLOBAL__ 上，不清掉的话新代码会读到旧缓存。
  // 保留 wxs_nf_init：WXS 运行时只能初始化一次，重复执行会因改写内置对象原型而报错
  const cache = win.__WXML_GLOBAL__;
  if (cache) Object.assign(cache, { ops_cached: {}, ops_set: {}, ops_init: {}, debuginfo_set: {}, modules: {} });
  runScript(win, code);

  for (const id of units) {
    const generate = win.__wxAppCode__[id + '.wxml'];
    if (generate) win.__virtualDOM__.updateWxAppCode(id + '.wxml', generate);
  }
}

/** 每次热更新的模块 id 都不同：同一个构建版本也可能被应用两次 */
let hotModuleSeq = 0;

function updateScript(service: any, host: Host, id: string, moduleScript: string) {
  // 基础库忽略对已有模块的重复 define，新代码换个同目录的模块 id 执行：相对路径的 require 解析结果不变，
  // 它依赖的模块直接取缓存，不会重新执行
  const registration = loadModule(service, moduleScript, `${id}.hot-${++hotModuleSeq}.js`);
  if (!registration) throw new Error(`${id}.js 没有调用 Page() 或 Component()，无法热更新`);

  if (registration.constructor === service.Page) {
    for (const page of host.livePages()) {
      if (page.path !== id) continue;
      const instance = service.__virtualDOM__.getRootNode(page.id)?.__methodCaller;
      if (!instance) throw new Error(`找不到页面 ${id}（webviewId ${page.id}）的实例`);
      swapMethods(instance, registration.options);
    }
    register(service, id, registration);
    return;
  }

  // 回调由基础库在注册时登记；没被调用说明没登记上，这次更新不会生效
  let registered = false;
  service.__virtualDOM__.updateWxAppCode(`${id}.js`, () => {
    register(service, id, registration);
    registered = true;
  });
  if (!registered) throw new Error(`基础库没有登记 ${id}.js 的热更新回调`);
}

interface Registration {
  constructor: (options: Record<string, any>) => unknown;
  options: Record<string, any>;
}

/** 按 bootstrap 里 require 页面和组件时的方式设置当前文件，再真正注册 */
function register(service: any, id: string, { constructor, options }: Registration) {
  service.__wxRoute = id;
  service.__wxRouteBegin = true;
  service.__wxAppCurrentFile__ = id + '.js';
  constructor(options);
}

/**
 * 以新模块 id 执行模块，拦下 Page() / Component() 的参数而不注册
 *
 * 逻辑层的 define 不可改写，这里把模块脚本包进以 define 为参数的函数来取出模块函数。
 * Page / Component 要改全局：uni-app 等框架在自己的 vendor 模块里调用它们，包一层参数拦不到
 */
function loadModule(service: any, script: string, hotId: string): Registration | undefined {
  let factory: unknown;
  service.__wxaHotDefine__ = (_id: string, fn: unknown) => {
    factory = fn;
  };
  try {
    runScript(service, `(function (define) {\n${script}\n})(__wxaHotDefine__);`);
  } finally {
    delete service.__wxaHotDefine__;
  }
  if (typeof factory !== 'function') throw new Error('模块脚本没有 define 模块');
  service.define(hotId, factory);

  const { Page, Component } = service;
  let registration: Registration | undefined;
  service.Page = (options: Record<string, any>) => {
    registration = { constructor: Page, options };
  };
  service.Component = (options: Record<string, any>) => {
    registration = { constructor: Component, options };
  };
  try {
    if (service.Page === Page || service.Component === Component) throw new Error('无法拦截 Page / Component');
    service.require(hotId);
  } finally {
    service.Page = Page;
    service.Component = Component;
  }
  return registration;
}

/**
 * 方法一律换新；data 和其他非函数字段（如 pageSize）可能已被运行时改过，属于状态：
 * 已有的保持不动，只补上新增的，改了初始值的对当前实例不生效
 */
export function swapMethods(instance: any, definition: Record<string, any>) {
  for (const [key, value] of Object.entries(definition)) {
    if (typeof value === 'function') instance[key] = value;
    else if (key !== 'data' && !(key in instance)) instance[key] = value;
  }
  const data = definition.data || {};
  const added = Object.keys(data).filter(key => !(key in instance.data));
  if (added.length) instance.setData(Object.fromEntries(added.map(key => [key, data[key]])));
}

/**
 * 在 win 的全局作用域执行代码，出错时抛出（不记入宿主的错误列表）
 *
 * 不用 win.eval：新版基础库会删掉所在上下文的 eval。内联脚本同步执行，
 * 出错时在 win 上派发 error 事件，捕获阶段先于 frame.ts 的错误上报拦下
 */
function runScript(win: any, code: string) {
  let failed = false;
  let error: unknown;
  const onError = (event: ErrorEvent) => {
    failed = true;
    error = event.error ?? new Error(event.message);
    event.stopImmediatePropagation();
    event.preventDefault();
  };
  const script = win.document.createElement('script');
  script.text = code;
  win.addEventListener('error', onError, true);
  try {
    win.document.head.appendChild(script);
  } finally {
    win.removeEventListener('error', onError, true);
    script.remove();
  }
  if (failed) throw error;
}

async function fetchText(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.text();
}
