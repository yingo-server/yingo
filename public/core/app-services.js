/**
 * app-services.js — 应用/音乐/主题/模块服务（总线命令 handler）
 * 第一阶段：清单从 /system/* 镜像读（函数只读供给），业务算法留空壳。
 * 所有状态写回 Storage Fabric，不直接碰原生 API。
 */

import { on, emit } from './bus.js';
import { listModules, setModuleState, getModule } from './module-api.js';
import { makeError, E } from './errors.js';

const DEFAULT_GROUPS = ['simulation', 'game', 'tool', 'media', 'ai', 'social', 'other'];

export function initAppServices(options = {}) {
  /* ---- 应用清单 ---- */
  on('apps:list', async ({ filter } = {}) => {
    const reg = (await emit('storage:get', { path: '/system/registry.json', fallback: null })) || options.registry || {};
    let apps = Array.isArray(reg.apps) ? reg.apps : [];
    const f = filter || {};
    if (f.group) apps = apps.filter((a) => a.group === f.group);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      apps = apps.filter((a) =>
        [a.name, a.id, a.description, ...(a.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    return { version: reg.version || 1, apps, groups: reg.groups || DEFAULT_GROUPS };
  });

  on('apps:reload', async () => {
    try {
      const res = await fetch('/registry.json', { cache: 'no-store' });
      if (res.ok) {
        const data = await res.json();
        await emit('storage:set', { path: '/system/registry.json', value: data, schema: 'manifest-mirror@1' });
        return data;
      }
    } catch { /* 保留旧镜像 */ }
    return emit('apps:list', {});
  });

  /* ---- 音乐清单 ---- */
  on('music:list', async () => {
    const m = (await emit('storage:get', { path: '/system/music.json', fallback: null })) || options.music || {};
    return { version: m.version || 1, tracks: Array.isArray(m.tracks) ? m.tracks : [] };
  });

  on('music:play', async ({ id } = {}) => {
    if (!id) throw makeError(E.E_NOT_FOUND, 'music:play 需要 id');
    const { tracks } = await emit('music:list', {});
    const track = tracks.find((t) => t.id === id);
    if (!track) throw makeError(E.E_NOT_FOUND, `音乐不存在: ${id}`, { id });
    await emit('music:state', { state: { id, playing: true } });
    return track;
  });

  on('music:state', async ({ state }) => {
    await emit('storage:set', {
      path: '/shared/music/state.json', value: state, schema: 'music-state@1',
    });
    return state;
  });

  /* ---- 主题 ---- */
  const themes = (options.themes?.length ? options.themes : ['material-3', 'neumorphism', 'lime-tabs']);
  on('theme:list', async () => ({ themes: themes.map((id) => ({ id })) }));

  on('theme:apply', async ({ id }) => {
    const themeId = themes.includes(id) ? id : (themes[0] || 'material-3');
    document.documentElement?.setAttribute?.('data-yingo-theme', themeId);
    await emit('storage:set', {
      path: '/shared/theme/current.json', value: { id: themeId }, schema: 'theme-state@1',
    }).catch(() => {});
    return themeId;
  });

  on('theme:bg-set', async ({ url, blur, tint }) => {
    const value = { url, blur: blur ?? 18, tint: tint ?? 'rgba(0,0,0,.25)', updatedAt: Date.now() };
    await emit('storage:set', {
      path: '/shared/theme/bg.json', value, schema: 'theme-bg@1',
    });
    document.documentElement?.style?.setProperty?.('--yingo-bg-image', `url("${url}")`);
    if (blur != null) document.documentElement?.style?.setProperty?.('--yingo-bg-blur', `${blur}px`);
    if (tint) document.documentElement?.style?.setProperty?.('--yingo-bg-tint', tint);
    return value;
  });

  /* ---- 模块 / 外挂 ---- */
  on('module:list', async () => listModules().map((m) => ({
    id: m.id, kind: m.kind, level: m.level, state: m.state,
    optional: m.optional, permissions: m.permissions, hooks: m.hooks,
  })));

  on('module:toggle', async ({ id, enabled }) => {
    const m = getModule(id);
    if (!m) throw makeError(E.E_NOT_FOUND, `模块不存在: ${id}`, { id });
    if (!m.optional && !enabled) throw makeError(E.E_PLUGIN_PERMISSION, `核心模块不可禁用: ${id}`);
    setModuleState(id, enabled ? 'ready' : 'disabled', { enabled });
    return { id, enabled };
  });

  on('module:diag', async ({ id } = {}) => {
    const all = listModules().map((m) => ({ id: m.id, state: m.state, level: m.level, error: m.error }));
    return id ? all.filter((m) => m.id === id) : all;
  });

  return { groups: DEFAULT_GROUPS };
}
