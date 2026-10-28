/**
 * 查看器的本地存储（IndexedDB）：导入的 wxapack、各项目的 setup 与 WXA_* 变量、当前打开的项目
 *
 * 查看页面写、Service Worker（packSw.ts）读，两边都只经过这里。token 等变量只存在浏览器里，不发给任何服务端。
 */

export interface ViewerProject {
  id: string;
  /** 默认取导入的文件名（不含扩展名），可以改 */
  name: string;
  appid: string;
  /** .wxapack 原始字节 */
  pack: Uint8Array;
  importedAt: number;
  /** 包、setup、变量任一改动时更新；Service Worker 按 id + updatedAt 判断缓存的包还能不能用 */
  updatedAt: number;
  /** 在查看器里拖入或编辑的 setup 源码，覆盖包里自带的；null 表示用包里的 */
  setupSource: string | null;
  setupFileName: string | null;
  /** setupSource 编译后的 ES 模块 */
  setupScript: string | null;
  /** 传给 setup 的 env，键都以 WXA_ 开头 */
  env: Record<string, string>;
}

const DB_NAME = 'wxa-viewer';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const META = 'meta';
const ACTIVE_KEY = 'active';

let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS)) db.createObjectStore(PROJECTS, { keyPath: 'id' });
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    request.onsuccess = () => {
      const db = request.result;
      // 浏览器清理存储或别的页面升级数据库时会关掉连接，之后的读写要重新打开，不能一直拿着关掉的连接报错
      db.onclose = () => {
        opening = null;
      };
      db.onversionchange = () => {
        db.close();
        opening = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      opening = null;
      reject(request.error);
    };
  });
  return opening;
}

async function run<T>(store: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

/** 按导入时间排序，先导入的在前 */
export async function listProjects(): Promise<ViewerProject[]> {
  const all = await run<ViewerProject[]>(PROJECTS, 'readonly', store => store.getAll());
  return all.sort((a, b) => a.importedAt - b.importedAt);
}

export async function getProject(id: string): Promise<ViewerProject | null> {
  return (await run<ViewerProject | undefined>(PROJECTS, 'readonly', store => store.get(id))) ?? null;
}

/** 新增或整体替换；调用方负责更新 updatedAt */
export async function putProject(project: ViewerProject): Promise<void> {
  await run(PROJECTS, 'readwrite', store => store.put(project));
}

/** 删除的是当前项目时一并清掉 active */
export async function deleteProject(id: string): Promise<void> {
  await run(PROJECTS, 'readwrite', store => store.delete(id));
  if ((await getActiveProjectId()) === id) await setActiveProjectId(null);
}

export async function getActiveProjectId(): Promise<string | null> {
  return (await run<string | undefined>(META, 'readonly', store => store.get(ACTIVE_KEY))) ?? null;
}

export async function setActiveProjectId(id: string | null): Promise<void> {
  if (id === null) await run(META, 'readwrite', store => store.delete(ACTIVE_KEY));
  else await run(META, 'readwrite', store => store.put(id, ACTIVE_KEY));
}

/** 当前打开的项目；没有或已被删除时为 null */
export async function getActiveProject(): Promise<ViewerProject | null> {
  const id = await getActiveProjectId();
  return id ? getProject(id) : null;
}
