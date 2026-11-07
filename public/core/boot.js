/**
 * boot.js — 浏览器入口（渐进加载版）
 *
 * 阶段 A（关键路径，最快可用）：
 *   进度条 → 配置/清单（带缓存）→ 仅加载 clock / search / apps-grid 三个模块 →
 *   调 kernel.boot() 用最小集合启动，首屏立即可交互。
 *
 * 阶段 B（后台懒加载）：
 *   system:ready 后，用 requestIdleCallback 分批加载 music-player / theme-manager /
 *   admin / 三套主题 / 布局 / 插件，逐项推进进度条并热注册到已运行的 Kernel。
 *
 * 缓存：配置与清单结果写入 yingo:preboot:v1（6h TTL），二次访问直接复用；
 *       同时对已知模块 URL 发 modulepreload 预热，减少瀑布。
 * 回退：网络失败 → 缓存 → 内嵌默认值；单个模块失败 → 占位模块 + 通知，不缺块。
 */

import { boot, mountDeferred } from './kernel.js';
import { E } from './errors.js';
import { reportError } from './bus.js';
import { createProgress, readCache, writeCache, preload, whenIdle, inBatches } from './progressive-loader.js';

/* ---- 关键路径：只这几个先加载 ---- */
const CRITICAL = [
  ['clock', '../modules/clock/index.js?v=2'],
  ['search', '../modules/search/index.js?v=2'],
  ['apps-grid', '../modules/apps-grid/index.js?v=2'],
];

/* ---- 后台懒加载 ---- */
const DEFERRED_MODULES = [
  ['music-player', '../modules/music-player/index.js?v=2'],
  ['theme-manager', '../modules/theme-manager/index.js?v=2'],
  ['admin', '../modules/admin/index.js?v=2'],
];
const THEME_ENTRIES = [
  ['material-3', '../themes/material-3/index.js?v=2'],
  ['neumorphism', '../themes/neumorphism/index.js?v=2'],
  ['lime-tabs', '../themes/lime-tabs/index.js?v=2'],
];
const LAYOUT_ENTRIES = [['default', '../layouts/default/index.js?v=2']];

const MODULE_DEFAULTS = {
  level: 6, permissions: ['storage:read:shared', 'storage:write:shared', 'config:read', 'apps:read', 'music:read'],
  hooks: [], optional: true,
};
const THEME_DEFAULTS = {
  level: 4, permissions: ['config:read', 'storage:read:shared'], hooks: ['after:storage'], optional: true,
};
const LAYOUT_DEFAULTS = { level: 8, permissions: [], hooks: [], optional: true };

