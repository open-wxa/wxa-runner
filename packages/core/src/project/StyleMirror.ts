/**
 * 样式预处理：project.config.json 的 setting.useCompilerPlugins 开启 less / sass 时，
 * 按开发者工具（summer 编译器的 summer-less、summer-sass 插件）的规则把 .less / .scss / .sass 编译成同名的 .wxss
 *
 * - 同一路径有多种源文件时，预处理文件覆盖 .wxss；less 和 sass 都开启时，在 useCompilerPlugins 里排在后面的优先，.scss 优先于 .sass
 * - 除公共文件本身外，每个 .less 先引用小程序根目录的 app.less（lessSetting.commonUseFilePath），
 *   每个 .scss / .sass 先 @use global.scss 或 global.sass（sassSetting）；公共文件不存在时跳过
 * - @import "x.wxss"; 原样保留，由 wcsc 处理
 * - 编译器优先用项目里安装的 less / sass，没装时用 wxa-runner 自带的（开发者工具也自带编译器）
 *
 * wcsc 只接收文件路径、自己从磁盘读文件：和 WxmlMirror 一样，把编译结果和原有的 .wxss 写进临时目录，让 wcsc 在这里编译。
 */

import fs from 'fs';
import { createRequire } from 'module';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import type { MiniProgram } from './MiniProgram';

export type StylePluginName = 'less' | 'sass';

export interface StyleSetting {
  /** 开启的样式插件，按 useCompilerPlugins 里的顺序 */
  plugins: StylePluginName[];
  /** ["less", { globalVars }] 写法给出的 less 全局变量 */
  lessGlobalVars: Record<string, string>;
  /** 相对小程序根目录 */
  lessCommonFile: string;
  sassCommonFile: string;
  scssCommonFile: string;
}

const PLUGIN_EXTENSIONS: Record<StylePluginName, string[]> = {
  less: ['.less'],
  sass: ['.sass', '.scss']
};

