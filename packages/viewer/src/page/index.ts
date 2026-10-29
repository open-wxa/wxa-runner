/**
 * 查看页面入口（打包为 /__wxa__/runtime/viewer.js）
 *
 * 顶栏切换项目、导入、重新启动；中间是宿主 iframe（模拟器）；右侧面板编辑 setup 和环境变量。
 * 项目数据只写进浏览器 IndexedDB（../store.ts），宿主 iframe 里的请求由 pack-sw 从那里应答。
 */

import { readPack } from '../pack/format';
import type { PackManifest } from '../pack/format';
import { deleteProject, getActiveProjectId, listProjects, putProject, setActiveProjectId, ViewerProject } from '../store';
import { compileSetup } from './compileSetup';
import { h, icon } from './dom';
import { downloadPacks, importProject, importProjects, parseEnv, withDefaultPacks } from './projects';
import ICON_URL from './assets/icon.png';
import LOGO_URL from './assets/logo.png';
import { VIEWER_CSS } from './styles';

type Tab = 'setup' | 'env';

const SETUP_TEMPLATE = `import { defineSetup } from '@open-wxa/wxa-runner-core/setup';

export default defineSetup(({ env }) => ({
  storage: {
    token: env.WXA_TOKEN
  }
}));
`;
const PANEL_KEY = 'wxa-viewer:panel';
const TAB_KEY = 'wxa-viewer:tab';
const SAVE_SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘S' : 'Ctrl+S';

