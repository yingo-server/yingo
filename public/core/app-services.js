/**
 * app-services.js — 应用/音乐/组件/壁纸/模块服务（总线命令 handler）
 * 应用与音乐来自内容仓库（yingotab.yml）合并；壁纸即主题；组件（天气等）为内置模块。
 */

import { on, emit } from './bus.js';
import { listModules, setModuleState, getModule } from './module-api.js';
import { makeError, E } from './errors.js';
import { loadRepos, getUserRepos, DEFAULT_REPOS } from './yingotab.js';

const GROUPS = ['dock', 'grid'];

/** 应用/音乐合并清单（loadRepos 结果缓存在内存，避免每次命令都拉网络） */
let manifestCache = null;

async function getManifest(force = false, networkForce = false) {
  if (!force && manifestCache) return manifestCache;
  const repos = await getUserRepos();
  const { merged, errors, fromCache } = await loadRepos(repos, networkForce);
  manifestCache = merged;
  if (errors?.length) {
    emit('notify:push', {
      level: 'warn',
      message: `部分内容仓库拉取失败（${errors.length} 个）`,
      detail: { errors, fromCache },
    }).catch(() => {});
  }
  return merged;
}

export function initAppServices(options = {}) {
  /* ---- 应用清单（来自内容仓库合并） ---- */
  on('apps:list', async ({ filter } = {}) => {
    const m = await getManifest();
    let apps = Array.isArray(m.apps) ? m.apps : [];
    const f = filter || {};
    if (f.type) apps = apps.filter((a) => (a.type || 'dock') === f.type);
    if (f.q) {
      const q = String(f.q).toLowerCase();
      apps = apps.filter((a) => [a.name, a.id, a.description, ...(a.tags || [])]
        .filter(Boolean).join(' ').toLowerCase().includes(q));
    }
    return { version: m.version || 1, apps, groups: GROUPS };
  });

  on('apps:reload', async () => {
    manifestCache = null;
    return getManifest(true, true);
  });

  /* ---- 音乐清单（来自内容仓库合并） ---- */
  on('music:list', async () => {
    const m = await getManifest();
    const tracks = (Array.isArray(m.music) ? m.music : []).map((t) => ({
      ...t,
      file: t.url || t.file,     // 播放器读 file 字段
    }));
    return { version: m.version || 1, tracks };
  });

  on('music:play', async ({ id, index } = {}) => {
    if (!id && typeof index !== 'number') throw makeError(E.E_NOT_FOUND, 'music:play 需要 id 或 index');
    const { tracks } = await emit('music:list', {});
    const track = typeof index === 'number' ? tracks[index] : tracks.find((t) => t.id === id);
    if (!track) throw makeError(E.E_NOT_FOUND, `音乐不存在: ${id ?? index}`, { id, index });
    return track;
  });

  on('music:state', async ({ state }) => {
    await emit('storage:set', { path: '/shared/music/state.json', value: state, schema: 'music-state@1' });
    return state;
  });

  /* ---- 中部组件（天气/便签等，来自合并清单 widgets 或内置注册） ---- */
  on('widgets:list', async () => {
    const m = await getManifest();
    return { widgets: Array.isArray(m.widgets) ? m.widgets : [] };
  });

  /* ---- 内容仓库管理（设置界面用） ---- */
  on('repos:list', async () => {
    const repos = await getUserRepos();
    return { repos, defaults: DEFAULT_REPOS };
  });

  on('repos:set', async ({ repos }) => {
    if (!Array.isArray(repos)) throw makeError(E.E_SCHEMA, 'repos 必须是数组');
    for (const r of repos) {
      if (!r?.url) throw makeError(E.E_SCHEMA, '每个仓库条目需要 url');
      if (!['jsdelivr', 'ghproxy', 'pages'].includes(r.mode)) {
        throw makeError(E.E_SCHEMA, `未知模式 ${r.mode}（可选 jsdelivr/ghproxy/pages）`);
      }
    }
    await emit('storage:set', { path: '/shared/repos.json', value: { repos }, schema: 'user-config@1' });
    manifestCache = null;    // 立即失效，下次 apps:list 重新拉取
    return getManifest(true, true);
  });

  /* ---- 壁纸即主题 ---- */
  on('wallpaper:get', async () => {
    const saved = await emit('storage:get', { path: '/shared/wallpaper.json', fallback: null });
    return saved || { mode: 'builtin', id: 'aurora', blur: 0, tint: 'transparent' };
  });

  on('wallpaper:set', async ({ mode, id, url, blur, tint }) => {
    if (!['builtin', 'custom', 'dynamic'].includes(mode)) {
      throw makeError(E.E_SCHEMA, `未知壁纸模式 ${mode}（builtin/custom/dynamic）`);
    }
    const value = { mode, id, url, blur: blur ?? 0, tint: tint ?? 'transparent', updatedAt: Date.now() };
    await emit('storage:set', { path: '/shared/wallpaper.json', value, schema: 'user-config@1' });
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

  return { groups: GROUPS };
}
