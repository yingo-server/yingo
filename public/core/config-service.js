/**
 * config-service.js — 用户配置服务
 * config:get / config:set 走 Storage Fabric（/shared/user-config.json），纯本地。
 * 公开站点配置来自 functions/config.mjs，只读，不落 VFS。
 */

import { on, emit } from './bus.js';
import { makeError, E } from './errors.js';

const PATH = '/shared/user-config.json';
let publicConfig = {};

export function initConfigService(config = {}) {
  publicConfig = config;
  on('config:get', async ({ key }) => {
    const user = (await emit('storage:get', { path: PATH, fallback: {} })) || {};
    if (key in user) return user[key];
    // 支持点路径，如 'search.defaultEngine'
    return key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), { ...publicConfig, ...user });
  });
  on('config:set', async ({ key, value }) => {
    const user = (await emit('storage:get', { path: PATH, fallback: {} })) || {};
    user[key] = value;
    await emit('storage:set', { path: PATH, value: user, schema: 'user-config@1' });
    return value;
  });
  return { public: publicConfig };
}

/** 同步版公开配置读取（供主题/搜索模块取引擎列表等） */
export function getPublicConfig() { return { ...publicConfig }; }

export function getPublicEngineList() {
  const list = publicConfig?.search?.engines;
  if (!Array.isArray(list)) throw makeError(E.E_CONFIG_FORBIDDEN, '公开配置缺少 search.engines');
  return list;
}
