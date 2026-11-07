/**
 * bus-schema.js — 强类型命令契约（运行时校验，无需编译）
 * 「强类型」= 每个命令都有 schema、权限与中间件链；未注册的命令一律拒绝。
 */

import { makeError, E } from './errors.js';

const registry = new Map();          // command -> definition
const typeCheckers = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  any: () => true,
};

/**
 * 注册命令契约
 * @param {string} name 形如 'storage:get'
 * @param {{payload:Object<string,string>, permission?:string, description?:string}} def
 *   payload 的值是类型名，末尾 '?' 表示可选，例如 { path:'string', ttl:'number?' }
 */
export function defineCommand(name, def) {
  if (!/^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/.test(name)) {
    throw makeError(E.E_SCHEMA, `命令名不合法: ${name}`);
  }
  if (registry.has(name)) {
    throw makeError(E.E_SCHEMA, `命令重复注册: ${name}`);
  }
  const fields = Object.entries(def.payload || {}).map(([key, raw]) => {
    const optional = String(raw).endsWith('?');
    const type = String(raw).replace(/\?$/, '');
    if (!typeCheckers[type]) throw makeError(E.E_SCHEMA, `未知类型 ${type} (${name}.${key})`);
    return { key, type, optional, check: typeCheckers[type] };
  });
  registry.set(name, {
    name,
    fields,
    permission: def.permission || null,
    description: def.description || '',
  });
  return name;
}

export function getCommand(name) {
  return registry.get(name) || null;
}

export function listCommands() {
  return [...registry.values()].map((d) => ({
    name: d.name,
    permission: d.permission,
    fields: d.fields.map((f) => `${f.key}:${f.type}${f.optional ? '?' : ''}`),
    description: d.description,
  }));
}

/** 校验 payload；失败抛 E_SCHEMA（含具体字段） */
export function validate(name, payload = {}) {
  const def = registry.get(name);
  if (!def) throw makeError(E.E_SCHEMA, `未注册命令: ${name}`, { command: name });
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw makeError(E.E_SCHEMA, `payload 必须是对象: ${name}`);
  }
  const problems = [];
  for (const f of def.fields) {
    const v = payload[f.key];
    if (v === undefined) {
      if (!f.optional) problems.push(`缺少 ${f.key}`);
    } else if (!f.check(v)) {
      problems.push(`${f.key} 应为 ${f.type}，实际 ${Array.isArray(v) ? 'array' : typeof v}`);
    }
  }
  // 额外字段不禁止（便于扩展），但记录到诊断
  if (problems.length) {
    throw makeError(E.E_SCHEMA, `命令 ${name} 校验失败: ${problems.join(', ')}`, {
      command: name, problems, payloadKeys: Object.keys(payload),
    });
  }
  return payload;
}

/* ---------------- 内置命令契约 ---------------- */

const SCHEMAS = {
  'system:boot': { payload: { options: 'object?' }, description: '启动开始' },
  'system:ready': { payload: { timeline: 'array' }, description: '启动完成' },
  'system:error': { payload: { code: 'string', stage: 'string?', module: 'string?', detail: 'object?' }, description: '统一异常入口' },

  'config:get': { payload: { key: 'string' }, description: '读公开配置' },
  'config:set': { payload: { key: 'string', value: 'any' }, permission: 'config:write', description: '写用户配置（本地 VFS）' },


  'apps:list': { payload: { filter: 'object?' }, description: '应用清单（内容仓库合并）' },
  'apps:reload': { payload: {}, description: '重载清单' },
  'widgets:list': { payload: {}, description: '中部组件清单' },
  'repos:list': { payload: {}, description: '内容仓库列表' },
  'repos:set': { payload: { repos: 'array' }, description: '设置内容仓库' },
  'wallpaper:get': { payload: {}, description: '读取壁纸配置' },
  'wallpaper:set': { payload: { mode: 'string', id: 'string?', url: 'string?', blur: 'number?', tint: 'string?' }, description: '设置壁纸' },
  'wallpaper:changed': { payload: { mode: 'string', id: 'string?', url: 'string?', blur: 'number?', tint: 'string?' }, description: '壁纸变更广播' },

  'search:submit': { payload: { engine: 'string', query: 'string' }, description: '跳转外部引擎' },
  'search:filter': { payload: { query: 'string' }, description: '本地应用/音乐过滤' },

  'music:list': { payload: {}, description: '音乐清单' },
  'music:play': { payload: { id: 'string?', index: 'number?' }, description: '播放指定曲目' },
  'music:next': { payload: {}, description: '下一首' },
  'music:prev': { payload: {}, description: '上一首' },
  'music:toggle': { payload: {}, description: '播放/暂停' },
  'music:state': { payload: { state: 'object' }, description: '播放状态' },

  'module:list': { payload: {}, description: '模块清单' },
  'module:toggle': { payload: { id: 'string', enabled: 'boolean' }, permission: 'module:write', description: '外挂启停' },
  'module:diag': { payload: { id: 'string?' }, description: '模块诊断' },

  'notify:push': { payload: { level: 'string', message: 'string', detail: 'object?' }, description: '通知中心' },

  'storage:get': { payload: { path: 'string', fallback: 'any?' }, description: '读 VFS' },
  'storage:set': { payload: { path: 'string', value: 'any', schema: 'string', ttl: 'number?' }, description: '写 VFS' },
  'storage:del': { payload: { path: 'string' }, description: '删除' },
  'storage:list': { payload: { prefix: 'string', recursive: 'boolean?' }, description: '目录列举' },
  'storage:stat': { payload: { path: 'string' }, description: '读元数据' },
  'storage:clear': { payload: { prefix: 'string', scope: 'string?' }, description: '递归清理' },
  'storage:exists': { payload: { path: 'string' }, description: '存在性' },
  'storage:watch': { payload: { prefix: 'string', handlerId: 'string' }, description: '变更订阅' },
  'storage:unwatch': { payload: { prefix: 'string', handlerId: 'string' }, description: '取消订阅' },
  'storage:migrate': { payload: { path: 'string', toVersion: 'number' }, description: '手动迁移' },
  'storage:usage': { payload: { prefix: 'string?' }, description: '占用观测' },
  'storage:gc': { payload: { scope: 'string?' }, description: '手动 GC' },
  'storage:invalidate': { payload: { prefix: 'string', reason: 'string' }, description: '失效广播' },
  'storage:export': { payload: { prefixes: 'array' }, description: '导出备份' },
  'storage:import': { payload: { payload: 'object', dryRun: 'boolean?' }, description: '导入备份/冲突预览' },
};

/** 由 kernel 在 core 阶段调用一次 */
export function registerBuiltinCommands() {
  for (const [name, def] of Object.entries(SCHEMAS)) {
    if (!registry.has(name)) defineCommand(name, def);
  }
  return listCommands();
}
