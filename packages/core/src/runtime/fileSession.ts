/**
 * 文件会话：开发服务器上每个会话一份用户文件和临时文件（见 DevServer 的 /__wxa__/fs）。
 * 标识和 Storage 一样存在 localStorage：刷新后不变，同一浏览器上下文的页面共用，新的上下文（Playwright 的每个用例）另起一份
 */
const KEY = '__wxa_file_session__';

export function fileSession(): string {
  let session = localStorage.getItem(KEY);
  if (!session) {
    session = crypto.randomUUID();
    localStorage.setItem(KEY, session);
  }
  return session;
}
