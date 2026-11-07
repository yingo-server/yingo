/**
 * boot.js — 浏览器入口（YingoTab · 清风版）
 *
 * 阶段 A（关键路径，最快可用）：
 *   进度条 → 配置/内容仓库清单（带缓存）→ 仅加载 clock / search / wallpaper →
 *   启动内核，首屏立即可交互。
 *
 * 阶段 B（后台懒加载）：
 *   music-player / weather / dock / settings，逐项推进进度条并热注册。
 *
 * 回退：网络失败 → 缓存 → 内嵌默认值；单个模块失败 → 可点击重试的占位模块。
 */

import { boot, mountDeferred } from './kernel.js';
import { E } from './errors.js';
import { reportError } from './bus.js';
import { createProgress, readCache, writeCache, preload, whenIdle, inBatches } from './progressive-loader.js';

/* ---- 关键路径：首屏三件套 ---- */
const CRITICAL = [
  ['wallpaper', '../modules/wallpaper/index.js'],
  ['clock', '../modules/clock/index.js'],
  ['search', '../modules/search/index.js'],
];

/* ---- 后台懒加载 ---- */
const DEFERRED_MODULES = [
  ['dock', '../modules/dock/index.js'],
  ['music-player', '../modules/music-player/index.js'],
  ['weather', '../modules/weather/index.js'],
  ['settings', '../modules/settings/index.js'],
];

const MODULE_DEFAULTS = {
  level: 6,
  permissions: ['storage:read:shared', 'storage:write:shared', 'config:read', 'apps:read', 'music:read'],
  hooks: [], optional: true,
};

const FALLBACK_CONFIG = {
  site: { title: 'YingoTab', description: '极简起始页框架' },
  search: {
    engines: [
      { id: 'bing', name: '必应', url: 'https://www.bing.com/search?q={q}' },
      { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={q}' },
      { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={q}' },
      { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={q}' },
    ],
    defaultEngine: 'bing',
  },
  api: { base: '/api' },
};

/* ---- 进度条样式必须最先注入 ---- */
(function ensureStyles() {
  const l = document.createElement('link');
  l.id = 'yingo-progress-styles';
  l.rel = 'stylesheet';
  l.href = new URL('./progressive-loader.css?v=5', import.meta.url).href;
  (document.head || document.body).appendChild(l);
})();

function manifestName(path) {
  return path.includes('/themes/') || path.includes('/layouts/') ? 'theme.json' : 'module.json';
}

async function readManifest(url, cacheKey, fallback) {
  const cached = readCache();
  if (cached?.[cacheKey]) return cached[cacheKey];
  try {
    const res = await fetch(url, { cache: 'default' });
    if (res.ok) return await res.json();
  } catch { /* 走缓存/兜底 */ }
  return fallback;
}

/** 加载单个模块；失败返回占位，绝不缺块 */
async function loadEntry(id, path, defaults, progress) {
  try {
    const mod = await import(path);
    const factory = mod.default || mod;
    let fileManifest = readCache()?.manifests?.[id] || {};
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
    const factory = {
      id,
      async init(ctx) {
        const n = document.createElement('section');
        n.className = 'y-module y-module-fallback glass';
        n.dataset.moduleId = id;
        n.textContent = `模块 ${id} 暂不可用（点击重试）`;
        n.addEventListener('click', async () => {
          const r = await loadEntry(id, path, defaults, null);
          if (r && r.factory.init !== factory.init) { n.remove(); await mountDeferred(r, 'module'); }
        });
        ctx.mount('root', n);
      },
      destroy() { document.querySelector(`[data-module-id="${id}"].y-module-fallback`)?.remove(); },
    };
    return { id, manifest: { ...defaults, id, layout: 'self-decided' }, factory, degraded: true };
  }
}

/** 预引导：配置 + 内容仓库清单，尽量走缓存 */
async function preloadData(progress) {
  const cached = readCache();
  if (cached?.config && cached?.reposManifest) {
    progress(18, '从本地缓存恢复', 'cache hit');
    return { config: cached.config, reposManifest: cached.reposManifest, fromCache: true };
  }
  progress(6, '正在读取配置…');
  const [configRes] = await Promise.allSettled([
    fetch('/api/config', { cache: 'default' }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('config ' + r.status)))),
  ]);
  const config = configRes.status === 'fulfilled' && Object.keys(configRes.value || {}).length
    ? configRes.value : { ...FALLBACK_CONFIG };
  // 内容仓库清单走 yingotab 引擎（带自身缓存），此处不阻塞首屏
  progress(18, '配置就绪');
  return { config, reposManifest: null, fromCache: false };
}

/* ================= 主流程 ================= */

const progress = createProgress();

(async () => {
  try {
    const t0 = performance.now();

    /* ---------- 阶段 A：关键路径 ---------- */
    progress.update(2, '启动…');
    const { config } = await preloadData((pct, label, detail) => progress.update(pct, label, detail));
    preload(DEFERRED_MODULES.map(([, p]) => new URL(p, import.meta.url).href));

    progress.update(24, '加载核心界面…');
    const critical = (await Promise.all(CRITICAL.map(([id, p]) =>
      loadEntry(id, p, MODULE_DEFAULTS, (d) => progress.update(undefined, undefined, d))
    ))).filter(Boolean);
    progress.update(52, '核心界面就绪');

    document.title = config?.site?.title || 'YingoTab';
    const stageAReport = await boot({ config, modules: critical, progressive: true });
    progress.update(62, '界面可用', `${Math.round(performance.now() - t0)}ms`);
    if (!stageAReport.ready) progress.fail('部分核心功能降级');

    /* ---------- 阶段 B：后台懒加载 ---------- */
    whenIdle(async () => {
      try {
        let n = 0;
        const total = DEFERRED_MODULES.length + 1;
        await inBatches(DEFERRED_MODULES.map(([id, p]) => ({ id, path: p })), 2, async (t) => {
          const entry = await loadEntry(t.id, t.path, MODULE_DEFAULTS, (d) => progress.update(undefined, undefined, d));
          n += 1;
          progress.update(62 + (n / total) * 34, `加载模块 ${n}/${total}`);
          if (entry) await mountDeferred(entry, 'module');
          return entry;
        });
        // 缓存模块清单元数据
        const manifests = {};
        for (const [id, p] of [...CRITICAL, ...DEFERRED_MODULES]) {
          try {
            const cp = p.split('?')[0];
            const r = await fetch(new URL(cp.replace(/index\.js$/, '') + manifestName(cp), import.meta.url), { cache: 'default' });
            if (r.ok) manifests[id] = await r.json();
          } catch { /* noop */ }
        }
        writeCache({ config, manifests });
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
    box.style.cssText = 'position:fixed;inset:0;display:grid;place-items:center;padding:2rem;font:14px/1.6 system-ui,sans-serif;z-index:10001;background:#101418;color:#eee';
    box.innerHTML = `<div><h1>YingoTab 启动失败</h1><pre style="white-space:pre-wrap">${escapeHtml(err?.message || String(err))}</pre>
      <p>可打开诊断面板查看详情，或刷新重试。</p>
      <button onclick="localStorage.removeItem('yingo:preboot:v1');location.reload()" style="padding:8px 16px;cursor:pointer">清缓存并重试</button></div>`;
    root.appendChild(box);
  }
})();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
