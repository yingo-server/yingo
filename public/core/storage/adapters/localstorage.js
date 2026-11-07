/**
 * adapters/localstorage.js — L2 适配器
 * ★ 全仓唯一允许直接访问 localStorage 的文件（check-spec.mjs 白名单）。
 * 承载小体积配置与偏好；条目以 yingo:vfs: 前缀存放，避免与遗留键冲突。
 */

const PREFIX = 'yingo:vfs:';

export function createLocalStorageAdapter() {
  const name = 'localstorage';
  const available = (() => {
    try {
      const k = PREFIX + '__probe__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch { return false; }
  })();

  const key = (path) => PREFIX + path;

  const get = async (path) => {
    if (!available) throw new Error('localStorage 不可用');
    const raw = localStorage.getItem(key(path));
    if (raw === null) return undefined;
    try { return JSON.parse(raw); } catch { return undefined; }
  };
  const set = async (path, entry) => {
    if (!available) throw new Error('localStorage 不可用');
    localStorage.setItem(key(path), JSON.stringify(entry));
    return true;
  };
  const del = async (path) => {
    if (!available) return false;
    localStorage.removeItem(key(path));
    return true;
  };
  const list = async (prefix = '') => {
    if (!available) return [];
    const out = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PREFIX)) {
        const p = k.slice(PREFIX.length);
        if (!prefix || p.startsWith(prefix)) out.push(p);
      }
    }
    return out;
  };
  const stat = async (path) => {
    const e = await get(path);
    return e ? { path, ...e.meta } : undefined;
  };
  const clear = async (prefix = '') => {
    const paths = await list(prefix);
    for (const p of paths) await del(p);
    return paths.length;
  };
  const usage = async () => {
    if (!available) return 0;
    let n = 0;
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith(PREFIX)) n += (localStorage.getItem(k) || '').length;
    }
    return n;
  };

  return { name, available, get, set, del, list, stat, clear, usage };
}
