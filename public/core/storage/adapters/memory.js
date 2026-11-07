/**
 * adapters/memory.js — L1 内存适配器
 * 最快、进程内、刷新即失。所有读写的强制前置缓存层。
 * 统一接口：{ name, get, set, del, list, stat, clear } 均返回 Promise。
 */

export function createMemoryAdapter() {
  const store = new Map();   // path -> entry
  const name = 'memory';

  const get = async (path) => {
    const e = store.get(path);
    return e ? structuredCloneSafe(e) : undefined;
  };
  const set = async (path, entry) => {
    store.set(path, structuredCloneSafe(entry));
    return true;
  };
  const del = async (path) => store.delete(path);
  const list = async (prefix = '') => [...store.keys()].filter((p) => p.startsWith(prefix));
  const stat = async (path) => {
    const e = store.get(path);
    return e ? { path, ...e.meta } : undefined;
  };
  const clear = async (prefix = '') => {
    let n = 0;
    for (const p of [...store.keys()]) {
      if (!prefix || p.startsWith(prefix)) { store.delete(p); n++; }
    }
    return n;
  };
  const size = () => store.size;

  return { name, get, set, del, list, stat, clear, size };
}

function structuredCloneSafe(v) {
  if (v === undefined || v === null || typeof v !== 'object') return v;
  try { return structuredClone(v); }
  catch { return JSON.parse(JSON.stringify(v)); }
}
