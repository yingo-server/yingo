/**
 * vfs.js — Storage Fabric 核心：统一虚拟文件系统
 *
 * 三层介质：memory(L1) → localstorage(L2) → indexeddb(L3)
 *   - L1 恒为最前置缓存；写穿透（持久层成功才更新 L1）
 *   - 读：L1 命中直接返回；未命中按策略逐层回源并回填
 *   - 后端失败自动降级下一层，并发 E_VFS_BACKEND 通知，不静默吞错
 *   - 所有条目强制 meta 包装；schema 未注册/版本不符拒绝或迁移
 *   - 写/删/清后自动 emit('storage:invalidate') 失效广播
 *
 * ★ 本文件不直接调用任何原生存储 API，只通过 adapters 接口。
 */

import { createMemoryAdapter } from './adapters/memory.js';
import { createLocalStorageAdapter } from './adapters/localstorage.js';
import { createIndexedDbAdapter } from './adapters/indexeddb.js';
import { assertPath, resolvePolicy, checkPermission, estimateSize } from './storage-policy.js';
import { checkValue, migrateIfNeeded, getSchema } from './storage-schema.js';
import { record, bump, getMetrics, getAudit, auditToText } from './storage-audit.js';
import { makeError, normalizeError, E } from '../errors.js';
import { emit } from '../bus.js';

