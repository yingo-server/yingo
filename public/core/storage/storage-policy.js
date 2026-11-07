/**
 * storage-policy.js — 路径规则、选层策略、权限模型（§6.2 / §6.3 / §6.5）
 * 纯函数集合，无副作用，便于单测。
 */

import { makeError, E } from '../errors.js';

export const ZONES = Object.freeze(['system', 'shared', 'module', 'plugin', 'cache', 'tmp']);
export const PATH_RE = /^\/(system|shared|module|plugin|cache|tmp)(\/[a-z0-9-]+)*(\.[a-z0-9]+)?$/;

/** 校验路径：命名空间、kebab-case、无越狱 */
export function assertPath(path, expectedId = null) {
  if (typeof path !== 'string' || !PATH_RE.test(path)) {
    throw makeError(E.E_VFS_PATH, `非法 VFS 路径: ${path}`, { path });
  }
  if (path.includes('..') || path.includes('//')) {
    throw makeError(E.E_VFS_PATH, `路径含越狱片段: ${path}`, { path });
  }
  const zone = path.split('/')[1];
  if ((zone === 'module' || zone === 'plugin') && expectedId) {
    const owner = path.split('/')[2];
    if (owner !== expectedId) {
      throw makeError(E.E_VFS_PERMISSION, `私有区路径与模块 id 不符: ${path}`, { path, expectedId, owner });
    }
  }
  return { zone, path };
}

export function zoneOf(path) {
  assertPath(path);
  return path.split('/')[1];
}

/** 默认选层策略：返回有序后端名数组（第一个为主持久层，L1 恒为最前置缓存） */
const DEFAULT_POLICIES = [
  [/^\/system\//, ['localstorage']],
  [/^\/shared\//, ['localstorage']],
  [/^\/module\//, ['localstorage']],
  [/^\/plugin\//, ['localstorage']],
  [/^\/cache\/images\//, ['indexeddb']],
  [/^\/cache\/audio-meta\//, ['localstorage']],
  [/^\/cache\//, ['localstorage']],
  [/^\/tmp\//, []],            // 仅 L1
];

const customPolicies = [];     // { re, backends, ttl }

export function registerPolicy(prefix, policy = {}) {
  const re = prefix instanceof RegExp ? prefix : new RegExp('^' + escapeRe(prefix));
  customPolicies.unshift({ re, backends: policy.backends || ['localstorage'], ttl: policy.ttl ?? null });
  return () => {
    const i = customPolicies.findIndex((p) => p.re === re);
    if (i >= 0) customPolicies.splice(i, 1);
  };
}

export function resolvePolicy(path) {
  assertPath(path);
  for (const p of customPolicies) {
    if (p.re.test(path)) return { backends: p.backends, ttl: p.ttl };
  }
  for (const [re, backends] of DEFAULT_POLICIES) {
    if (re.test(path)) return { backends, ttl: /^\/cache\//.test(path) ? 86400 : null };
  }
  return { backends: ['localstorage'], ttl: null };
}

/**
 * 权限判定。
 * @param {'read'|'write'|'delete'} op
 * @param {string} path
 * @param {{origin:string, permissions:string[], isKernel?:boolean}} actor
 */
export function checkPermission(op, path, actor) {
  assertPath(path);
  if (actor?.isKernel) return true;
  const zone = zoneOf(path);
  const perms = actor?.permissions || [];
  const origin = actor?.origin || 'unknown';

  switch (zone) {
    case 'system':
      if (op !== 'read') {
        throw makeError(E.E_VFS_PERMISSION, `/system/* 只读（${op} 被拒绝）`, { path, op, origin });
      }
      return true;
    case 'shared':
      if (op === 'read') return true;
      if (!perms.includes('storage:write:shared')) {
        throw makeError(E.E_VFS_PERMISSION, `写 /shared/* 需 storage:write:shared`, { path, op, origin, perms });
      }
      return true;
    case 'module':
    case 'plugin': {
      const owner = path.split('/')[2];
      if (owner !== origin) {
        throw makeError(E.E_VFS_PERMISSION, `私有区越权: ${origin} → ${path}`, { path, op, origin, owner });
      }
      return true;
    }
    case 'cache':
    case 'tmp':
      return true;
    default:
      throw makeError(E.E_VFS_PERMISSION, `未知分区`, { path, op, origin });
  }
}

/** 插件句柄的路径前缀绑定：插件不能构造绝对路径访问他人私有区 */
export function bindPluginPath(pluginId, userPath) {
  const clean = String(userPath || '').replace(/^\/+/, '');
  const full = `/plugin/${pluginId}/${clean}`.replace(/\/+$/, '');
  assertPath(full, pluginId);
  return full;
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 计算条目字节数（Blob/字符串/对象） */
export function estimateSize(value) {
  try {
    if (value instanceof Blob) return value.size;
    if (typeof value === 'string') return new Blob([value]).size;
    return new Blob([JSON.stringify(value)]).size;
  } catch { return 0; }
}
