/**
 * storage-service.js — Storage Fabric 的总线接入层（§6.6）
 * 把 VFS 能力注册成强类型命令；模块/插件永远只经这些命令访问存储。
 * 同时在 core 阶段注册权限中间件。
 */

import { on, emit, use, setOrigin } from '../bus.js';
import { createVfs } from './vfs.js';
import { registerBuiltinSchemas, listSchemas, registerSchema, getSchema } from './storage-schema.js';
import { registerPolicy, checkPermission, assertPath } from './storage-policy.js';
import { getMetrics, getAudit, auditToText, resetMetrics } from './storage-audit.js';
import { normalizeError, makeError, E } from '../errors.js';

let vfs = null;
let handles = new Map();      // moduleId -> scopedHandle

/** Level 2 阶段调用 */
export async function initStorage() {
  registerBuiltinSchemas();
  vfs = createVfs({ gcIntervalMs: 60_000 });
  const report = await vfs.init();

  // 权限中间件：写/删/清类命令在 handler 前二次校验（纵深防御）
  use(async (cmd, payload, next) => {
    if (/^storage:(set|del|clear)$/.test(cmd)) {
      const path = payload.path || payload.prefix;
      if (path && /^\/(module|plugin)\//.test(path)) {
        const origin = payload.__origin || 'kernel';
        // 通过 scopedHandle 发起的调用已带 __origin；此处仅做最终拦截
        try { checkPermission(cmd === 'storage:set' ? 'write' : 'delete', path, { origin, permissions: payload.__permissions || [], isKernel: origin === 'kernel' }); }
        catch (err) { throw err; }
      }
    }
    return next();
  });

  registerCommands();
  if (report.degraded.length) {
    await emit('notify:push', {
      level: 'warn', message: `存储后端降级: ${report.degraded.join(', ')}`,
      detail: { report },
    });
  }
  return { ...report, schemas: listSchemas(), metrics: getMetrics() };
}

function registerCommands() {
  const call = (fn) => async (payload) => {
    try { return await fn(payload); }
    catch (err) { throw normalizeError(err, E.E_VFS_BACKEND); }
  };

  on('storage:get', call(({ path, fallback }) => vfs.read(path, { fallback, origin: 'kernel' })));
  on('storage:set', call(({ path, value, schema, ttl, __origin, __permissions }) =>
    vfs.write(path, value, { schema, ttl, origin: __origin || 'kernel', permissions: __permissions || [] })));
  on('storage:del', call(({ path, __origin, __permissions }) =>
    vfs.remove(path, { origin: __origin || 'kernel', permissions: __permissions || [] })));
  on('storage:list', call(({ prefix, recursive }) => vfs.list(prefix, { recursive })));
  on('storage:stat', call(({ path }) => vfs.stat(path, { isKernel: true })));
  on('storage:clear', call(({ prefix, __origin }) => vfs.clear(prefix, { origin: __origin || 'kernel', isKernel: true })));
  on('storage:exists', call(({ path }) => vfs.exists(path, { isKernel: true })));
  on('storage:watch', call(({ prefix, handlerId }) => {
    // 订阅者由 notify 推送，不通过返回值传函数
    vfs.watch(prefix, handlerId, ({ prefix: p, reason }) => {
      emit('notify:push', {
        level: 'debug', message: `VFS 变更: ${p} (${reason})`, detail: { prefix: p, reason },
      }).catch(() => {});
    });
    return true;
  }));
  on('storage:unwatch', call(({ prefix, handlerId }) => { vfs.unwatch(prefix, handlerId); return true; }));
  on('storage:migrate', call(async ({ path, toVersion }) => {
    const entry = await vfs._internal.wrap(path, await vfs.read(path), { version: toVersion });
    await vfs._internal.persist(path, entry, ['localstorage']);
    return true;
  }));
  on('storage:usage', call(({ prefix }) => vfs.usage(prefix || '/')));
  on('storage:gc', call(({ scope }) => vfs.gc(scope || null)));
  on('storage:invalidate', call(({ prefix, reason }) => true));   // 由 vfs 内部触发；命令仅作记录
  on('storage:export', call(({ prefixes }) => vfs.exportBackup(prefixes)));
  on('storage:import', call(({ payload, dryRun }) => vfs.importBackup(payload, { dryRun })));
}

/** 给模块/主题注入受限 VFS 句柄（ADR-005 mixin 在存储层的体现） */
export function createScopedHandle(id, kind = 'module', permissions = []) {
  if (!vfs) throw makeError(E.E_VFS_INIT, 'Storage Fabric 尚未初始化');
  const h = vfs.scopedHandle(id, kind, permissions);
  handles.set(id, h);

  // 句柄方法自动带上 __origin / __permissions，供总线权限中间件校验
  const wrap = (fn, cmd) => async (...args) => {
    const payload = fn(...args);
    if (payload instanceof Promise) {
      const p = await payload;
      return emit(cmd, { ...p, __origin: id, __permissions: permissions });
    }
    return emit(cmd, { ...payload, __origin: id, __permissions: permissions });
  };

  return {
    id, root: h.root,
    /** 相对私有根路径读写；也允许绝对路径（会做权限校验） */
    read: (rel, fallback) => emit('storage:get', { path: resolve(h.root, rel), fallback, __origin: id, __permissions: permissions }),
    write: (rel, value, schema = 'any@1', ttl) => emit('storage:set', { path: resolve(h.root, rel), value, schema, ttl, __origin: id, __permissions: permissions }),
    list: (rel = '', recursive = false) => emit('storage:list', { prefix: resolve(h.root, rel), recursive, __origin: id, __permissions: permissions }),
    stat: (rel) => emit('storage:stat', { path: resolve(h.root, rel), __origin: id, __permissions: permissions }),
    remove: (rel) => emit('storage:del', { path: resolve(h.root, rel), __origin: id, __permissions: permissions }),
    /** 访问共享区需 storage:write:shared 权限 */
    readShared: (path) => emit('storage:get', { path, __origin: id, __permissions: permissions }),
    writeShared: (path, value, schema = 'any@1') => emit('storage:set', { path, value, schema, __origin: id, __permissions: permissions }),
    watch: (prefix, handlerId) => emit('storage:watch', { prefix, handlerId }),
    unwatch: (prefix, handlerId) => emit('storage:unwatch', { prefix, handlerId }),
  };
}

function resolve(root, rel) {
  const r = String(rel || '').replace(/^\/+/, '');
  return r.startsWith('system/') || r.startsWith('shared/') || r.startsWith('cache/') || r.startsWith('tmp/')
    ? '/' + r
    : root + r;
}

export function getVfs() { return vfs; }
export function getHandles() { return [...handles.keys()]; }
export function getStorageMetrics() { return getMetrics(); }
export function getStorageAudit(filter) { return getAudit(filter); }
export function getStorageAuditText() { return auditToText(); }
export function registerStorageSchema(name, def, migrate) { return registerSchema(name, def, migrate); }
export function registerStoragePolicy(prefix, policy) { return registerPolicy(prefix, policy); }
export { getSchema };
export async function shutdownStorage() {
  if (vfs) await vfs.destroy();
  handles.clear();
  resetMetrics();
  vfs = null;
}
