/**
 * storage-schema.js — 条目 schema 注册与版本迁移
 * 每个 VFS 条目的 meta.schema 必须已注册；version 不符则自动 migrate()。
 */

import { makeError, E } from '../errors.js';

const schemas = new Map();   // name -> { name, version, definition, migrate }

/** 注册 schema；migrate(value, from, to) 可选 */
export function registerSchema(name, definition = {}, migrate = null) {
  if (!/^[a-z][a-z0-9-]*@\d+$/.test(name)) {
    throw makeError(E.E_VFS_SCHEMA, `schema 名须形如 foo@1: ${name}`);
  }
  if (schemas.has(name)) throw makeError(E.E_VFS_SCHEMA, `schema 重复注册: ${name}`);
  const version = Number(name.split('@')[1]);
  schemas.set(name, { name, version, definition, migrate });
  return name;
}

export function getSchema(name) { return schemas.get(name) || null; }
export function listSchemas() {
  return [...schemas.values()].map((s) => ({ name: s.name, version: s.version, hasMigrate: !!s.migrate }));
}

/** 校验 value 的基本形状（definition 里可声明 type/required） */
export function checkValue(name, value) {
  const s = getSchema(name);
  if (!s) throw makeError(E.E_VFS_SCHEMA, `schema 未注册: ${name}`, { name });
  const { type, required = [] } = s.definition;
  if (type === 'object' && (value === null || typeof value !== 'object' || Array.isArray(value))) {
    throw makeError(E.E_VFS_SCHEMA, `${name} 需要 object`, { name });
  }
  if (type === 'array' && !Array.isArray(value)) {
    throw makeError(E.E_VFS_SCHEMA, `${name} 需要 array`, { name });
  }
  if (type && type !== 'any' && type !== 'object' && type !== 'array' && typeof value !== type) {
    throw makeError(E.E_VFS_SCHEMA, `${name} 需要 ${type}`, { name });
  }
  if (Array.isArray(required)) {
    for (const k of required) {
      if (value == null || !(k in value)) throw makeError(E.E_VFS_SCHEMA, `${name} 缺少字段 ${k}`, { name });
    }
  }
  return true;
}

/**
 * 若 entry.meta.version 与 schema.version 不符，执行迁移。
 * 迁移失败抛 E_VFS_MIGRATE，由上层隔离 + 通知，绝不静默覆盖旧值。
 */
export async function migrateIfNeeded(entry) {
  const s = getSchema(entry.meta?.schema);
  if (!s) return entry;
  const from = Number(entry.meta.version ?? s.version);
  if (from === s.version) return entry;
  if (!s.migrate) {
    throw makeError(E.E_VFS_MIGRATE, `${s.name} 无迁移函数 (${from} → ${s.version})`, {
      schema: s.name, from, to: s.version, path: entry.path,
    });
  }
  let value = entry.value;
  try { value = await s.migrate(value, from, s.version); }
  catch (e) {
    throw makeError(E.E_VFS_MIGRATE, `迁移失败 ${s.name} (${from} → ${s.version}): ${e.message}`, {
      schema: s.name, from, to: s.version, path: entry.path,
    }, e);
  }
  return {
    ...entry,
    value,
    meta: { ...entry.meta, version: s.version, updatedAt: Date.now() },
  };
}

/** 内置 schema（第一阶段） */
export function registerBuiltinSchemas() {
  const defs = [
    ['theme-state@1', { type: 'object', required: ['id'] }],
    ['theme-bg@1', { type: 'object' }],
    ['engine-state@1', { type: 'object', required: ['engine'] }],
    ['engine-list@1', { type: 'array' }],
    ['apps-order@1', { type: 'array' }],
    ['music-state@1', { type: 'object' }],
    ['audio-meta@1', { type: 'object' }],
    ['module-state@1', { type: 'object' }],
    ['user-config@1', { type: 'object' }],
    ['manifest-mirror@1', { type: 'object' }],
    ['backup-envelope@1', { type: 'object', required: ['format', 'entries'] }],
    ['blob-wrapper@1', { type: 'object' }],
    ['any@1', { type: 'any' }],
  ];
  for (const [name, def] of defs) {
    if (!getSchema(name)) registerSchema(name, def);
  }
  return listSchemas();
}
