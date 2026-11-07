/**
 * adapters/indexeddb.js — L3 适配器
 * ★ 全仓唯一允许直接访问 indexedDB 的文件（check-spec.mjs 白名单）。
 * 承载结构化数据、大对象、音乐元数据、上传背景图 Blob、/cache/images/*。
 * 单库单 store，path 作 key；不依赖任何第三方库。
 */

const DB_NAME = 'yingo-vfs';
const DB_VERSION = 1;
const STORE = 'entries';

export function createIndexedDbAdapter() {
  const name = 'indexeddb';
  let dbPromise = null;
  let available = false;

  const open = () => {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') { reject(new Error('indexedDB 不可用')); return; }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'path' });
      };
      req.onsuccess = () => { available = true; resolve(req.result); };
      req.onerror = () => reject(req.error || new Error('indexedDB 打开失败'));
      req.onblocked = () => reject(new Error('indexedDB 被阻塞'));
    }).catch((e) => { dbPromise = null; throw e; });
    return dbPromise;
  };

  const tx = async (mode, fn) => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      const req = fn(store);
      let result;
      if (req && typeof req.onsuccess !== 'undefined') {
        req.onsuccess = () => { result = req.result; };
      }
      t.oncomplete = () => resolve(result);
      t.onerror = () => reject(t.error || new Error('indexedDB 事务失败'));
      t.onabort = () => reject(t.error || new Error('indexedDB 事务中止'));
    });
  };

  const get = async (path) => {
    try { return await tx('readonly', (s) => s.get(path)); }
    catch (e) { if (!available) return undefined; throw e; }
  };
  const set = async (path, entry) => {
    await tx('readwrite', (s) => s.put({ ...entry, path }));
    return true;
  };
  const del = async (path) => {
    await tx('readwrite', (s) => s.delete(path));
    return true;
  };
  const list = async (prefix = '') => {
    try {
      const all = await tx('readonly', (s) => s.getAllKeys());
      return (all || []).filter((p) => typeof p === 'string' && p.startsWith(prefix));
    } catch (e) { if (!available) return []; throw e; }
  };
  const stat = async (path) => {
    const e = await get(path);
    return e ? { path, ...(e.meta || {}) } : undefined;
  };
  const clear = async (prefix = '') => {
    const paths = await list(prefix);
    for (const p of paths) await del(p);
    return paths.length;
  };
  const usage = async () => {
    try {
      const all = await tx('readonly', (s) => s.getAll());
      return (all || []).reduce((n, e) => n + (e?.meta?.size || 0), 0);
    } catch { return 0; }
  };

  return { name, get available() { return available; }, get, set, del, list, stat, clear, usage };
}