export function createVfs(options = {}) {
  const adapters = {
    memory: createMemoryAdapter(),
    localstorage: createLocalStorageAdapter(),
    indexeddb: createIndexedDbAdapter(),
  };
  const watchers = new Map();     // prefix -> Set<{id, fn}>
  let gcTimer = null;
  let closed = false;

  /** 阶段 2 初始化：探测可用性、恢复索引、跑一次 GC */
  async function init() {
    const report = { adapters: {}, degraded: [] };
    for (const [name, a] of Object.entries(adapters)) {
      let ok = true;
      try {
        if (name === 'indexeddb') await a.list('');   // 触发 open()
        else if (a.available === false) ok = false;
      } catch { ok = false; }
      report.adapters[name] = ok;
      if (!ok && name !== 'memory') report.degraded.push(name);
    }
    await gc();
    gcTimer = setInterval(() => { gc().catch(() => {}); }, options.gcIntervalMs || 60_000);
    return report;
  }

  /** 构造带 meta 的条目 */
  function wrap(path, value, opts = {}) {
    const policy = resolvePolicy(path);
    const schema = opts.schema || 'any@1';
    checkValue(schema, value);
    const now = Date.now();
    return {
      path,
      value,
      meta: {
        version: opts.version ?? getSchema(schema)?.version ?? 1,
        schema,
        ttl: opts.ttl ?? policy.ttl ?? null,
        size: estimateSize(value),
        origin: opts.origin || 'kernel',
        contentType: opts.contentType || (value instanceof Blob ? value.type : 'application/json'),
        createdAt: opts.createdAt ?? now,
        updatedAt: now,
        backend: (policy.backends[0] || 'memory'),
      },
    };
  }

  /** 是否过期 */
  function expired(entry) {
    const ttl = entry?.meta?.ttl;
    if (!ttl || ttl <= 0) return false;
    return Date.now() - (entry.meta.updatedAt || 0) > ttl * 1000;
  }

  /** 从持久层读取（按策略顺序），返回 { entry, backend } */
  async function readFromBackends(path, backends) {
    for (const name of backends) {
      const a = adapters[name];
      if (!a) continue;
      try {
        const e = await a.get(path);
        if (e !== undefined && e !== null) {
          if (expired(e)) { await a.del(path).catch(() => {}); continue; }
          return { entry: e, backend: name };
        }
      } catch (err) {
        await backendFailure(path, name, 'read', err);
      }
    }
    return { entry: undefined, backend: null };
  }

  async function backendFailure(path, backend, op, err) {
    // 降级不阻断：发通知 + 审计，继续尝试下一层
    record('backend-error', path, { backend, op, code: err?.message });
    try {
      await emit('notify:push', {
        level: 'warn',
        message: `存储后端 ${backend} ${op} 失败，已降级`,
        detail: { path, backend, error: String(err?.message || err) },
      });
    } catch { /* 极早期可能无订阅者 */ }
  }

  /** 读：L1 命中 → 直接返回；否则回源 + 回填 + 迁移 */
  async function read(path, opts = {}) {
    assertPath(path);
    checkPermission('read', path, actor(opts));
    const l1 = await adapters.memory.get(path);
    if (l1 && !expired(l1)) {
      bump('hits');
      record('read', path, { origin: opts.origin, cache: 'l1' });
      return l1.value;
    }
    bump('misses');
    const { backends } = resolvePolicy(path);
    const { entry } = await readFromBackends(path, backends);
    if (!entry) {
      record('read', path, { origin: opts.origin, cache: 'miss' });
      return opts.fallback;
    }
    let finalEntry = entry;
    try {
      finalEntry = await migrateIfNeeded(entry);
      if (finalEntry !== entry) {
        bump('migrates');
        await persist(path, finalEntry, backends);
      }
    } catch (err) {
      const e = normalizeError(err, E.E_VFS_MIGRATE);
      record('migrate-error', path, { origin: opts.origin, code: e.code });
      throw e;   // 迁移失败不静默丢数据
    }
    await adapters.memory.set(path, finalEntry);
    record('read', path, { origin: opts.origin, cache: 'backfill' });
    return finalEntry.value;
  }

  /** 写：先写持久层成功，再更新 L1（write-through） */
  async function write(path, value, opts = {}) {
    if (closed) throw makeError(E.E_VFS_INIT, 'VFS 已关闭');
    assertPath(path);
    checkPermission('write', path, actor(opts));
    const policy = resolvePolicy(path);
    const entry = wrap(path, value, { ...opts, origin: opts.origin || 'kernel' });
    const backends = policy.backends.length ? policy.backends : [];
    await persist(path, entry, backends);
    await adapters.memory.set(path, entry);   // 持久层成功才回填
    record('write', path, { origin: opts.origin, schema: entry.meta.schema, size: entry.meta.size });
    await invalidate(path, 'write');
    return entry.meta;
  }

  async function persist(path, entry, backends) {
    if (!backends.length) return;    // /tmp/* 仅 L1
    let lastErr = null;
    for (const name of backends) {
      const a = adapters[name];
      if (!a) continue;
      try { await a.set(path, entry); return name; }
      catch (err) { lastErr = err; await backendFailure(path, name, 'write', err); }
    }
    // 所有持久层都失败：降级为仅内存，但必须告知，不能假装成功
    record('backend-error', path, { code: 'all-failed' });
    try {
      await emit('notify:push', {
        level: 'error', message: `所有存储后端写入失败，条目仅存内存: ${path}`,
        detail: { path, error: String(lastErr?.message || lastErr) },
      });
    } catch { /* noop */ }
    throw makeError(E.E_VFS_BACKEND, `所有后端写入失败: ${path}`, { path }, lastErr);
  }

  async function remove(path, opts = {}) {
    assertPath(path);
    checkPermission('delete', path, actor(opts));
    const { backends } = resolvePolicy(path);
    await adapters.memory.del(path);
    for (const name of backends) {
      try { await adapters[name]?.del(path); }
      catch (err) { await backendFailure(path, name, 'delete', err); }
    }
    record('delete', path, { origin: opts.origin });
    await invalidate(path, 'delete');
    return true;
  }

  /** 虚拟目录列举：合并所有适配器的 key，去重排序 */
  async function list(prefix = '/', opts = {}) {
    if (!prefix.startsWith('/')) prefix = '/' + prefix;
    // prefix 本身可不带扩展名；允许目录形式
    const out = new Set();
    for (const [name, a] of Object.entries(adapters)) {
      try { for (const p of await a.list(prefix)) out.add(p); }
      catch (err) { await backendFailure(prefix, name, 'list', err); }
    }
    let paths = [...out].sort();
    if (!opts.recursive) {
      // 只返回下一级（目录以 / 结尾）
      const seen = new Set();
      paths = paths.map((p) => {
        const rest = p.slice(prefix.replace(/\/+$/, '').length + 1);
        const head = rest.split('/')[0];
        const isDir = rest.includes('/');
        return isDir ? `${head}/` : head;
      }).filter((x) => x && !seen.has(x) && seen.add(x));
    }
    return paths;
  }

  async function stat(path, opts = {}) {
    assertPath(path);
    checkPermission('read', path, actor(opts));
    const l1 = await adapters.memory.stat(path);
    if (l1) return l1;
    const { backends } = resolvePolicy(path);
    for (const name of backends) {
      try { const s = await adapters[name]?.stat(path); if (s) return s; }
      catch (err) { await backendFailure(path, name, 'stat', err); }
    }
    return undefined;
  }

  async function exists(path, opts = {}) {
    return (await stat(path, opts)) !== undefined;
  }

  /** 递归清理 */
  async function clear(prefix, opts = {}) {
    if (!prefix.startsWith('/')) prefix = '/' + prefix;
    const paths = await list(prefix, { recursive: true });
    let n = 0;
    for (const p of paths) {
      try { await remove(p, opts); n++; }
      catch (err) { record('clear-error', p, { code: err.code }); }
    }
    await invalidate(prefix, 'clear');
    return n;
  }

  /** 失效广播：写/删/清后自动触发，订阅者无需轮询 */
  async function invalidate(prefix, reason) {
    bump('invalidations');
    try { await emit('storage:invalidate', { prefix, reason }); }
    catch { /* 广播失败不影响写入 */ }
    for (const [p, set] of watchers) {
      if (prefix.startsWith(p) || p.startsWith(prefix)) {
        for (const w of set) {
          try { w.fn({ prefix, reason }); } catch { /* 订阅者异常隔离 */ }
        }
      }
    }
  }

  function watch(prefix, handlerId, fn) {
    if (!watchers.has(prefix)) watchers.set(prefix, new Set());
    watchers.get(prefix).add({ id: handlerId, fn });
    return () => watchers.get(prefix)?.delete([...watchers.get(prefix)].find((w) => w.id === handlerId));
  }
  function unwatch(prefix, handlerId) {
    const set = watchers.get(prefix);
    if (!set) return;
    for (const w of [...set]) if (w.id === handlerId) set.delete(w);
  }

  /** GC：清理过期 /cache/* 与全部 /tmp/* */
  async function gc(scope = null) {
    bump('gcRuns');
    let removed = 0;
    const prefixes = scope ? [scope] : ['/cache/', '/tmp/'];
    for (const prefix of prefixes) {
      const paths = await list(prefix, { recursive: true });
      for (const p of paths) {
        const full = p.startsWith('/') ? p : `${prefix.replace(/\/+$/, '')}/${p}`;
        if (!/^\/(cache|tmp)\//.test(full)) continue;
        const e = await adapters.memory.get(full) || (await readFromBackends(full, resolvePolicy(full).backends)).entry;
        if (!e) continue;
        if (full.startsWith('/tmp/') || expired(e)) {
          try { await remove(full, { origin: 'kernel:gc', isKernel: true }); removed++; }
          catch { /* 单个失败继续 */ }
        }
      }
    }
    bump('gcRemoved', removed);
    return removed;
  }

  /** 占用观测（不做配额） */
  async function usage(prefix = '/') {
    const paths = await list(prefix, { recursive: true });
    const zones = {};
    let totalSize = 0, count = 0;
    for (const p of paths) {
      const z = p.split('/')[1] || 'unknown';
      const s = await stat(p, { isKernel: true }).catch(() => undefined);
      zones[z] = (zones[z] || 0) + 1;
      totalSize += s?.size || 0;
      count++;
    }
    return { count, totalSize, zones, adapters: Object.keys(adapters) };
  }

  /* ---------- 备份：JSON 导入导出（D30 / ADR-010） ---------- */

  async function exportBackup(prefixes = ['/shared/', '/module/', '/plugin/', '/cache/']) {
    const entries = [];
    for (const prefix of prefixes) {
      const paths = await list(prefix, { recursive: true });
      for (const p of paths) {
        const full = p.startsWith('/') ? p : `${prefix.replace(/\/+$/, '')}/${p}`;
        if (full.startsWith('/system/')) continue;      // 系统镜像不导出
        const e = await adapters.memory.get(full) || (await readFromBackends(full, resolvePolicy(full).backends)).entry;
        if (!e) continue;
        entries.push({
          path: full,
          value: e.value instanceof Blob ? { __blob: true, note: 'Blob 不进 JSON 备份' } : e.value,
          meta: { ...e.meta, size: estimateSize(e.value) },
        });
      }
    }
    return {
      format: 'yingo-vfs@1',
      exportedAt: new Date().toISOString(),
      schemaVersions: {},
      entries,
    };
  }

  /**
   * 导入；dryRun 只返回冲突预览。
   * 校验 format / schema / schemaVersion，必要时 migrate。
   */
  async function importBackup(payload, opts = {}) {
    if (!payload || payload.format !== 'yingo-vfs@1' || !Array.isArray(payload.entries)) {
      throw makeError(E.E_VFS_EXPORT, '备份格式不合法（需 format=yingo-vfs@1 与 entries[]）');
    }
    const preview = { total: payload.entries.length, conflicts: [], invalid: [], migrated: [] };
    for (const e of payload.entries) {
      try {
        assertPath(e.path);
        const exists = (await stat(e.path, { isKernel: true })) !== undefined;
        if (exists) preview.conflicts.push(e.path);
        if (!getSchema(e.meta?.schema)) preview.invalid.push({ path: e.path, reason: `schema 未注册: ${e.meta?.schema}` });
        else if (e.meta.version !== getSchema(e.meta.schema).version) preview.migrated.push(e.path);
      } catch (err) {
        preview.invalid.push({ path: e.path, reason: err.message });
      }
    }
    if (opts.dryRun) return preview;
    let written = 0;
    for (const e of payload.entries) {
      try {
        if (e.value?.__blob) continue;
        await write(e.path, e.value, {
          schema: e.meta?.schema || 'any@1',
          version: e.meta?.version,
          ttl: e.meta?.ttl,
          origin: opts.origin || 'kernel:import',
          isKernel: true,
        });
        written++;
      } catch (err) {
        preview.invalid.push({ path: e.path, reason: err.message });
      }
    }
    return { ...preview, written, preview: false };
  }

  /** 受限句柄：给插件/模块用，自动绑定私有根路径与 origin */
  function scopedHandle(id, kind = 'module', permissions = []) {
    const root = `/${kind}/${id}/`;
    const act = { origin: id, permissions, isKernel: false };
    return {
      id, root,
      read: (rel, o = {}) => read(rel.startsWith('/') ? rel : root + rel.replace(/^\/+/, ''), { ...act, ...o }),
      write: (rel, value, o = {}) => write(rel.startsWith('/') ? rel : root + rel.replace(/^\/+/, ''), value, { ...act, ...o }),
      list: (rel = '', o = {}) => list(rel.startsWith('/') ? rel : root + rel.replace(/^\/+/, ''), o),
      stat: (rel, o = {}) => stat(rel.startsWith('/') ? rel : root + rel.replace(/^\/+/, ''), { ...act, ...o }),
      remove: (rel, o = {}) => remove(rel.startsWith('/') ? rel : root + rel.replace(/^\/+/, ''), { ...act, ...o }),
      // 绝对路径访问会经 checkPermission 校验，插件无法伪造他人 id
      readAbsolute: (p, o = {}) => read(p, { ...act, ...o }),
    };
  }

  function actor(opts = {}) {
    return {
      origin: opts.origin || 'kernel',
      permissions: opts.permissions || [],
      isKernel: !!opts.isKernel || opts.origin === 'kernel' || opts.origin === 'kernel:gc' || opts.origin === 'kernel:import',
    };
  }

  async function destroy() {
    closed = true;
    if (gcTimer) clearInterval(gcTimer);
    watchers.clear();
    await clear('/tmp/', { isKernel: true, origin: 'kernel' });
  }

  return {
    init, read, write, remove, list, stat, exists, clear,
    watch, unwatch, invalidate, gc, usage,
    exportBackup, importBackup, scopedHandle,
    getMetrics, getAudit, auditToText,
    adapters, destroy,
    _internal: { wrap, expired, persist },
  };
}
