/**
 * dock — 底部应用坞（内置模块）
 * 渲染内容仓库 apps[type=dock]：毛玻璃胶囊 + 应用图标。
 * 点击：一律新标签打开（iframe srcdoc 在部分移动 WebView 白屏，弃用）。
 * init 不阻塞：先渲染骨架，清单异步到位后填充（CDN 慢时 UI 立即可见）。
 */

const MODULE_ID = 'dock';
const SLOT_NAMES = ['dock', 'bottombar', 'music'];

let ctxRef = null;
let rootNode = null;
let listNode = null;
const subscriptions = [];

function report(code, message, err) {
  try { ctxRef?.notify('error', message, { code, module: MODULE_ID, ...(err ? { message: err.message } : {}) }); }
  catch { /* noop */ }
}
async function bus(cmd, payload) {
  const r = ctxRef.bus.emit(cmd, payload);
  return r && typeof r.then === 'function' ? await r : r;
}
import { renderIcon } from '../../core/icons.js';

function makeEl(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}
function mountSelf(ctx, node) {
  for (const name of SLOT_NAMES) {
    try {
      if (ctx.mount(name, node) !== false) return;
      const sl = ctx.slot(name);
      if (!sl) continue;
      if (ctx.mount(sl, node) !== false) return;
      sl.appendChild(node);
      return;
    } catch { /* next */ }
  }
  try { ctx.mount(null, node); } catch { document.body.appendChild(node); }
}
function listen(ctx, cmd, fn) {
  const off = ctx.bus.on(cmd, fn);
  if (typeof off === 'function') subscriptions.push(off);
}

/* ---------------- 渲染 ---------------- */

async function loadApps() {
  const res = await bus('apps:list', { filter: { type: 'dock' } });
  return Array.isArray(res?.apps) ? res.apps : [];
}

function render(apps) {
  if (!listNode) return;
  listNode.replaceChildren();
  if (!apps.length) {
    const empty = makeEl('div', 'y-dock-empty', '在设置中添加内容仓库后，Dock 应用会出现在这里');
    listNode.append(empty);
    return;
  }
  for (const app of apps) {
    const btn = makeEl('button', 'y-dock-item');
    btn.type = 'button';
    btn.title = app.name || app.id;
    btn.dataset.appId = app.id || '';
    const iconSlot = makeEl('span', 'y-dock-icon');
    btn.append(iconSlot);
    void renderIcon(iconSlot, app.icon, { size: 22, title: app.name });
    btn.append(makeEl('span', 'y-dock-name', app.name || app.id));
    btn.addEventListener('click', () => openApp(app));
    listNode.append(btn);
  }
}

/**
 * 应用打开策略：一律新标签页。
 * 原因：iframe srcdoc 内嵌在部分移动端 WebView 白屏（兼容性差），
 * 新标签直开由浏览器自行处理，移动端桌面端行为一致且稳定。
 */
function openApp(app) {
  const url = app.url || app.entry;
  if (!url) { report('E_NOT_FOUND', `应用 ${app.id} 没有可用入口`); return; }
  const abs = new URL(url, location.href).href;
  window.open(abs, '_blank', 'noopener,noreferrer');
}

function buildUi(ctx) {
  rootNode = makeEl('section', 'y-module y-dock glass');
  rootNode.dataset.moduleId = MODULE_ID;
  const musicToggle = makeEl('button', 'y-dock-music-toggle', '♫');
  musicToggle.type = 'button';
  musicToggle.title = '音乐';
  musicToggle.addEventListener('click', async () => {
    try { await bus('music:toggle', {}); } catch (err) { report('E_MUSIC', '音乐播放器暂不可用', err); }
  });
  listNode = makeEl('div', 'y-dock-list');
  listNode.append(makeEl('div', 'y-dock-empty', '加载中…'));
  rootNode.append(musicToggle, listNode);
  mountSelf(ctx, rootNode);
  listen(ctx, 'apps:reload', () => { void refresh(); });
  listen(ctx, 'storage:invalidate', (p) => {
    if (p?.path?.startsWith('/cache/repos-manifest')) void refresh();
  });
}

async function refresh() {
  try {
    const apps = await loadApps();
    render(apps);
  } catch (err) {
    report('E_APPS', '应用清单拉取失败', err);
    render([]);
  }
}

export default {
  id: MODULE_ID,
  async init(ctx) {
    ctxRef = ctx;
    buildUi(ctx);
    // 先渲染骨架（"加载中…"），清单异步填充 —— init 立即返回，不阻塞启动
    void refresh();
  },
  destroy() {
    for (const off of subscriptions) { try { off(); } catch { /* noop */ } }
    subscriptions.length = 0;
    rootNode?.remove();
    rootNode = null; listNode = null; ctxRef = null;
  },
};
