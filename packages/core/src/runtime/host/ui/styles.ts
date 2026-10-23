/** 外壳边框（box-shadow 最外圈）宽度，缩放时计入手机外框尺寸 */
export const DEVICE_BEZEL = 13;
export const STAGE_PADDING = 24;
export const STAGE_GAP = 16;
/** 选择器每一行的高度，一列显示 5 行，选中项在中间（与开发者工具的 WeUI picker 相同） */
export const PICKER_ITEM_HEIGHT = 48;

export const SHELL_CSS = `
html, body { margin: 0; height: 100%; background: radial-gradient(120% 80% at 50% 0%, #f6f7f9 0%, #e6e9ee 100%); font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Helvetica Neue", sans-serif; -webkit-font-smoothing: antialiased; }
.wxa-stage { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: ${STAGE_GAP}px; padding: ${STAGE_PADDING}px; box-sizing: border-box; }
.wxa-device-slot { position: relative; flex: none; }
.wxa-device { position: absolute; transform-origin: 0 0; overflow: hidden; background: #fff; border-radius: 6px; display: flex; flex-direction: column; box-shadow: 0 0 0 ${DEVICE_BEZEL - 2}px #111214, 0 0 0 ${DEVICE_BEZEL - 1}px #3a3b3f, 0 0 0 ${DEVICE_BEZEL}px #1b1c1f, 0 32px 64px -12px rgba(15,23,42,.35), 0 14px 28px -8px rgba(15,23,42,.18); }
.wxa-device.has-notch { border-radius: 40px; }
.wxa-notch { position: absolute; top: 0; left: 50%; z-index: 30; width: 209px; height: 30px; transform: translateX(-50%); background: #000; border-radius: 0 0 20px 20px; pointer-events: none; }
.wxa-notch::before, .wxa-notch::after { content: ''; position: absolute; top: 0; width: 6px; height: 6px; }
.wxa-notch::before { left: -6px; background: radial-gradient(circle at 0 100%, transparent 5.5px, #000 6px); }
.wxa-notch::after { right: -6px; background: radial-gradient(circle at 100% 100%, transparent 5.5px, #000 6px); }
.wxa-home-indicator { position: absolute; bottom: 8px; left: 50%; z-index: 30; width: 134px; height: 5px; transform: translateX(-50%); border-radius: 3px; background: rgba(0,0,0,.85); pointer-events: none; }
.wxa-statusbar { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 0 8px; font-size: 12px; font-weight: 600; box-sizing: border-box; user-select: none; }
.wxa-statusbar-icons { display: flex; align-items: center; gap: 5px; }
.wxa-statusbar svg { display: block; }
.has-notch .wxa-statusbar { display: grid; grid-template-columns: 1fr 209px 1fr; align-items: start; padding: 15px 0 0; font-size: 15px; letter-spacing: -.2px; }
.has-notch .wxa-statusbar-time { grid-column: 1; justify-self: center; line-height: 20px; }
.has-notch .wxa-statusbar-icons { grid-column: 3; justify-self: center; height: 20px; }
.wxa-navbar { flex: none; height: 44px; position: relative; display: flex; align-items: center; justify-content: center; box-sizing: border-box; }
.wxa-navbar.is-hidden, .wxa-statusbar.is-hidden { display: none; }
.wxa-navbar-title { font-size: 17px; font-weight: 600; max-width: calc(100% - 204px); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.wxa-navbar-back { position: absolute; left: 4px; top: 0; height: 44px; width: 44px; padding: 0; border: 0; background: none; color: inherit; cursor: pointer; display: flex; align-items: center; justify-content: center; }
.wxa-navbar-loading { width: 14px; height: 14px; margin-right: 6px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: wxa-spin .8s linear infinite; display: none; }
.wxa-navbar.is-loading .wxa-navbar-loading { display: inline-block; }
.wxa-capsule { position: absolute; z-index: 6; display: flex; align-items: center; box-sizing: border-box; border-radius: 16px; border: .5px solid rgba(0,0,0,.12); background: rgba(255,255,255,.62); color: #000; -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); user-select: none; }
.wxa-capsule.is-light { border-color: rgba(255,255,255,.28); background: rgba(0,0,0,.18); color: #fff; }
.wxa-capsule > span { flex: 1; height: 100%; display: flex; align-items: center; justify-content: center; }
.wxa-capsule > span + span { position: relative; }
.wxa-capsule > span + span::before { content: ''; position: absolute; left: 0; top: 8px; bottom: 8px; width: 1px; background: currentColor; opacity: .25; transform: scaleX(.5); }
.wxa-capsule svg { display: block; }
.wxa-pages { flex: 1; position: relative; overflow: hidden; }
.wxa-pages iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; }
.wxa-tabbar { flex: none; height: calc(50px + var(--wxa-safe-bottom, 0px)); padding-bottom: var(--wxa-safe-bottom, 0px); display: flex; border-top: .5px solid rgba(0,0,0,.1); box-sizing: border-box; }
.wxa-tabbar.is-hidden { display: none; }
.wxa-tabbar-item { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; font-size: 10px; cursor: pointer; user-select: none; gap: 2px; }
.wxa-tabbar-item img { width: 24px; height: 24px; display: block; }
.wxa-tabbar-icon, .wxa-tabbar-text { position: relative; }
.wxa-tabbar-badge { position: absolute; top: -4px; left: calc(100% - 6px); min-width: 16px; height: 16px; padding: 0 5px; box-sizing: border-box; border-radius: 8px; background: #fa5151; color: #fff; font-size: 11px; line-height: 16px; text-align: center; white-space: nowrap; }
.wxa-tabbar-dot { position: absolute; top: -2px; left: calc(100% - 2px); width: 8px; height: 8px; border-radius: 50%; background: #fa5151; }
.wxa-tabbar-text > .wxa-tabbar-badge { top: -10px; left: calc(100% + 1px); }
.wxa-tabbar-text > .wxa-tabbar-dot { top: -3px; left: calc(100% + 1px); }
.wxa-overlay { position: absolute; inset: 0; pointer-events: none; z-index: 10; }
.wxa-mask { position: absolute; inset: 0; pointer-events: auto; }
.wxa-mask.is-dim { background: rgba(0,0,0,.5); }
.wxa-toast { position: absolute; left: 50%; top: 45%; transform: translate(-50%, -50%); min-width: 120px; max-width: 70%; padding: 14px 16px; border-radius: 8px; background: rgba(17,17,17,.75); color: #fff; font-size: 14px; text-align: center; box-sizing: border-box; pointer-events: none; }
.wxa-toast.has-icon { width: 136px; min-height: 120px; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 10px; }
.wxa-toast-icon { font-size: 36px; line-height: 1; }
.wxa-toast-spinner { width: 34px; height: 34px; border: 3px solid #fff; border-right-color: transparent; border-radius: 50%; animation: wxa-spin .8s linear infinite; }
.wxa-modal { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 80%; background: #fff; border-radius: 12px; overflow: hidden; pointer-events: auto; text-align: center; }
.wxa-modal-title { padding: 24px 20px 8px; font-size: 17px; font-weight: 600; }
.wxa-modal-content { padding: 8px 20px 24px; font-size: 15px; color: #666; white-space: pre-wrap; word-break: break-word; }
.wxa-modal-input { width: calc(100% - 40px); margin: 0 20px 20px; padding: 8px; font-size: 15px; box-sizing: border-box; border: 1px solid #ddd; border-radius: 4px; }
.wxa-modal-actions { display: flex; border-top: 1px solid rgba(0,0,0,.1); }
.wxa-modal-actions button { flex: 1; height: 50px; border: 0; background: none; font-size: 17px; font-weight: 600; cursor: pointer; }
.wxa-modal-actions button + button { border-left: 1px solid rgba(0,0,0,.1); }
.wxa-actionsheet { position: absolute; left: 0; right: 0; bottom: 0; background: #f7f7f7; border-radius: 12px 12px 0 0; overflow: hidden; pointer-events: auto; }
.wxa-actionsheet-alert { padding: 16px; font-size: 13px; color: #888; text-align: center; background: #fff; }
.wxa-actionsheet button { display: block; width: 100%; height: 56px; border: 0; border-top: 1px solid rgba(0,0,0,.06); background: #fff; font-size: 17px; cursor: pointer; }
.wxa-actionsheet .wxa-actionsheet-cancel { margin-top: 8px; border-top: 0; }
.wxa-picker-layer .wxa-mask.is-dim { background: rgba(0,0,0,.6); animation: wxa-fade-in .3s ease forwards; }
.wxa-picker { position: absolute; left: 0; right: 0; bottom: 0; padding-bottom: var(--wxa-safe-bottom, 0px); background: #fff; pointer-events: auto; user-select: none; animation: wxa-slide-up .3s ease forwards; }
.wxa-picker-header { position: relative; display: flex; padding: 16px; font-size: 17px; line-height: 1.4; }
.wxa-picker-header::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; border-bottom: 1px solid rgba(0,0,0,.1); transform: scaleY(.5); transform-origin: 0 100%; }
.wxa-picker-header button { flex: 1; padding: 0; border: 0; background: none; font: inherit; cursor: pointer; }
.wxa-picker-cancel { color: rgba(0,0,0,.5); text-align: left; }
.wxa-picker-confirm { color: #07c160; text-align: right; }
.wxa-picker-body { position: relative; display: flex; height: ${PICKER_ITEM_HEIGHT * 5}px; overflow: hidden; }
.wxa-picker-column { flex: 1; min-width: 0; overflow-y: auto; padding: ${PICKER_ITEM_HEIGHT * 2}px 0; box-sizing: border-box; scroll-snap-type: y mandatory; overscroll-behavior: contain; scrollbar-width: none; }
.wxa-picker-column::-webkit-scrollbar { display: none; }
/* 开发者工具里选项没有单独设置字号，继承到的是 11px（按它的截图量得） */
.wxa-picker-item { height: ${PICKER_ITEM_HEIGHT}px; line-height: ${PICKER_ITEM_HEIGHT}px; overflow: hidden; font-size: 11px; color: rgba(0,0,0,.9); text-align: center; white-space: nowrap; text-overflow: ellipsis; scroll-snap-align: center; cursor: pointer; }
.wxa-picker-mask { position: absolute; inset: 0; z-index: 1; pointer-events: none; background-image: linear-gradient(180deg, rgba(255,255,255,.95), rgba(255,255,255,.6)), linear-gradient(0deg, rgba(255,255,255,.95), rgba(255,255,255,.6)); background-position: top, bottom; background-size: 100% 92px; background-repeat: no-repeat; }
.wxa-picker-indicator { position: absolute; left: 0; right: 0; top: 92px; z-index: 1; height: 56px; pointer-events: none; }
.wxa-picker-indicator::before, .wxa-picker-indicator::after { content: ''; position: absolute; left: 0; right: 0; height: 1px; transform: scaleY(.5); }
.wxa-picker-indicator::before { top: 0; border-top: 1px solid rgba(0,0,0,.1); transform-origin: 0 0; }
.wxa-picker-indicator::after { bottom: 0; border-bottom: 1px solid rgba(0,0,0,.1); transform-origin: 0 100%; }
.wxa-preview { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; background: #000; pointer-events: auto; }
.wxa-preview-image { max-width: 100%; max-height: 100%; object-fit: contain; }
.wxa-preview-position { position: absolute; top: 60px; left: 0; right: 0; color: #fff; font-size: 15px; text-align: center; pointer-events: none; }
.wxa-preview button { position: absolute; top: 50%; width: 40px; height: 56px; margin-top: -28px; border: 0; border-radius: 8px; background: rgba(255,255,255,.15); color: #fff; font-size: 28px; cursor: pointer; }
.wxa-preview .wxa-preview-prev { left: 8px; }
.wxa-preview .wxa-preview-next { right: 8px; }
.wxa-error { position: absolute; inset: 0; z-index: 20; overflow: auto; padding: 20px; background: #fff5f5; color: #c00; font: 12px/1.6 Menlo, monospace; white-space: pre-wrap; }
.wxa-toolbar { display: flex; align-items: center; gap: 10px; padding: 4px 4px 4px 12px; border-radius: 999px; background: rgba(255,255,255,.7); box-shadow: 0 1px 2px rgba(15,23,42,.08); font-size: 12px; color: #555; }
.wxa-toolbar button { border: 0; background: #111214; color: #fff; border-radius: 999px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.wxa-toolbar .wxa-scale { min-width: 52px; background: #fff; color: #333; box-shadow: inset 0 0 0 1px rgba(0,0,0,.12); font-variant-numeric: tabular-nums; }
.wxa-route { font-family: Menlo, monospace; }
.wxa-notice { position: fixed; top: 16px; right: 16px; z-index: 100; display: flex; align-items: flex-start; gap: 10px; width: max-content; max-width: min(320px, calc(100vw - 32px)); padding: 12px 10px 12px 14px; box-sizing: border-box; border-radius: 12px; background: #fff; box-shadow: 0 0 0 1px rgba(15,23,42,.06), 0 12px 32px -8px rgba(15,23,42,.28); font-size: 13px; line-height: 20px; color: #555; animation: wxa-notice-in .18s ease-out; }
.wxa-notice-icon { flex: none; width: 18px; height: 18px; margin-top: 1px; border-radius: 50%; background: #fa5151; color: #fff; font-size: 12px; font-weight: 700; line-height: 18px; text-align: center; }
.wxa-notice-text { flex: 1; min-width: 0; word-break: break-word; text-wrap: pretty; }
.wxa-notice-title { font-weight: 600; color: #111214; }
.wxa-notice-close { flex: none; width: 20px; height: 20px; padding: 0; border: 0; border-radius: 50%; background: none; color: #999; font-size: 16px; line-height: 20px; cursor: pointer; }
.wxa-notice-close:hover { background: rgba(0,0,0,.06); color: #111214; }
@keyframes wxa-spin { to { transform: rotate(360deg); } }
@keyframes wxa-fade-in { from { opacity: 0; } }
@keyframes wxa-slide-up { from { transform: translateY(100%); } }
@keyframes wxa-notice-in { from { opacity: 0; transform: translateY(-8px); } }
`;
