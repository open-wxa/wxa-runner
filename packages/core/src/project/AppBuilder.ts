/**
 * 把小程序项目构建成官方基础库能直接加载的形式
 *
 * 逻辑层（appservice）:
 *   1. 裁剪版 $gwx（wcc -xc），基础库用它了解组件的节点结构
 *   2. 每个 JS 文件单独一个 define("x.js", fn) 脚本（便于在 DevTools 里按原文件调试）
 *   3. bootstrap：注册 __wxAppCode__ 的 json/wxml（serviceTemplates，热更新时单独下发），
 *      require("app.js")，再依次 require 组件和页面
 *
 * 渲染层（page-frame）:
 *   1. 完整版 $gwx（wcc -cc）与每个页面/组件的 __wxAppCode__ json / wxml（pageTemplates）
 *   2. wcsc 的公共样式运行时 + app.wxss，与每个页面/组件的 __wxAppCode__ wxss（pageStyles）。
 *      开启 less / sass 编译插件时，先把 .less / .scss / .sass 编译成 .wxss（见 StyleMirror）
 *   两部分在热更新时分别下发
 *   样式和模板里的 env(safe-area-inset-*) 改写成 CSS 变量，见 rewriteSafeAreaInsets
 *
 * Worker：workers 目录下的 JS 不进逻辑层，同样包装成 define 脚本，由 Worker 入口（server/html.ts 的 workerScript）加载
 */

import { compileWxml, compileWxss, ComponentTags } from '@open-wxa/wxa-runner-compiler';
import { transformSync } from 'esbuild';
import { AppJson, MiniProgram } from './MiniProgram';
import { StyleMirror } from './StyleMirror';
import { createWxConfig } from './wxConfig';
import { WxmlMirror } from './WxmlMirror';

export interface BuildResult {
  version: number;
  wxConfig: Record<string, any>;
  /** 所有 JS 模块 id（如 "pages/index/index.js"），逻辑层按此顺序加载 define 脚本 */
  modules: string[];
  /** workers 目录下的 JS 模块 id，Worker 按此顺序加载 define 脚本 */
  workerModules: string[];
  /** 逻辑层的 $gwx 与 __wxAppCode__ json/wxml，不含 require */
  serviceTemplates: string;
  serviceBootstrap: string;
  pageFrame: string;
  /** 渲染层的 $gwx 与 __wxAppCode__ json/wxml，不含样式（热更新时单独下发） */
  pageTemplates: string;
  /** 渲染层的样式：公共样式立即注入，页面和组件的样式注册到 __wxAppCode__（热更新时单独下发） */
  pageStyles: string;
  pages: string[];
  components: string[];
  durationMs: number;
}

/** define 包装函数的参数：屏蔽浏览器全局对象，与开发者工具一致 */
const MODULE_PARAMS = [
  'require', 'module', 'exports', 'window', 'document', 'frames', 'self', 'location', 'navigator',
  'localStorage', 'history', 'Caches', 'screen', 'alert', 'confirm', 'prompt', 'XMLHttpRequest',
  'WebSocket', 'Reporter', 'webkit', 'WeixinJSCore'
].join(', ');

/**
 * import / export 语句：在行首，或者在压缩成一行的代码里紧跟着 ; 或 }。
 * 不匹配 import() 动态导入，也不匹配 importance 这类变量名
 */
