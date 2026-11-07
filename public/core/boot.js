/**
 * boot.js — 浏览器入口（唯一被 index.html 加载的模块）
 * 职责：读公开配置 → 静态收集内置模块/主题/布局 → 动态收集插件清单 → 调 kernel.boot()
 * 零构建：全部原生 ESM 静态 import，浏览器直接加载源码。
 */

import { boot } from './kernel.js';
import { E } from './errors.js';
import { reportError } from './bus.js';

/* ---- 静态内置模块（子任务产出；缺失时安全降级为空） ---- */
const MODULE_ENTRIES = [
  ['clock', '../modules/clock/index.js'],
  ['search', '../modules/search/index.js'],
  ['apps-grid', '../modules/apps-grid/index.js'],
  ['music-player', '../modules/music-player/index.js'],
  ['theme-manager', '../modules/theme-manager/index.js'],
  ['admin', '../modules/admin/index.js'],
];

const THEME_ENTRIES = [
  ['material-3', '../themes/material-3/index.js'],
  ['neumorphism', '../themes/neumorphism/index.js'],
  ['lime-tabs', '../themes/lime-tabs/index.js'],
];

const LAYOUT_ENTRIES = [
  ['default', '../layouts/default/index.js'],
];

async function loadEntry(id, path, defaults) {
  try {
    const mod = await import(path);
    const factory = mod.default || mod;
    // 同目录 module.json / theme.json 是清单事实来源；读取失败则用默认值兜底
    let fileManifest = {};
    try {
      const metaUrl = new URL(path.replace(/index\.js$/, '') + manifestName(path), import.meta.url);
      const res = await fetch(metaUrl, { cache: 'no-store' });
      if (res.ok) fileManifest = await res.json();
    } catch { /* 静态服务器无该文件时合法 */ }
    const manifest = { ...defaults, ...fileManifest, ...(mod.manifest || {}), id };
    // 强制 ADR-005：模块自决布局
    manifest.layout = 'self-decided';
    return { id, manifest, factory };
  } catch (err) {
    await reportError(E.E_MODULE_INIT, `加载 ${id} 失败: ${err.message}`, { module: id, path });
    return null;
  }
}

function manifestName(path) {
  return path.includes('/themes/') ? 'theme.json' : path.includes('/layouts/') ? 'theme.json' : 'module.json';
}

async function collect() {
  const modules = (await Promise.all(MODULE_ENTRIES.map(([id, p]) =>
    loadEntry(id, p, { level: 6, permissions: ['storage:read:shared', 'storage:write:shared', 'config:read', 'apps:read', 'music:read'], hooks: [], optional: true })
  ))).filter(Boolean);

  const themes = (await Promise.all(THEME_ENTRIES.map(([id, p]) =>
    loadEntry(id, p, { level: 4, permissions: ['config:read', 'storage:read:shared'], hooks: ['after:storage'], optional: true })
  ))).filter(Boolean);

  const layouts = (await Promise.all(LAYOUT_ENTRIES.map(([id, p]) =>
    loadEntry(id, p, { level: 8, permissions: [], hooks: [], optional: true })
  ))).filter(Boolean);

  // 插件：由构建产物 registry.json 声明，运行时动态 import
  let plugins = [];
  try {
    const res = await fetch('/registry.json', { cache: 'no-store' });
    if (res.ok) {
      const reg = await res.json();
      plugins = (reg.plugins || []).filter((p) => p && p.entry && p.id && p.enabled !== false)
        .map((p) => ({ id: p.id, entry: p.entry, manifest: p }));
    }
  } catch { /* 无清单 = 无插件，合法 */ }

  // 公开配置：优先函数侧（同源 /api/config），回退到本地 config 镜像
  let config = {};
  try {
    const res = await fetch('/api/config', { cache: 'no-store' });
    if (res.ok) config = await res.json();
  } catch { /* 本地静态服务器无函数，走内嵌默认值 */ }
  if (!config || !Object.keys(config).length) {
    config = {
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
  }

  return { modules, themes, layouts, plugins, config };
}

(async () => {
  try {
    const options = await collect();
    document.title = options.config?.site?.title || 'Yingo';
    const report = await boot(options);
    if (!report.ready) console.warn('[yingo] 启动以降级状态完成', report.degraded);
  } catch (err) {
    // bootloader/core 致命失败：显示静态降级页，不留白屏
    console.error('[yingo] 启动失败', err);
    const root = document.getElementById('yingo-root') || document.body;
    root.innerHTML = `<div style="padding:2rem;font:14px/1.6 system-ui,sans-serif">
      <h1>Yingo 启动失败</h1>
      <pre style="white-space:pre-wrap">${escapeHtml(err?.message || String(err))}</pre>
      <p>可打开 <code>?diag</code> 查看诊断中心，或检查控制台。</p></div>`;
  }
})();

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
