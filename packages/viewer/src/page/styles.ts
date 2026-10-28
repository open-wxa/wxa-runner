/**
 * 查看页面的样式：开发工具式的浅色界面——中性灰、系统字体、紧凑。主色只用在主按钮和选中状态上，
 * 让视线留在中间的小程序上。只作用于查看页面，宿主 iframe 里的模拟器有自己的样式
 */
export const VIEWER_CSS = `
:root {
  --text: #1d1d1f;
  --muted: #6e6e73;
  --faint: #a1a1a6;
  --line: #e3e3e8;
  --line-strong: #d2d2d7;
  --canvas: #f2f2f5;
  --panel: #ffffff;
  --hover: #f5f5f7;
  --accent: #07c160;
  --accent-strong: #06a552;
  --accent-soft: #e8f8ef;
  --danger: #e5484d;
  --danger-soft: #fdeced;
  --warn: #b25e09;
  --warn-soft: #fdf3e6;
  --mono: ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", "Microsoft YaHei", sans-serif; color: var(--text); background: var(--canvas); -webkit-font-smoothing: antialiased; }
button, input, textarea { font: inherit; color: inherit; }
button { cursor: pointer; }
svg { display: block; flex: none; }
#wxa-viewer { height: 100%; display: flex; flex-direction: column; }

/* 顶栏 */
.v-bar { height: 48px; flex: none; display: flex; align-items: center; gap: 8px; padding: 0 12px 0 16px; background: var(--panel); border-bottom: 1px solid var(--line); }
.v-logo { display: flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: -0.01em; padding-right: 12px; margin-right: 4px; border-right: 1px solid var(--line); height: 28px; }
/* 项目 logo（狐狸 + 小程序 + Chrome），宽高比约 1.4 */
.v-logo-img { height: 28px; width: auto; display: block; }
.v-spacer { flex: 1; }
.v-btn { height: 30px; display: inline-flex; align-items: center; gap: 6px; padding: 0 10px; border-radius: 6px; border: 1px solid transparent; background: transparent; white-space: nowrap; transition: background .12s, border-color .12s; }
.v-btn:hover { background: var(--hover); }
.v-btn:disabled { opacity: .5; cursor: default; }
.v-btn-outline { border-color: var(--line-strong); background: var(--panel); }
.v-btn-outline:hover { background: var(--hover); }
.v-btn-primary { background: var(--accent); color: #fff; font-weight: 500; }
.v-btn-primary:hover { background: var(--accent-strong); }
.v-btn-icon { width: 30px; padding: 0; justify-content: center; color: var(--muted); }
.v-btn-icon:hover { color: var(--text); }
.v-btn-icon[aria-pressed="true"] { color: var(--text); background: var(--hover); }
.v-btn-danger { color: var(--danger); }
.v-btn-danger:hover { background: var(--danger-soft); }
.v-btn:focus-visible, .v-input:focus-visible, .v-tab:focus-visible, .v-menu-item:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }

/* 项目切换 */
.v-switcher { position: relative; }
.v-switcher-btn { max-width: 360px; font-weight: 500; }
.v-switcher-btn .v-appid { font: 12px var(--mono); color: var(--muted); font-weight: 400; overflow: hidden; text-overflow: ellipsis; }
.v-chevron { color: var(--faint); }
.v-menu { position: absolute; top: 36px; left: 0; z-index: 20; width: 340px; max-height: min(480px, 70vh); overflow: auto; padding: 6px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; box-shadow: 0 12px 32px rgba(0,0,0,.12), 0 2px 6px rgba(0,0,0,.06); }
.v-menu-label { padding: 6px 8px 4px; font-size: 11px; color: var(--faint); }
.v-menu-item { width: 100%; display: flex; align-items: center; gap: 8px; padding: 7px 8px; border: 0; border-radius: 6px; background: transparent; text-align: left; }
.v-menu-item:hover { background: var(--hover); }
.v-menu-check { width: 14px; color: var(--accent); }
.v-menu-text { flex: 1; min-width: 0; }
.v-menu-name { display: block; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v-menu-meta { display: block; font: 11px var(--mono); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.v-menu-actions { display: flex; gap: 2px; opacity: 0; transition: opacity .12s; }
.v-menu-row:hover .v-menu-actions, .v-menu-row:focus-within .v-menu-actions { opacity: 1; }
.v-menu-row { display: flex; align-items: center; border-radius: 6px; }
.v-menu-row:hover { background: var(--hover); }
.v-menu-row .v-menu-item:hover { background: transparent; }
.v-menu-row .v-btn-icon { width: 26px; height: 26px; }
.v-rename { flex: 1; height: 28px; margin: 3px 4px; }

/* 状态标记 */
.v-badge { height: 22px; display: inline-flex; align-items: center; gap: 5px; padding: 0 8px; border-radius: 11px; font-size: 12px; color: var(--muted); background: var(--hover); white-space: nowrap; }
.v-badge-warn { color: var(--warn); background: var(--warn-soft); }
.v-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); }
.v-badge-warn .v-dot { background: var(--warn); }

/* 主体 */
.v-main { flex: 1; min-height: 0; display: flex; }
.v-stage { flex: 1; min-width: 0; position: relative; }
.v-stage iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }

/* 右侧面板 */
.v-panel { width: 380px; flex: none; display: flex; flex-direction: column; background: var(--panel); border-left: 1px solid var(--line); }
.v-panel[hidden] { display: none; }
.v-tabs { height: 40px; flex: none; display: flex; align-items: flex-end; gap: 4px; padding: 0 12px; border-bottom: 1px solid var(--line); }
.v-tab { height: 40px; display: inline-flex; align-items: center; gap: 6px; padding: 0 8px; border: 0; border-bottom: 2px solid transparent; background: none; color: var(--muted); font-weight: 500; }
.v-tab:hover { color: var(--text); }
.v-tab[aria-selected="true"] { color: var(--text); border-bottom-color: var(--accent); }
.v-count { min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--hover); color: var(--muted); font-size: 11px; display: inline-grid; place-items: center; }
.v-pane { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 14px 16px 16px; gap: 10px; }
.v-pane[hidden] { display: none; }
.v-hint { margin: 0; color: var(--muted); font-size: 12px; }
.v-hint code { font: 11.5px var(--mono); padding: 1px 4px; border-radius: 4px; background: var(--hover); color: var(--text); }
.v-source { display: flex; align-items: center; gap: 6px; font-size: 12px; color: var(--muted); }
.v-source strong { color: var(--text); font-weight: 500; }
.v-editor { flex: 1; min-height: 160px; width: 100%; resize: none; padding: 12px; white-space: pre; overflow: auto; border: 1px solid var(--line); border-radius: 8px; background: #fbfbfc; font: 12.5px/1.65 var(--mono); tab-size: 2; outline: none; }
.v-editor:focus { border-color: var(--accent); background: #fff; box-shadow: 0 0 0 3px var(--accent-soft); }
.v-error { margin: 0; padding: 8px 10px; border-radius: 6px; background: var(--danger-soft); color: var(--danger); font: 12px/1.5 var(--mono); white-space: pre-wrap; word-break: break-word; max-height: 140px; overflow: auto; }
.v-error:empty { display: none; }
.v-footer { display: flex; align-items: center; gap: 8px; }
.v-footer .v-spacer { flex: 1; }
.v-kbd { font: 11px var(--mono); color: var(--faint); }

/* 环境变量 */
.v-env { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.v-env-head, .v-env-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) 30px; align-items: center; }
.v-env-head { height: 30px; padding: 0 0 0 10px; font-size: 11px; color: var(--faint); background: #fbfbfc; border-bottom: 1px solid var(--line); }
.v-env-row + .v-env-row { border-top: 1px solid var(--line); }
.v-env-row .v-input { border: 0; border-radius: 0; height: 34px; background: transparent; }
.v-env-row .v-input + .v-input, .v-env-row .v-value { border-left: 1px solid var(--line); }
.v-value { display: flex; align-items: center; min-width: 0; }
.v-value .v-input { flex: 1; min-width: 0; border-left: 0 !important; }
.v-value .v-btn-icon { width: 26px; height: 26px; margin-right: 2px; }
.v-input { width: 100%; height: 30px; padding: 0 10px; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--panel); font: 12.5px var(--mono); outline: none; }
.v-input:focus { box-shadow: inset 0 0 0 2px var(--accent-soft); }
.v-input::placeholder { color: var(--faint); }
.v-add { align-self: flex-start; color: var(--muted); }

/* 空状态与错误 */
.v-empty { position: absolute; inset: 0; display: grid; place-items: center; padding: 24px; }
.v-empty-card { max-width: 420px; text-align: center; }
.v-empty-icon { width: 48px; height: 48px; margin: 0 auto 16px; border-radius: 12px; display: grid; place-items: center; background: var(--panel); border: 1px solid var(--line); color: var(--muted); }
.v-empty h2 { margin: 0 0 6px; font-size: 17px; font-weight: 600; letter-spacing: -0.01em; }
.v-empty p { margin: 0 0 18px; color: var(--muted); }
.v-empty .v-empty-note { margin: 12px 0 0; font-size: 12px; color: var(--faint); }
.v-empty pre { margin: 18px 0 0; padding: 10px 12px; border-radius: 8px; background: var(--panel); border: 1px solid var(--line); font: 12px var(--mono); color: var(--muted); text-align: left; white-space: pre-wrap; }
.v-empty-error .v-empty-icon { color: var(--danger); }

/* 拖放 */
.v-drop { position: fixed; inset: 0; z-index: 50; display: none; place-items: center; background: rgba(242,242,245,.82); backdrop-filter: blur(2px); pointer-events: none; }
#wxa-viewer[data-dragging="true"] .v-drop { display: grid; }
.v-drop-box { padding: 28px 40px; border: 2px dashed var(--accent); border-radius: 14px; background: var(--panel); text-align: center; }
.v-drop-box strong { display: block; font-size: 15px; margin-bottom: 4px; }
.v-drop-box span { color: var(--muted); }

/* 提示 */
.v-toast { position: fixed; left: 50%; bottom: 20px; z-index: 60; transform: translate(-50%, 8px); opacity: 0; max-width: min(560px, calc(100vw - 40px)); padding: 8px 14px; border-radius: 8px; background: #1d1d1f; color: #fff; font-size: 12.5px; box-shadow: 0 8px 24px rgba(0,0,0,.18); transition: opacity .16s, transform .16s; pointer-events: none; }
.v-toast[data-show="true"] { opacity: 1; transform: translate(-50%, 0); }
.v-toast[data-error="true"] { background: var(--danger); }
#wxa-viewer[aria-busy="true"] .v-bar { cursor: progress; }
`;