/** 等 pack-sw 实际接管后再打开宿主，否则宿主的第一批请求会落到静态服务器上 */
async function takeControl(): Promise<void> {
  if (!navigator.serviceWorker) throw new Error('这个页面用不了 Service Worker。请通过 HTTPS 或 localhost 打开查看器');
  const workers = navigator.serviceWorker;
  const script = new URL('/pack-sw.js', location.href).href;
  await workers.register(script, { scope: '/' });
  if (workers.controller?.scriptURL === script) return;
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      workers.removeEventListener('controllerchange', changed);
      clearTimeout(timeout);
    };
    const changed = () => {
      if (workers.controller?.scriptURL !== script) return;
      cleanup();
      resolve();
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('查看器没能接管页面。刷新重试，并确认浏览器允许 Service Worker'));
    }, 20000);
    workers.addEventListener('controllerchange', changed);
    changed();
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function main() {
  const root = document.getElementById('wxa-viewer');
  if (!root) throw new Error('找不到查看器挂载节点 #wxa-viewer');
  document.title = 'wxa-viewer';
  document.head.append(h('style', {}, VIEWER_CSS), h('link', { rel: 'icon', type: 'image/png', href: ICON_URL }));

  let projects: ViewerProject[] = [];
  let activeId: string | null = null;
  let viewerBaseLib = '';
  let defaultPacks: string[] = [];
  let ready = false;
  let busy = false;
  let menuOpen = false;
  let renamingId: string | null = null;
  let confirmDeleteId: string | null = null;
  let panelOpen = localStorage.getItem(PANEL_KEY) !== 'closed';
  let tab: Tab = localStorage.getItem(TAB_KEY) === 'env' ? 'env' : 'setup';
  const manifests = new Map<string, { updatedAt: number; manifest: PackManifest | null }>();

  const bar = h('header', { class: 'v-bar' });
  const stage = h('div', { class: 'v-stage' });
  const panel = h('aside', { class: 'v-panel', 'aria-label': '项目配置' });
  const toast = h('div', { class: 'v-toast', role: 'status', 'aria-live': 'polite' });
  const picker = h('input', { type: 'file', accept: '.wxapack,.ts,.js,.mjs', multiple: true, hidden: true });
  const drop = h(
    'div',
    { class: 'v-drop' },
    h(
      'div',
      { class: 'v-drop-box' },
      h('strong', {}, '松开导入'),
      h('span', {}, '.wxapack 导入为项目，.ts / .js / .mjs 设为当前项目的 setup')
    )
  );
  root.replaceChildren(bar, h('div', { class: 'v-main' }, stage, panel), drop, toast, picker);

  const active = () => projects.find(project => project.id === activeId) ?? null;

  /** 包的清单按项目缓存：渲染顶栏和面板时都要用，没必要每次解压 */
  function manifestOf(project: ViewerProject): PackManifest | null {
    const cached = manifests.get(project.id);
    if (cached?.updatedAt === project.updatedAt) return cached.manifest;
    let manifest: PackManifest | null = null;
    try {
      manifest = readPack(project.pack).manifest;
    } catch {
      // 坏包在导入时就被拒绝了，这里只是兜底，界面上显示为未知
    }
    manifests.set(project.id, { updatedAt: project.updatedAt, manifest });
    return manifest;
  }

  let toastTimer: ReturnType<typeof setTimeout> | undefined;
  function notify(text: string, error = false) {
    toast.textContent = text;
    toast.dataset.error = String(error);
    toast.setAttribute('role', error ? 'alert' : 'status');
    toast.dataset.show = 'true';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toast.dataset.show = 'false'), error ? 6000 : 2000);
  }

  /** 串行执行改动：busy 时忽略新的操作。onError 返回 true 表示调用方已经自己显示了错误 */
  async function perform(action: () => Promise<string | void>, onError?: (error: unknown) => boolean) {
    if (busy) return;
    busy = true;
    root!.setAttribute('aria-busy', 'true');
    try {
      const done = await action();
      if (done) notify(done);
    } catch (error) {
      if (!onError?.(error)) notify(errorMessage(error), true);
    } finally {
      busy = false;
      root!.removeAttribute('aria-busy');
    }
  }

  async function reload() {
    projects = await listProjects();
    activeId = await getActiveProjectId();
    if (activeId && !active()) activeId = null;
  }

  /** 读最新数据、重画界面并重新启动小程序 */
  async function refresh() {
    await reload();
    renderBar();
    renderPanel();
    restart();
  }

  async function save(project: ViewerProject) {
    await putProject({ ...project, updatedAt: Math.max(Date.now(), project.updatedAt + 1) });
    await setActiveProjectId(project.id);
    await refresh();
  }

  function restart() {
    const project = active();
    if (!ready) return;
    if (!project) {
      stage.replaceChildren(emptyState());
      return;
    }
    const frame = h('iframe', { title: `${project.name} · 小程序`, src: '/__wxa__/host.html' });
    // 拖放事件不会从 iframe 冒泡出来，同源的宿主文档也要接收
    frame.addEventListener('load', () => frame.contentDocument && bindDrop(frame.contentDocument));
    stage.replaceChildren(frame);
  }

  function emptyState(): HTMLElement {
    return h(
      'div',
      { class: 'v-empty' },
      h(
        'div',
        { class: 'v-empty-card' },
        h('div', { class: 'v-empty-icon' }, icon('box', 22)),
        h('h2', {}, '导入一个小程序包'),
        h('p', {}, '把 .wxapack 拖到这里，或者选择文件'),
        h('button', { class: 'v-btn v-btn-primary', type: 'button', onClick: () => picker.click() }, icon('import'), '选择文件'),
        h('p', { class: 'v-empty-note' }, '包、setup 和变量只保存在这个浏览器里'),
        h('pre', {}, '# 在本机把小程序打成包\nwxa-runner viewer pack <小程序目录>')
      )
    );
  }

  function failedState(message: string): HTMLElement {
    return h(
      'div',
      { class: 'v-empty v-empty-error' },
      h(
        'div',
        { class: 'v-empty-card' },
        h('div', { class: 'v-empty-icon' }, icon('alert', 22)),
        h('h2', {}, '查看器没能启动'),
        h('p', {}, message)
      )
    );
  }

  // ---- 顶栏 ----

  function renderBar() {
    const project = active();
    const manifest = project && manifestOf(project);
    const mismatch = manifest && viewerBaseLib && manifest.baseLib.version !== viewerBaseLib;
    const switcher = h(
      'div',
      { class: 'v-switcher' },
      h(
        'button',
        {
          class: 'v-btn v-switcher-btn',
          type: 'button',
          'aria-haspopup': 'menu',
          'aria-expanded': String(menuOpen),
          disabled: !projects.length,
          onClick: () => {
            menuOpen = !menuOpen;
            renamingId = confirmDeleteId = null;
            renderBar();
          }
        },
        h('span', {}, project?.name ?? (projects.length ? '选择项目' : '还没有项目')),
        project ? h('span', { class: 'v-appid' }, project.appid) : null,
        h('span', { class: 'v-chevron' }, icon('chevron', 14))
      ),
      menuOpen ? renderMenu() : null
    );
    const items: Array<Node | null> = [
      h('div', { class: 'v-logo' }, h('img', { class: 'v-logo-img', src: LOGO_URL, alt: '' }), 'wxa-viewer'),
      switcher,
      manifest
        ? h(
            'span',
            {
              class: mismatch ? 'v-badge v-badge-warn' : 'v-badge',
              title: mismatch ? `包用基础库 ${manifest.baseLib.version} 编译，查看器提供的是 ${viewerBaseLib}` : '包和查看器用的基础库'
            },
            h('span', { class: 'v-dot' }),
            mismatch ? `基础库不一致 ${manifest.baseLib.version} / ${viewerBaseLib}` : `基础库 ${manifest.baseLib.version}`
          )
        : null,
      h('span', { class: 'v-spacer' }),
      h('button', { class: 'v-btn v-btn-outline', type: 'button', onClick: () => picker.click() }, icon('import'), '导入'),
      h('button', { class: 'v-btn v-btn-outline', type: 'button', disabled: !project, onClick: restart }, icon('refresh'), '重新启动'),
      !project
        ? null
        : h(
            'button',
            {
              class: 'v-btn v-btn-icon',
              type: 'button',
              title: panelOpen ? '收起配置面板' : '展开配置面板',
              'aria-label': '配置面板',
              'aria-pressed': String(panelOpen),
              onClick: () => {
                panelOpen = !panelOpen;
                localStorage.setItem(PANEL_KEY, panelOpen ? 'open' : 'closed');
                renderBar();
                renderPanel();
              }
            },
            icon('panel')
          )
    ];
    bar.replaceChildren(...items.filter((item): item is Node => item !== null));
  }

  function renderMenu(): HTMLElement {
    const menu = h('div', { class: 'v-menu', role: 'menu' }, h('div', { class: 'v-menu-label' }, `项目 · ${projects.length}`));
    for (const project of [...projects].reverse()) {
      const manifest = manifestOf(project);
      if (project.id === renamingId) {
        const input = h('input', { class: 'v-input v-rename', value: project.name, 'aria-label': '项目名称' });
        let done = false;
        const finish = (commit: boolean) => {
          if (done) return;
          done = true;
          const name = input.value.trim();
          renamingId = null;
          if (commit && name && name !== project.name) void perform(async () => save({ ...project, name }));
          else renderBar();
        };
        input.addEventListener('keydown', event => {
          if (event.key === 'Enter') finish(true);
          if (event.key === 'Escape') finish(false);
        });
        input.addEventListener('blur', () => finish(true));
        menu.append(h('div', { class: 'v-menu-row' }, input));
        queueMicrotask(() => input.select());
        continue;
      }
      const confirming = confirmDeleteId === project.id;
      menu.append(
        h(
          'div',
          { class: 'v-menu-row' },
          h(
            'button',
            {
              class: 'v-menu-item',
              type: 'button',
              role: 'menuitemradio',
              'aria-checked': String(project.id === activeId),
              onClick: () => {
                menuOpen = false;
                if (project.id === activeId) return renderBar();
                void perform(async () => {
                  await setActiveProjectId(project.id);
                  await refresh();
                });
              }
            },
            h('span', { class: 'v-menu-check' }, project.id === activeId ? icon('check', 14) : null),
            h(
              'span',
              { class: 'v-menu-text' },
              h('span', { class: 'v-menu-name' }, project.name),
              h(
                'span',
                { class: 'v-menu-meta' },
                `${project.appid} · ${manifest ? manifest.baseLib.version : '包已损坏'} · ${new Date(project.importedAt).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })}`
              )
            )
          ),
          h(
            'span',
            { class: 'v-menu-actions' },
            confirming
              ? null
              : h(
                  'button',
                  {
                    class: 'v-btn v-btn-icon',
                    type: 'button',
                    title: '重命名',
                    'aria-label': `重命名 ${project.name}`,
                    onClick: () => {
                      renamingId = project.id;
                      confirmDeleteId = null;
                      renderBar();
                    }
                  },
                  icon('pencil', 14)
                ),
            // 删除要点两次：第一次变成「确认删除」，免得手滑
            h(
              'button',
              {
                class: confirming ? 'v-btn v-btn-danger' : 'v-btn v-btn-icon',
                type: 'button',
                title: '删除',
                'aria-label': confirming ? `确认删除 ${project.name}` : `删除 ${project.name}`,
                onClick: () => {
                  if (!confirming) {
                    confirmDeleteId = project.id;
                    return renderBar();
                  }
                  confirmDeleteId = null;
                  void perform(async () => {
                    await deleteProject(project.id);
                    await refresh();
                    return `已删除 ${project.name}`;
                  });
                }
              },
              confirming ? '确认删除' : icon('trash', 14)
            )
          )
        )
      );
    }
    return menu;
  }

  document.addEventListener('mousedown', event => {
    if (!menuOpen || (event.target as Element).closest?.('.v-switcher')) return;
    menuOpen = false;
    renamingId = confirmDeleteId = null;
    renderBar();
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !menuOpen) return;
    menuOpen = false;
    renamingId = confirmDeleteId = null;
    renderBar();
  });

  // ---- 右侧面板 ----

  function renderPanel() {
    const project = active();
    panel.hidden = !project || !panelOpen;
    if (!project) return panel.replaceChildren();
    const envCount = Object.keys(project.env).length;
    const tabButton = (id: Tab, label: string, extra?: Node) =>
      h(
        'button',
        {
          class: 'v-tab',
          type: 'button',
          role: 'tab',
          'aria-selected': String(tab === id),
          onClick: () => {
            tab = id;
            localStorage.setItem(TAB_KEY, id);
            renderPanel();
          }
        },
        label,
        extra
      );
    panel.replaceChildren(
      h(
        'div',
        { class: 'v-tabs', role: 'tablist' },
        tabButton('setup', 'setup'),
        tabButton('env', '环境变量', h('span', { class: 'v-count' }, String(envCount)))
      ),
      tab === 'setup' ? setupPane(project) : envPane(project)
    );
  }

  function setupPane(project: ViewerProject): HTMLElement {
    let bundled: string | null = null;
    try {
      bundled = readPack(project.pack).setupScript;
    } catch {
      // 同 manifestOf
    }
    const overridden = project.setupSource !== null;
    const editor = h('textarea', { class: 'v-editor', 'aria-label': 'setup 源码', spellcheck: 'false', wrap: 'off' });
    editor.value = project.setupSource ?? bundled ?? SETUP_TEMPLATE;
    const error = h('pre', { class: 'v-error', role: 'alert' });

    const submit = () =>
      perform(
        async () => {
          error.textContent = '';
          const filename = project.setupFileName ?? 'wxa.setup.ts';
          const script = await compileSetup(editor.value, filename);
          await save({ ...project, setupSource: editor.value, setupFileName: filename, setupScript: script });
          return '已保存 setup，小程序已重新启动';
        },
        failure => {
          error.textContent = errorMessage(failure);
          return true;
        }
      );
    editor.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 's') {
        event.preventDefault();
        void submit();
      }
      if (event.key === 'Tab' && !event.shiftKey) {
        event.preventDefault();
        editor.setRangeText('  ', editor.selectionStart, editor.selectionEnd, 'end');
      }
    });

    const source = overridden
      ? h('span', {}, '来源：', h('strong', {}, project.setupFileName ?? 'wxa.setup.ts'), '（在查看器里设置）')
      : bundled !== null
        ? h('span', {}, '来源：', h('strong', {}, '包里自带'))
        : h('span', {}, '还没有 setup，下面是一个从 env 读取 token 的例子');
    return h(
      'div',
      { class: 'v-pane', role: 'tabpanel' },
      h('div', { class: 'v-source' }, source),
      editor,
      error,
      h('p', { class: 'v-hint' }, '只能是单个文件，可以读取 ', h('code', {}, 'env.WXA_*'), '。也可以把 setup 文件直接拖进来'),
      h(
        'div',
        { class: 'v-footer' },
        overridden
          ? h(
              'button',
              {
                class: 'v-btn',
                type: 'button',
                onClick: () =>
                  perform(async () => {
                    await save({ ...project, setupSource: null, setupFileName: null, setupScript: null });
                    return bundled !== null ? '已恢复为包里的 setup' : '已清除 setup';
                  })
              },
              bundled !== null ? '恢复为包里的' : '清除'
            )
          : null,
        h('span', { class: 'v-spacer' }),
        h('span', { class: 'v-kbd' }, SAVE_SHORTCUT),
        h('button', { class: 'v-btn v-btn-primary', type: 'button', onClick: () => void submit() }, '保存 setup')
      )
    );
  }

  function envPane(project: ViewerProject): HTMLElement {
    const table = h(
      'div',
      { class: 'v-env' },
      h('div', { class: 'v-env-head' }, h('span', {}, '变量名'), h('span', { style: 'padding-left:10px' }, '值'), h('span'))
    );
    const rows: Array<{ key: HTMLInputElement; value: HTMLInputElement }> = [];
    const addRow = (key = '', value = '') => {
      const keyInput = h('input', {
        class: 'v-input',
        placeholder: 'WXA_TOKEN',
        'aria-label': '变量名',
        autocomplete: 'off',
        spellcheck: 'false',
        value: key
      });
      // 值多半是 token，默认遮住，录屏、截图时不会露出来
      const valueInput = h('input', {
        class: 'v-input',
        type: 'password',
        placeholder: '值',
        'aria-label': '变量值',
        autocomplete: 'off',
        value
      });
      const reveal = h('button', {
        class: 'v-btn v-btn-icon',
        type: 'button',
        title: '显示',
        'aria-label': '显示变量值',
        onClick: () => {
          const shown = valueInput.type === 'text';
          valueInput.type = shown ? 'password' : 'text';
          reveal.replaceChildren(icon(shown ? 'eye' : 'eyeOff', 14));
        }
      });
      reveal.append(icon('eye', 14));
      const row = { key: keyInput, value: valueInput };
      const node = h(
        'div',
        { class: 'v-env-row' },
        keyInput,
        h('div', { class: 'v-value' }, valueInput, reveal),
        h(
          'button',
          {
            class: 'v-btn v-btn-icon',
            type: 'button',
            'aria-label': '删除变量',
            onClick: () => {
              rows.splice(rows.indexOf(row), 1);
              node.remove();
              if (!rows.length) addRow();
            }
          },
          icon('close', 14)
        )
      );
      rows.push(row);
      table.append(node);
    };
    for (const [key, value] of Object.entries(project.env)) addRow(key, value);
    if (!rows.length) addRow();

    return h(
      'div',
      { class: 'v-pane', role: 'tabpanel' },
      h(
        'p',
        { class: 'v-hint' },
        'setup 通过 ',
        h('code', {}, 'env'),
        ' 读取这些变量，名字以 ',
        h('code', {}, 'WXA_'),
        ' 开头。只保存在这个浏览器里，不会上传'
      ),
      table,
      h('button', { class: 'v-btn v-add', type: 'button', onClick: () => addRow() }, icon('plus', 14), '添加变量'),
      h('span', { class: 'v-spacer', style: 'flex:1' }),
      h(
        'div',
        { class: 'v-footer' },
        h('span', { class: 'v-spacer' }),
        h(
          'button',
          {
            class: 'v-btn v-btn-primary',
            type: 'button',
            onClick: () =>
              perform(async () => {
                const env = parseEnv(rows.map(row => [row.key.value, row.value.value]));
                await save({ ...project, env });
                return '已保存变量，小程序已重新启动';
              })
          },
          '保存变量'
        )
      )
    );
  }

  // ---- 导入 ----

  async function importFiles(files: File[]): Promise<string> {
    const packs = files.filter(file => /\.wxapack$/i.test(file.name));
    const setups = files.filter(file => /\.(?:ts|js|mjs)$/i.test(file.name));
    if (packs.length + setups.length !== files.length) throw new Error('只能导入 .wxapack 包，或 .ts / .js / .mjs 的 setup 文件');
    const done: string[] = [];
    for (const file of packs) {
      const project = importProject(new Uint8Array(await file.arrayBuffer()), file.name);
      await putProject(project);
      await setActiveProjectId(project.id);
      done.push(`已导入 ${project.name}`);
    }
    if (packs.length) await reload();
    for (const file of setups) {
      const project = active();
      if (!project) throw new Error('先导入或选择一个项目，再设置 setup');
      const source = await file.text();
      const script = await compileSetup(source, file.name);
      await putProject({
        ...project,
        setupSource: source,
        setupFileName: file.name,
        setupScript: script,
        updatedAt: Math.max(Date.now(), project.updatedAt + 1)
      });
      tab = 'setup';
      done.push(`已设置 setup：${file.name}`);
    }
    await refresh();
    return done.join('，');
  }

  picker.addEventListener('change', () => {
    const files = Array.from(picker.files ?? []);
    picker.value = '';
    if (files.length) void perform(() => importFiles(files));
  });

  function bindDrop(target: Document) {
    target.addEventListener('dragover', event => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      root!.dataset.dragging = 'true';
    });
    target.addEventListener('dragleave', event => {
      if (!event.relatedTarget) root!.dataset.dragging = 'false';
    });
    target.addEventListener('drop', event => {
      event.preventDefault();
      root!.dataset.dragging = 'false';
      const files = Array.from(event.dataTransfer?.files ?? []);
      if (files.length) void perform(() => importFiles(files));
    });
  }
  bindDrop(document);

  // ---- 启动 ----

  renderBar();
  try {
    await reload();
    const response = await fetch('/viewer.json');
    if (!response.ok) throw new Error(`读取查看器配置失败：HTTP ${response.status}`);
    const config = await response.json();
    viewerBaseLib = config.baseLibVersion;
    if (Array.isArray(config.defaultPacks)) defaultPacks = config.defaultPacks;
    await takeControl();
    ready = true;
  } catch (error) {
    stage.replaceChildren(failedState(errorMessage(error)));
    renderBar();
    return;
  }
  await perform(async () => {
    const download = await downloadPacks(withDefaultPacks(location.href, defaultPacks, projects.length > 0));
    if (download) {
      // 先校验整批再保存，最后一个成为当前项目；同名同 appid 的旧项目只换包，保留它的 setup 和变量
      const imported = importProjects(download.packs, projects);
      for (const project of imported) await putProject(project);
      await setActiveProjectId(imported[imported.length - 1].id);
      projects = await listProjects();
      history.replaceState(history.state, '', download.cleanURL);
    }
  });
  await refresh();
}

main().catch(error => {
  const root = document.getElementById('wxa-viewer');
  if (root) root.textContent = `查看器启动失败：${errorMessage(error)}`;
});
