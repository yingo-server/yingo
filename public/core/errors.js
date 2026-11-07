/**
 * errors.js — 统一错误码与错误对象
 * 所有异常必须经由此处构造，再经 bus 发往通知中心。
 * 约定：code 稳定、detail 可序列化、不吞异常。
 */

export const E = Object.freeze({
  // 启动 / 内核
  E_BOOT_STAGE: 'E_BOOT_STAGE',
  E_MODULE_INIT: 'E_MODULE_INIT',
  E_PLUGIN_LOAD: 'E_PLUGIN_LOAD',
  E_PLUGIN_PERMISSION: 'E_PLUGIN_PERMISSION',
  E_SCHEMA: 'E_SCHEMA',
  E_INTERNAL: 'E_INTERNAL',

  // Storage Fabric
  E_VFS_INIT: 'E_VFS_INIT',
  E_VFS_PERMISSION: 'E_VFS_PERMISSION',
  E_VFS_PATH: 'E_VFS_PATH',
  E_VFS_QUOTA: 'E_VFS_QUOTA',       // 预留：当前不启用配额策略
  E_VFS_SCHEMA: 'E_VFS_SCHEMA',
  E_VFS_MIGRATE: 'E_VFS_MIGRATE',
  E_VFS_BACKEND: 'E_VFS_BACKEND',
  E_VFS_SYNC: 'E_VFS_SYNC',         // 预留：当前纯本地，不产生此错
  E_VFS_EXPORT: 'E_VFS_EXPORT',

  // 函数 / 配置
  E_CONFIG_FORBIDDEN: 'E_CONFIG_FORBIDDEN',
  E_MANIFEST_STALE: 'E_MANIFEST_STALE',
  E_NOT_FOUND: 'E_NOT_FOUND',
  E_UPSTREAM: 'E_UPSTREAM',
  E_READONLY: 'E_READONLY',
});

/** 结构化错误；cause 保留原异常供诊断面板展开 */
export function makeError(code, message, detail = {}, cause = null) {
  const err = new Error(message || code);
  err.name = 'YingoError';
  err.code = code;
  err.detail = sanitize(detail);
  err.cause = cause;
  err.at = Date.now();
  return err;
}

/** 转成可序列化形态，避免循环引用与 DOM 节点进入日志 */
export function serializeError(err) {
  if (!err) return null;
  return {
    name: err.name || 'Error',
    code: err.code || E.E_INTERNAL,
    message: err.message || String(err),
    detail: sanitize(err.detail || {}),
    cause: err.cause ? serializeError(err.cause) : null,
    stack: typeof err.stack === 'string' ? err.stack.split('\n').slice(0, 12) : [],
    at: err.at || Date.now(),
  };
}

function sanitize(v, depth = 0) {
  if (depth > 4) return '[depth]';
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Element) return `[Element <${v.tagName.toLowerCase()}>]`;
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => sanitize(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    // 永不把疑似凭据带进日志/诊断
    if (/token|secret|password|apikey|api_key|authorization/i.test(k)) {
      out[k] = '[redacted]';
    } else {
      out[k] = sanitize(val, depth + 1);
    }
  }
  return out;
}

/** 把任意抛出的值规范化为 YingoError */
export function normalizeError(e, fallbackCode = E.E_INTERNAL) {
  if (e && e.name === 'YingoError') return e;
  return makeError(fallbackCode, e?.message || String(e), {}, e);
}
