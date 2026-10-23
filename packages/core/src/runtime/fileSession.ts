/** 与 Storage 使用相同的浏览器持久范围：刷新和同上下文页面共享，新上下文独立。 */
export const FILE_SESSION_KEY = '__wxa_file_session__';

export function fileSession(): string {
  let session = localStorage.getItem(FILE_SESSION_KEY);
  if (!session || !/^[a-z0-9-]{1,80}$/i.test(session)) {
    session = crypto.randomUUID();
    localStorage.setItem(FILE_SESSION_KEY, session);
  }
  return session;
}