const ESM_SYNTAX = /(?:^|[;}])\s*(?:import\s*[{*'"]|import\s+[\w$]|export\s*[{*]|export\s+(?:default|const|let|var|function|class|async)\b)/m;

type ChangeKind = 'config' | 'wxml' | 'wxss' | 'js';

export interface AppBuilderOptions {
  /** wxml 交给 wcc 前的转换，见 DevServerOptions.wxmlTransform */
  wxmlTransform?: (code: string, file: string) => string;
}

export class AppBuilder {
  private version = 0;
  /** invalidate 标记过的变化次数；每次构建记下开始时覆盖到第几次 */
  private changes = 0;
  private pending: { covers: number; result: Promise<BuildResult> } | null = null;
  private last: BuildResult | null = null;
  private dirty = new Set<ChangeKind>(['config', 'wxml', 'wxss', 'js']);
  private wxmlCache: { full: string; cut: string } | null = null;
  private wxssCache: { comm: string; pages: Record<string, string> } | null = null;

  /** 设置了 wxmlTransform 时才有 */
  private readonly wxmlMirror: WxmlMirror | null;
  /** 开启了 less / sass 编译插件时才有；插件设置变了就换一个 */
  private styleMirror: { setting: string; mirror: StyleMirror } | null = null;

  constructor(readonly project: MiniProgram, options: AppBuilderOptions = {}) {
    this.wxmlMirror = options.wxmlTransform ? new WxmlMirror(options.wxmlTransform) : null;
  }

  /** wxmlTransform 的镜像目录；没有设置转换或还没编译过时为 null */
  get wxmlMirrorDir(): string | null {
    return this.wxmlMirror?.directory ?? null;
  }

  /** 删除 wxmlTransform 和样式预处理的镜像目录，开发服务器关闭时调用 */
  dispose(): void {
    this.wxmlMirror?.dispose();
    this.styleMirror?.mirror.dispose();
  }

  /** 根据变化的文件标记需要重新构建的部分；返回 true 表示需要刷新 */
  invalidate(changedFiles: string[] = []): boolean {
    if (changedFiles.length === 0) {
      ['config', 'wxml', 'wxss', 'js'].forEach(kind => this.dirty.add(kind as ChangeKind));
      this.changes++;
      return true;
    }

    let relevant = false;
    for (const file of changedFiles) {
      const kind = classifyFile(file);
      if (!kind) continue;
      relevant = true;
      this.dirty.add(kind);
      // json 决定组件关系，wxml/wxss 的编译参数都依赖它
      if (kind === 'config') {
        this.dirty.add('wxml');
        this.dirty.add('wxss');
      }
    }
    if (relevant) this.changes++;
    return relevant;
  }

  /**
   * 返回包含调用前所有变化的构建结果。并发调用共享同一次构建；
   * 进行中的构建开始得比最近一次变化早时（可能已读到旧文件），等它结束后再构建一次
   */
  async build(): Promise<BuildResult> {
    const wanted = this.changes;
    for (;;) {
      if (!this.pending && this.dirty.size === 0 && this.last) return this.last;
      if (!this.pending) {
        const result = this.doBuild().finally(() => {
          this.pending = null;
        });
        this.pending = { covers: this.changes, result };
      }
      const { covers, result } = this.pending;
      const built = await result;
      if (covers >= wanted) return built;
    }
  }

  /**
   * 单个 JS 模块的 define 包装
   *
   * 包装头和代码第一行写在同一行，行号与源文件一致。使用 import/export 的文件
   * 先转换为 CommonJS（对应开发者工具的「ES6 转 ES5」），并内联 source map。
   */
  getModuleScript(id: string): string {
    let code = this.project.readText(id);
    if (ESM_SYNTAX.test(code)) {
      try {
        code = transformSync(code, {
          format: 'cjs',
          loader: 'js',
          target: 'es2020',
          sourcefile: id,
          sourcemap: 'inline'
        }).code;
      } catch (error) {
        const message = `[wxa-runner] ${id} 转换失败：${(error as Error).message}`;
        return `console.error(${JSON.stringify(message)});\n`;
      }
    }
    return `define(${JSON.stringify(id)}, function(${MODULE_PARAMS}){${code}\n});\n`;
  }

  private async doBuild(): Promise<BuildResult> {
    const start = Date.now();
    const dirty = new Set(this.dirty);
    this.dirty.clear();

    try {
      const app = this.project.readAppJson();
      const { pages, components } = this.project.collectUnits(app);
      const units = [...components, ...pages];
      const unitJson = new Map(units.map(id => [id, this.project.readUnitJson(id, app)]));

      const [wxml, wxss] = await Promise.all([
        dirty.has('wxml') || !this.wxmlCache ? this.compileTemplates(units, unitJson) : this.wxmlCache,
        dirty.has('wxss') || !this.wxssCache ? this.compileStyles(units) : this.wxssCache
      ]);
      this.wxmlCache = wxml;
      this.wxssCache = wxss;

      const workersDir = this.project.workersDir(app);
      const inWorkers = (file: string) => workersDir !== null && file.startsWith(workersDir + '/');
      const scripts = this.project.listFiles(['.js']);
      const modules = scripts.filter(file => !inWorkers(file));

      const serviceTemplates = this.createTemplates(app, units, unitJson, wxml.cut);
      const pageTemplates = this.createTemplates(app, units, unitJson, wxml.full);
      const pageStyles = createStyles(units, wxss);
      const result: BuildResult = {
        version: ++this.version,
        wxConfig: createWxConfig({
          app,
          pages,
          unitJson,
          appid: this.project.appid,
          subPackages: this.project.subPackages(app)
        }),
        modules,
        workerModules: scripts.filter(inWorkers),
        serviceTemplates,
        serviceBootstrap: this.createServiceBootstrap(serviceTemplates, units, modules),
        pageFrame: `${pageTemplates}\n${pageStyles}`,
        pageTemplates,
        pageStyles,
        pages,
        components,
        durationMs: Date.now() - start
      };
      this.last = result;
      return result;
    } catch (error) {
      // 构建失败时保留脏标记，下次请求重新尝试
      dirty.forEach(kind => this.dirty.add(kind));
      throw error;
    }
  }

  private async compileTemplates(units: string[], unitJson: Map<string, any>) {
    const files = this.project.listFiles(['.wxml', '.wxs']).map(f => './' + f);
    const components: ComponentTags[] = units
      .filter(id => this.project.exists(id + '.wxml'))
      .map(id => {
        const json = unitJson.get(id);
        return { path: id, tags: Object.keys({ ...json.usingComponents, ...json.componentGenerics }) };
      });

    const cwd = this.wxmlMirror ? this.wxmlMirror.sync(this.project, files.map(file => file.slice(2))) : this.project.root;
    const [full, cut] = await Promise.all([
      compileWxml({ cwd, files, components, cut: false }),
      compileWxml({ cwd, files, components, cut: true })
    ]);
    // 只有渲染层的完整版带内联 style
    return { full: rewriteSafeAreaInsets(full), cut };
  }

  /** 与开发者工具一致，项目里的 wxss 全部交给 wcsc：被 @import 的文件（如 uni-app 的 common/main.wxss）也要在列表里 */
  private async compileStyles(units: string[]) {
    const mirror = this.currentStyleMirror();
    const { cwd, files } = mirror ? await mirror.sync(this.project) : { cwd: this.project.root, files: this.project.listFiles(['.wxss']) };
    const styles = new Set(files);
    const pageFiles = units.filter(id => styles.has(id + '.wxss')).map(id => `./${id}.wxss`);
    const commonFiles = files.map(file => `./${file}`).filter(file => !pageFiles.includes(file));
    const { comm, pages } = await compileWxss({ cwd, pageFiles, commonFiles });
    return {
      comm: rewriteSafeAreaInsets(comm),
      pages: Object.fromEntries(Object.entries(pages).map(([file, css]) => [file, rewriteSafeAreaInsets(css)]))
    };
  }

  private currentStyleMirror(): StyleMirror | null {
    const setting = this.project.styleSetting;
    const key = JSON.stringify(setting);
    if (this.styleMirror?.setting !== key) {
      this.styleMirror?.mirror.dispose();
      this.styleMirror = setting.plugins.length > 0 ? { setting: key, mirror: new StyleMirror(setting) } : null;
    }
    return this.styleMirror?.mirror ?? null;
  }

  /** $gwx 加上各页面、组件的 json / wxml 注册；逻辑层用裁剪版 $gwx，渲染层用完整版 */
  private createTemplates(app: AppJson, units: string[], unitJson: Map<string, any>, gwx: string): string {
    const lines: string[] = [gwx, `__wxAppCode__["app.json"] = ${toJs(app)};`];

    for (const id of units) {
      lines.push(`__wxAppCode__[${toJs(id + '.json')}] = ${toJs(unitJson.get(id))};`);
      if (this.project.exists(id + '.wxml')) {
        lines.push(`__wxAppCode__[${toJs(id + '.wxml')}] = $gwx(${toJs('./' + id + '.wxml')});`);
      }
    }
    return lines.join('\n');
  }

  private createServiceBootstrap(serviceTemplates: string, units: string[], modules: string[]): string {
    const lines: string[] = [serviceTemplates];

    if (modules.includes('app.js')) {
      lines.push(requireStatement('app.js', null));
    }
    for (const id of units) {
      if (modules.includes(id + '.js')) lines.push(requireStatement(id + '.js', id));
    }
    return lines.join('\n');
  }
}

function createStyles(units: string[], wxss: { comm: string; pages: Record<string, string> }): string {
  const lines = [wxss.comm];
  for (const id of units) {
    const css = wxss.pages[id + '.wxss'];
    if (css) lines.push(`__wxAppCode__[${toJs(id + '.wxss')}] = ${css};`);
  }
  return lines.join('\n');
}

/** 某个模块执行出错时只影响它自己，其余页面照常注册 */
function requireStatement(file: string, route: string | null): string {
  const routeSetup = route
    ? `__wxRoute = ${toJs(route)}; __wxRouteBegin = true; __wxAppCurrentFile__ = ${toJs(file)};`
    : `__wxAppCurrentFile__ = ${toJs(file)};`;
  return `${routeSetup}\ntry { require(${toJs(file)}); } catch (error) { console.error(${toJs('[wxa-runner] ' + file + ' 执行出错\n')}, error); }`;
}

/**
 * env(safe-area-inset-*) / constant(safe-area-inset-*) → var(--wxa-safe-area-inset-*)
 *
 * 桌面浏览器里这些 env() 恒为 0，而真机上的值取决于页面窗口是否贴着屏幕边缘（tabBar 页面底部为 0），
 * 所以改成变量，由宿主按页面写入（PageView.setSafeAreaInsets）。只替换函数名和参数名，
 * fallback 原样保留——wcsc 会把其中的 rpx 拆成数组片段，不能整体解析。
 */
export function rewriteSafeAreaInsets(code: string): string {
  return code.replace(/\b(?:env|constant)\(\s*safe-area-inset-(top|right|bottom|left)\b/g, 'var(--wxa-safe-area-inset-$1');
}

/** JSON 序列化并转义 </script> 与行分隔符，结果可安全嵌入脚本 */
export function toJs(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

function classifyFile(file: string): ChangeKind | null {
  if (file.endsWith('.json')) return 'config';
  if (file.endsWith('.wxml') || file.endsWith('.wxs')) return 'wxml';
  // less / sass 可以引用 .css
  if (/\.(wxss|less|scss|sass|css)$/.test(file)) return 'wxss';
  if (file.endsWith('.js')) return 'js';
  return null;
}