/** 与开发者工具相同的写法识别：带引号、以分号结尾的 @import "x.wxss"; */
const IMPORT_WXSS = /(?:^|\s)?(?:@import)(?:\s*)?(["'])([^"']+.wxss)\1(?:\s*);/g;

/**
 * 读取 project.config.json 的 setting。useCompilerPlugins 的每一项是插件名，或 [插件名, 选项]；
 * typescript 等非样式插件在这里忽略
 */
export function readStyleSetting(setting: any): StyleSetting {
  const plugins: StylePluginName[] = [];
  let lessGlobalVars: Record<string, string> = {};
  for (const item of Array.isArray(setting?.useCompilerPlugins) ? setting.useCompilerPlugins : []) {
    const [name, options] = Array.isArray(item) ? item : [item, undefined];
    if ((name !== 'less' && name !== 'sass') || plugins.includes(name)) continue;
    plugins.push(name);
    if (name === 'less' && options?.globalVars) lessGlobalVars = options.globalVars;
  }
  return {
    plugins,
    lessGlobalVars,
    lessCommonFile: setting?.lessSetting?.commonUseFilePath || 'app.less',
    sassCommonFile: setting?.sassSetting?.sassCommonUseFilePath || 'global.sass',
    scssCommonFile: setting?.sassSetting?.scssCommonUseFilePath || 'global.scss'
  };
}

/** 项目里有、但对应插件没有开启的预处理文件：开发者工具同样不编译它们，样式不会生效 */
export function ignoredStyleSources(project: MiniProgram, setting: StyleSetting): Array<{ plugin: StylePluginName; files: string[] }> {
  return (Object.keys(PLUGIN_EXTENSIONS) as StylePluginName[])
    .filter(plugin => !setting.plugins.includes(plugin))
    .map(plugin => ({ plugin, files: project.listFiles(PLUGIN_EXTENSIONS[plugin]) }))
    .filter(({ files }) => files.length > 0);
}

export class StyleMirror {
  private dir: string | null = null;
  /** 已写入的 .wxss 与写入的内容 */
  private readonly files = new Map<string, string>();
  private readonly compilers = new Map<StylePluginName, Promise<any>>();

  constructor(private readonly setting: StyleSetting) {}

  /** 镜像目录；还没同步过时为 null */
  get directory(): string | null {
    return this.dir;
  }

  /**
   * 编译全部预处理文件，与原有的 .wxss 一起写进镜像目录。
   * @returns 镜像目录，以及其中全部 .wxss 的相对路径
   */
  async sync(project: MiniProgram): Promise<{ cwd: string; files: string[] }> {
    const sources = this.pickSources(project);
    const outputs = await Promise.all(
      [...sources].map(async ([target, source]) => [target, await this.compile(project, source)] as const)
    );

    const dir = (this.dir ??= fs.mkdtempSync(path.join(os.tmpdir(), 'wxa-runner-wxss-')));
    for (const rel of [...this.files.keys()]) {
      if (sources.has(rel)) continue;
      fs.rmSync(path.join(dir, rel), { force: true });
      this.files.delete(rel);
    }
    for (const [rel, css] of outputs) {
      if (this.files.get(rel) === css) continue;
      const target = path.join(dir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, css);
      this.files.set(rel, css);
    }
    return { cwd: dir, files: [...sources.keys()] };
  }

  dispose(): void {
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    this.dir = null;
    this.files.clear();
  }

  /** 每个 .wxss 由哪个源文件生成：键为 .wxss 的相对路径 */
  private pickSources(project: MiniProgram): Map<string, string> {
    const extensions = ['.wxss', ...this.setting.plugins.flatMap(plugin => PLUGIN_EXTENSIONS[plugin])];
    const sources = new Map<string, string>();
    for (const file of project.listFiles(extensions)) {
      // _ 开头的 sass 文件也编译：可能是页面自己的样式，开发者工具同样不跳过
      const ext = path.extname(file);
      const target = file.slice(0, -ext.length) + '.wxss';
      const current = sources.get(target);
      if (!current || extensions.indexOf(ext) > extensions.indexOf(path.extname(current))) sources.set(target, file);
    }
    return sources;
  }

  private async compile(project: MiniProgram, file: string): Promise<string> {
    const ext = path.extname(file);
    if (ext === '.wxss') return project.readText(file);
    const compiler = await this.loadCompiler(ext === '.less' ? 'less' : 'sass', project);
    try {
      return ext === '.less' ? await this.compileLess(compiler, project, file) : this.compileSass(compiler, project, file);
    } catch (error) {
      throw new Error(`${file} 编译失败：${describeError(project, error)}`);
    }
  }

  private async compileLess(less: any, project: MiniProgram, file: string): Promise<string> {
    const common = this.setting.lessCommonFile;
    // 全局变量和公共文件写在源文件的第一行，编译错误的行号与源文件一致。
    // 不用 less 的 globalVars 选项：它在前面另加一行，报错的行号会多 1
    const prefix = Object.entries(this.setting.lessGlobalVars).map(([name, value]) => `@${name.replace(/^@/, '')}: ${value};`);
    if (file !== common && project.exists(common)) prefix.push(`@import (optional, reference) '${toRoot(file)}/${common}';`);
    let code = prefix.map(statement => statement + ' ').join('') + project.readText(file);
    // 加上 ?css，less 就当作 CSS 引用原样输出
    code = code.replace(IMPORT_WXSS, (statement, _quote, target) => statement.replace(target, `${target}?css`));

    const { css } = await less.render(code, {
      filename: path.join(project.root, file),
      paths: [project.root]
    });
    return css.replace(/(@import\s*["'][^"']+\.wxss)\?css(["'])/g, '$1$2');
  }

  private compileSass(sass: any, project: MiniProgram, file: string): string {
    const indented = file.endsWith('.sass');
    const preferred = indented ? this.setting.sassCommonFile : this.setting.scssCommonFile;
    const fallback = indented ? this.setting.scssCommonFile : this.setting.sassCommonFile;
    const common = project.exists(preferred) ? preferred : project.exists(fallback) ? fallback : null;
    let code = project.readText(file);
    if (common && file !== preferred && file !== fallback) {
      // 缩进语法的 @use 要单独一行；scss 写在同一行，行号与源文件一致
      code = `@use '${toRoot(file)}/${common}'${indented ? '\n' : '; '}${code}`;
    }
    // 引用路径以 .css 结尾时 sass 原样输出，编译后再改回 .wxss
    const imported = new Set<string>();
    code = code.replace(IMPORT_WXSS, (statement, _quote, target: string) => {
      imported.add(target);
      return statement.replace(target, `${target.slice(0, -'.wxss'.length)}.css`);
    });

    // 项目里装的旧版 sass（1.45 以前）只有 renderSync，开发者工具用的也是这套旧接口
    const css: string = typeof sass.compileString === 'function'
      ? sass.compileString(code, { url: pathToFileURL(path.join(project.root, file)), syntax: indented ? 'indented' : 'scss', loadPaths: [project.root] }).css
      : sass.renderSync({ data: code, file: path.join(project.root, file), indentedSyntax: indented, includePaths: [project.root] }).css.toString();
    return css.replace(/(@import\s*["'])([^"']+)\.css(["'])/g, (statement: string, head: string, target: string, tail: string) =>
      imported.has(`${target}.wxss`) ? `${head}${target}.wxss${tail}` : statement
    );
  }

  /** 用到时才加载：先从小程序根目录和项目目录向上查找 node_modules，找不到时用 wxa-runner 自带的 */
  private loadCompiler(name: StylePluginName, project: MiniProgram): Promise<any> {
    let loading = this.compilers.get(name);
    if (!loading) {
      loading = importCompiler(name, project);
      this.compilers.set(name, loading);
    }
    return loading;
  }
}

async function importCompiler(name: StylePluginName, project: MiniProgram): Promise<any> {
  let resolved: string | null = null;
  try {
    resolved = createRequire(path.join(project.root, 'package.json')).resolve(name, { paths: [project.root, project.projectPath] });
  } catch {
    // 项目里没装
  }
  // 包名写成字面量，打包工具才知道它们是外部依赖
  const module = resolved ? await import(pathToFileURL(resolved).href) : name === 'less' ? await import('less') : await import('sass');
  // CommonJS 包（如 less）的接口在 default 上；sass 不要读 default，会打印弃用提示
  const entry = name === 'less' ? 'render' : 'renderSync';
  return typeof module[entry] === 'function' ? module : module.default;
}

/** 从文件所在目录回到小程序根目录的相对路径，如 pages/a/a.less → ../.. */
function toRoot(file: string): string {
  const dir = path.posix.dirname(file);
  return dir === '.' ? '.' : dir.split('/').map(() => '..').join('/');
}

/** less 的错误带出错的文件和行列；sass 的错误信息里已经有出错位置 */
function describeError(project: MiniProgram, error: any): string {
  if (typeof error?.line === 'number' && error.filename) {
    const file = path.relative(project.root, error.filename).split(path.sep).join('/');
    return `${file}:${error.line}:${(error.column ?? 0) + 1} ${error.message}`;
  }
  return error?.message ?? String(error);
}
