/**
 * dock — 底部应用坞（内置模块）
 * 渲染内容仓库 apps[type=dock]：毛玻璃胶囊 + 应用图标网格。
 * 点击行为：iframe 弹窗（应用内嵌）为主，fallback 新标签。
 * 应用来自 yingotab 合并清单（apps:list?filter.type=dock），缓存 30min。
 */

const MODULE_ID = 'dock';
const SLOT_NAMES = ['dock', 'bottombar', 'music'];
const FALLBACK_ICON = '🧩';

let ctxRef = null;
let rootNode = null;
let listNode = null;
let popupEl = null;
const subscriptions = [];

function report(code, message, err) {
  try { ctxRef?.notify('error', message, { code, module: MODULE_ID, ...(err ? { message: err.message } : {}) }); }
  catch { /* noop */ }
}
async function bus(cmd, payload) {
  const r = ctxRef.bus.emit(cmd, payload);
  return r && typeof r.then === 'function' ? await r : r;
}
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
    btn.append(makeEl('span', 'y-dock-icon', app.icon || FALLBACK_ICON));
    btn.append(makeEl('span', 'y-dock-name', app.name || app.id));
    btn.addEventListener('click', () => openApp(app));
    listNode.append(btn);
  }
}

function openApp(app) {
  const url = app.url || app.entry;
  if (!url) { report('E_NOT_FOUND', `应用 ${app.id} 没有可用入口`); return; }
  showPopup(app, url);
}

/**
 * 加载应用 HTML。
 * jsDeliv/raw 以 text/plain 下发 HTML，直接 iframe 会显示纯文本。
 * 方案：fetch → 注入 <base> → iframe.srcdoc（srcdoc 继承父文档上下文，sandbox 正常生效，
 * 相对资源由 <base> 解析到仓库 CDN）。pages 模式 MIME 正确，直接 src=url。
 */
async function loadIntoFrame(frame, app, url) {
  if (app.mode === 'pages' || /^https?:\/\/[^/]*github\.io/.test(url) || /^https?:\/\/.*netlify\.app/.test(url)) {
    frame.removeAttribute('srcdoc');
    frame.src = url;
    return;
  }
  try {
    const res = await fetch(url, { cache: 'default' });
    if (!res.ok) throw new Error(`${res.status}`);
    const html = await res.text();
    const base = url.replace(/[^/]*$/, '');
    const patched = /<head[^>]*>/i.test(html)
      ? html.replace(/<head[^>]*>/i, (m) => m + `\n<base href="${base}">`)
      : `<base href="${base}">` + html;
    frame.removeAttribute('src');
    frame.srcdoc = patched;
  } catch (err) {
    report('E_APPS', `应用 ${app.id} 加载失败，改用直连`, err);
    frame.removeAttribute('srcdoc');
    frame.src = url;
  }
}

/* ---------------- 弹窗 ---------------- */

function ensurePopup() {
  if (popupEl) return popupEl;
  const wrap = makeEl('div', 'y-dock-popup');
  wrap.hidden = true;
  const card = makeEl('div', 'y-dock-popup-card glass');
  const head = makeEl('div', 'y-dock-popup-head');
  const title = makeEl('span', 'y-dock-popup-title', '');
  const actions = makeEl('div', 'y-dock-popup-actions');
  const openExt = makeEl('button', 'y-dock-popup-btn', '↗ 新标签');
  openExt.type = 'button';
  openExt.addEventListener('click', () => {
    const url = popupEl?.dataset?.url;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
  });
  const closeBtn = makeEl('button', 'y-dock-popup-btn', '✕');
  closeBtn.type = 'button';
  closeBtn.addEventListener('click', closePopup);
  actions.append(openExt, closeBtn);
  head.append(title, actions);
  const frame = makeEl('iframe', 'y-dock-popup-frame');
  frame.setAttribute('title', '应用窗口');
  frame.setAttribute('sandbox', 'allow-scripts allow-forms allow-popups allow-same-origin');
  card.append(head, frame);
  wrap.append(card);
  wrap.addEventListener('click', (e) => { if (e.target === wrap) closePopup(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePopup(); });
  document.body.append(wrap);
  popupEl = wrap;
  return wrap;
}

async function showPopup(app, url) {
  const wrap = ensurePopup();
  wrap.dataset.url = url;
  wrap.querySelector('.y-dock-popup-title').textContent = app.name || app.id;
  const frame = wrap.querySelector('.y-dock-popup-frame');
  wrap.hidden = false;
  requestAnimationFrame(() => wrap.classList.add('is-open'));
  await loadIntoFrame(frame, app, url);
}

function closePopup() {
  if (!popupEl || popupEl.hidden) return;
  popupEl.classList.remove('is-open');
  setTimeout(() => {
    if (!popupEl) return;
    popupEl.hidden = true;
    popupEl.querySelector('.y-dock-popup-frame').removeAttribute('srcdoc'); popupEl.querySelector('.y-dock-popup-frame').src = 'about:blank';
  }, 220);
}

/* ---------------- 生命周期 ---------------- */

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    subscriptions.length = 0;
    rootNode = makeEl('section', 'y-module y-dock');
    rootNode.dataset.moduleId = MODULE_ID;
    listNode = makeEl('div', 'y-dock-list glass');
    const musicToggle = makeEl('button', 'y-dock-music-toggle', '♫');
    musicToggle.type = 'button';
    musicToggle.title = '音乐';
    musicToggle.setAttribute('aria-label', '音乐播放器');
    musicToggle.addEventListener('click', async () => {
      const open = document.documentElement.hasAttribute('data-yt-music-open');
      if (open) {
        document.documentElement.removeAttribute('data-yt-music-open');
        musicToggle.removeAttribute('data-on');
      } else {
        document.documentElement.setAttribute('data-yt-music-open', '');
        musicToggle.setAttribute('data-on', '1');
      }
    });
    rootNode.append(musicToggle, listNode);
    mountSelf(ctx, rootNode);

    listen(ctx, 'storage:invalidate', ({ prefix } = {}) => {
      if (prefix && prefix.startsWith('/system/repos-manifest')) {
        void refresh();
      }
    });
    listen(ctx, 'apps:reload', () => void refresh());

    await refresh();
  },

  destroy() {
    for (const off of subscriptions) { try { off(); } catch { /* noop */ } }
    subscriptions.length = 0;
    closePopup();
    popupEl?.remove(); popupEl = null;
    rootNode?.remove(); rootNode = listNode = null;
    ctxRef = null;
  },
};

async function refresh() {
  if (!listNode) return;
  try {
    const apps = await loadApps();
    render(apps);
  } catch (err) {
    report('E_APPS', 'Dock 应用清单加载失败', err);
  }
}