const FALLBACK_CONFIG = {
  site: { title: 'Yingo', description: '个人主页 / 应用门户' },
  search: {
    engines: [
      { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={q}' },
      { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q={q}' },
      { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={q}' },
      { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={q}' },
    ],
    defaultEngine: 'duckduckgo',
  },
  themes: { default: 'material-3' },
  api: { base: '/api', cacheTtlSeconds: 300 },
};

/* ---- 样式：一次注入三个框架级 CSS ---- */
(function ensureStyles() {
  const list = [
    ['yingo-module-styles', '../styles/modules.css'],
    ['yingo-progress-styles', './progressive-loader.css'],
  ];
  for (const [id, rel] of list) {
    if (document.getElementById(id)) continue;
    const l = document.createElement('link');
    l.id = id; l.rel = 'stylesheet';
    l.href = new URL(rel, import.meta.url).href + '?v=2';
    (document.head || document.body).appendChild(l);
  }
})();

/* ---- 工具 ---- */

function manifestName(path) {
  return path.includes('/themes/') || path.includes('/layouts/') ? 'theme.json' : 'module.json';
}

/** 带缓存的清单读取 */
async function readManifest(url, cacheKey, fallback) {
  const cached = readCache();
  if (cached?.[cacheKey]) return cached[cacheKey];
  try {
    const res = await fetch(url, { cache: 'default' });
    if (res.ok) return await res.json();
  } catch { /* 走缓存/兜底 */ }
  return cached?.[cacheKey] || fallback;
}

/** 加载单个模块；失败返回占位，绝不缺块 */
async function loadEntry(id, path, defaults, progress, useCache = true) {
  try {
    const mod = await import(path);
    const factory = mod.default || mod;
    let fileManifest = {};
    if (useCache) {
      const c = readCache();
      if (c?.manifests?.[id]) fileManifest = c.manifests[id];
    }
    if (!Object.keys(fileManifest).length) {
      try {
        const cleanPath = path.split('?')[0];
      const metaUrl = new URL(cleanPath.replace(/index\.js$/, '') + manifestName(cleanPath), import.meta.url);
        const res = await fetch(metaUrl, { cache: 'default' });
        if (res.ok) fileManifest = await res.json();
      } catch { /* 无元数据合法 */ }
    }
    const manifest = { ...defaults, ...fileManifest, ...(mod.manifest || {}), id, layout: 'self-decided' };
    progress?.(`${id} ✓`);
    return { id, manifest, factory };
  } catch (err) {
    progress?.(`${id} 降级`);
    await reportError(E.E_MODULE_INIT, `加载 ${id} 失败，已用占位模块`, { module: id, path });
    // 占位模块：保证 UI 结构完整、可见提示，而不是静默缺一块
    const factory = {
      id,
      async init(ctx) {
        const n = document.createElement('section');
        n.className = 'y-module y-module-fallback glass';
        n.dataset.moduleId = id;
        n.textContent = `模块 ${id} 暂不可用（点击重试）`;
        n.addEventListener('click', async () => {
          const r = await loadEntry(id, path, defaults, null, false);
          if (r && r.factory.init !== factory.init) { n.remove(); await mountDeferred(r, 'module'); }
        });
        ctx.mount('root', n);
      },
      destroy() { document.querySelector(`[data-module-id="${id}"].y-module-fallback`)?.remove(); },
    };
    return { id, manifest: { ...defaults, id, layout: 'self-decided' }, factory, degraded: true };
  }
}

/** 收集插件清单（带缓存） */
async function collectPlugins(reg) {
  return (reg?.plugins || []).filter((p) => p && p.entry && p.id && p.enabled !== false)
    .map((p) => ({ id: p.id, entry: p.entry, manifest: p }));
}

/** 预引导：配置 + 两个清单，尽量走缓存 */
async function preloadData(progress) {
  const cached = readCache();
  if (cached?.config && cached?.registry && cached?.music) {
    progress(18, '从本地缓存恢复', 'cache hit');
    return { config: cached.config, registry: cached.registry, music: cached.music, fromCache: true };
  }
  progress(6, '正在读取配置…');
  const [configRes, regRes, musicRes] = await Promise.allSettled([
    fetch('/api/config', { cache: 'default' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('config ' + r.status)))),
    fetch('/registry.json', { cache: 'default' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('registry ' + r.status)))),
    fetch('/music.json', { cache: 'default' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('music ' + r.status)))),
  ]);
  const config = configRes.status === 'fulfilled' && Object.keys(configRes.value || {}).length
    ? configRes.value : { ...FALLBACK_CONFIG };
  const registry = regRes.status === 'fulfilled' ? regRes.value : { version: 1, apps: [], plugins: [], themes: [], groups: [] };
  const music = musicRes.status === 'fulfilled' ? musicRes.value : { version: 1, tracks: [] };
  progress(18, '配置就绪', `${Object.keys(config).length} 项 / ${registry.apps?.length || 0} 应用 / ${music.tracks?.length || 0} 曲目`);
  writeCache({ config, registry, music });
  return { config, registry, music, fromCache: false };
}

/* ================= 主流程 ================= */

const progress = createProgress();

(async () => {
  let stageAReport = null;
  try {
    const t0 = performance.now();

    /* ---------- 阶段 A：关键路径 ---------- */
    progress.update(2, '启动…');
    const { config, registry, music, fromCache } = await preloadData((pct, label, detail) => progress.update(pct, label, detail));

    // 预热：让浏览器并行取回后续模块，减少阶段 B 的瀑布
    preload([...DEFERRED_MODULES, ...THEME_ENTRIES, ...LAYOUT_ENTRIES].map(([, p]) => new URL(p, import.meta.url).href));

    progress.update(24, '加载核心界面…');
    const critical = (await Promise.all(CRITICAL.map(([id, p]) =>
      loadEntry(id, p, MODULE_DEFAULTS, (d) => progress.update(undefined, undefined, d))
    ))).filter(Boolean);
    progress.update(52, '核心界面就绪');

    document.title = config?.site?.title || 'Yingo';
    stageAReport = await boot({
      config,
      modules: critical,
      themes: [],            // 阶段 B 加载
      layouts: [],           // 阶段 B 加载
      plugins: [],           // 阶段 B 加载
      registry, music,
      progressive: true,     // 告诉 Kernel：先启动关键路径，userland 不清理、不结束进度
    });
    progress.update(62, '界面可用', `阶段 ${stageAReport.stages.filter((s) => s.status === 'ok').length}/9 · ${Math.round(performance.now() - t0)}ms`);
    if (!stageAReport.ready) progress.fail('部分核心功能降级');

    /* ---------- 阶段 B：后台懒加载 ---------- */
    whenIdle(async () => {
      try {
        const tasks = [
          ...DEFERRED_MODULES.map(([id, p]) => ({ kind: 'module', id, path: p, defaults: MODULE_DEFAULTS })),
          ...THEME_ENTRIES.map(([id, p]) => ({ kind: 'theme', id, path: p, defaults: THEME_DEFAULTS })),
          ...LAYOUT_ENTRIES.map(([id, p]) => ({ kind: 'layout', id, path: p, defaults: LAYOUT_DEFAULTS })),
        ];
        let n = 0;
        const total = tasks.length + (registry?.plugins?.length || 0) + 1;
        await inBatches(tasks, 2, async (t) => {
          const entry = await loadEntry(t.id, t.path, t.defaults, (d) => progress.update(undefined, undefined, d));
          n += 1;
          progress.update(62 + (n / total) * 34, `加载扩展 ${n}/${total}`);
          if (entry) await mountDeferred(entry, t.kind);
          return entry;
        });
        // 插件
        const plugins = await collectPlugins(registry);
        for (const p of plugins) {
          try {
            const mod = await import(p.entry);
            await mountDeferred({ id: p.id, manifest: { ...(p.manifest || {}), id: p.id, layout: 'self-decided', kind: 'plugin' }, factory: mod.default || mod }, 'plugin');
          } catch (err) { await reportError(E.E_PLUGIN_LOAD, `插件 ${p.id} 加载失败`, { module: p.id }); }
          n += 1;
          progress.update(62 + (n / total) * 34, `加载扩展 ${n}/${total}`);
        }
        // 缓存模块清单元数据，二次访问不再 fetch module.json
        const manifests = {};
        for (const [id, p] of [...CRITICAL, ...DEFERRED_MODULES, ...THEME_ENTRIES, ...LAYOUT_ENTRIES]) {
          try {
            const cp = p.split('?')[0];
            const r = await fetch(new URL(cp.replace(/index\.js$/, '') + manifestName(cp), import.meta.url), { cache: 'default' });
            if (r.ok) manifests[id] = await r.json();
          } catch { /* noop */ }
        }
        writeCache({ config, registry, music, manifests });
        progress.update(98, '全部就绪', `总耗时 ${Math.round(performance.now() - t0)}ms`);
        progress.done();
      } catch (err) {
        await reportError(E.E_INTERNAL, '后台加载出错', { detail: String(err?.message || err) });
        progress.fail('后台加载未完成，可继续使用核心功能');
      }
    }, 600);

  } catch (err) {
    console.error('[yingo] 启动失败', err);
    progress.fail(err?.message || String(err));
    const root = document.getElementById('yingo-root') || document.body;
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:2rem;font:14px/1.6 system-ui,sans-serif;z-index:10001;background:#fffbfe;color:#1b1b1f';
    box.innerHTML = `<div><h1>Yingo 启动失败</h1><pre style="white-space:pre-wrap">${escapeHtml(err?.message || String(err))}</pre>
      <p>可打开 <code>?diag</code> 查看诊断中心，或刷新重试。</p>
      <button onclick="localStorage.removeItem('yingo:preboot:v1');location.reload()" style="padding:8px 16px;cursor:pointer">清缓存并重试</button></div>`;
    root.appendChild(box);
  }
})();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
