/**
 * search — 搜索胶囊（清风版）
 * 多引擎切换（设置不可改翻译，搜索引擎可配）+ 框内本地聚合（应用/音乐）+ ! 指令。
 * 主提交跳转外部引擎（ADR-007）。
 */

const MODULE_ID = 'search';
const SLOT_NAMES = ['search', 'hero', 'main'];
const ENGINE_PATH = '/shared/search/engine.json';
const ENGINES_CACHE = '/cache/search/engines.json';
const DEFAULT_ENGINES = [
  { id: 'bing', name: '必应', url: 'https://www.bing.com/search?q={q}' },
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={q}' },
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={q}' },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={q}' },
];
const ALIASES = { g: 'google', b: 'bing', d: 'duckduckgo', ddg: 'duckduckgo', bd: 'baidu' };

let ctxRef = null;
let rootNode = null;
let engineSel = null;
let inputNode = null;
let appListNode = null;
let musicListNode = null;
let engines = [...DEFAULT_ENGINES];
let apps = [];
let tracks = [];
const subs = [];

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
  if (typeof off === 'function') subs.push(off);
}

/* ---------------- 引擎 ---------------- */

async function loadEngines() {
  const cfg = await bus('config:get', { key: 'search' }).catch(() => null);
  let custom = [];
  try { custom = await bus('storage:get', { path: ENGINES_CACHE, fallback: [] }) || []; } catch { /* noop */ }
  const seen = new Set();
  engines = [];
  for (const e of [...(cfg?.engines || []), ...(Array.isArray(custom) ? custom : []), ...DEFAULT_ENGINES]) {
    if (!e?.id || !e?.url || seen.has(e.id)) continue;
    seen.add(e.id);
    engines.push({ id: e.id, name: e.name || e.id, url: e.url });
  }
  renderEngines();
  // 恢复上次引擎
  const saved = await bus('storage:get', { path: ENGINE_PATH, fallback: null }).catch(() => null);
  const want = saved?.engine || cfg?.defaultEngine;
  if (want && engines.some((e) => e.id === want)) engineSel.value = want;
  if (!engineSel.value && engines.length) engineSel.value = engines[0].id;
}

function renderEngines() {
  engineSel.replaceChildren();
  for (const e of engines) {
    const o = makeEl('option', '', e.name);
    o.value = e.id;
    engineSel.append(o);
  }
}

function currentEngine() {
  return engines.find((e) => e.id === engineSel.value) || engines[0];
}

function buildUrl(engine, q) {
  return (engine?.url || DEFAULT_ENGINES[0].url).replace('{q}', encodeURIComponent(q));
}

/* ---------------- 本地聚合 ---------------- */

function match(items, q, fields) {
  const k = q.trim().toLowerCase();
  if (!k) return [];
  return items.filter((it) => fields.some((f) => String(it?.[f] ?? '').toLowerCase().includes(k))).slice(0, 4);
}

function fill(list, items, labelKey, kind, emptyText) {
  list.replaceChildren();
  if (!items.length) { list.append(makeEl('li', 'y-search-empty', emptyText)); return; }
  for (const it of items) {
    const li = makeEl('li');
    const btn = makeEl('button', 'y-search-result', String(it[labelKey] || it.id || '未命名'));
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (kind === 'music') {
        bus('music:play', { id: it.id }).catch((err) => report('E_MUSIC_PLAY', '播放失败', err));
      } else {
        const url = it.url || it.entry;
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
        else ctxRef.notify('warn', '该应用未配置入口', { module: MODULE_ID, id: it.id });
      }
    });
    li.append(btn);
    list.append(li);
  }
}

function renderAggregate(q) {
  const k = q.replace(/^!\S+\s*/, '').trim();
  fill(appListNode, match(apps, k, ['name', 'id', 'description']), 'name', 'apps', '输入以匹配应用');
  fill(musicListNode, match(tracks, k, ['title', 'id', 'artist']), 'title', 'music', '输入以匹配音乐');
}

async function refreshLocal() {
  try { apps = (await bus('apps:list', {}))?.apps || []; } catch { apps = []; }
  try { tracks = (await bus('music:list', {}))?.tracks || []; } catch { tracks = []; }
  renderAggregate(inputNode?.value || '');
}

/* ---------------- 提交 ---------------- */

function parseBang(raw) {
  const m = /^!([a-z0-9-]+)(?:\s+([\s\S]*))?$/i.exec(raw.trim());
  return m ? { name: m[1].toLowerCase(), query: (m[2] || '').trim() } : null;
}

async function submit() {
  const raw = inputNode.value.trim();
  if (!raw) return;
  const bang = parseBang(raw);
  if (bang) {
    if (bang.name === 'help') { inputNode.placeholder = '!g !bd !ddg 指定引擎 · !app 应用 · !music 音乐'; inputNode.value = ''; return; }
    if (bang.name === 'app' || bang.name === 'music') {
      renderAggregate(raw);
      return;
    }
    const eng = engines.find((e) => e.id === (ALIASES[bang.name] || bang.name));
    if (eng && bang.query) {
      engineSel.value = eng.id;
      window.location.assign(buildUrl(eng, bang.query));
      return;
    }
    report('E_SEARCH_BANG', `未知 ! 指令: ${bang.name}`);
    return;
  }
  // 本地有精确匹配时优先聚合展示（输入即过滤已做），主提交仍跳引擎
  const eng = currentEngine();
  window.location.assign(buildUrl(eng, raw));
}

/* ---------------- 生命周期 ---------------- */

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    subs.length = 0;
    rootNode = makeEl('form', 'y-module y-search glass');
    rootNode.dataset.moduleId = MODULE_ID;

    engineSel = makeEl('select', 'y-search-engine');
    engineSel.setAttribute('aria-label', '搜索引擎');
    engineSel.addEventListener('change', () => {
      bus('storage:set', { path: ENGINE_PATH, value: { engine: engineSel.value, id: engineSel.value }, schema: 'engine-state@1' }).catch(() => {});
    });

    inputNode = makeEl('input', 'y-search-input');
    inputNode.type = 'text';
    inputNode.placeholder = '搜索';
    inputNode.setAttribute('autocomplete', 'off');
    inputNode.setAttribute('autocapitalize', 'off');
    inputNode.setAttribute('spellcheck', 'false');

    const submitBtn = makeEl('button', 'y-search-submit');
    submitBtn.innerHTML = '<img src="./assets/icons/search.svg" alt="" style="width:18px;height:18px;filter:invert(1)">';
    submitBtn.type = 'submit';
    submitBtn.setAttribute('aria-label', '搜索');

    // 聚合面板
    const panel = makeEl('div', 'y-search-panel glass');
    const appCol = makeEl('div');
    appCol.append(makeEl('h4', '', '应用'));
    appListNode = makeEl('ul');
    appCol.append(appListNode);
    const musicCol = makeEl('div');
    musicCol.append(makeEl('h4', '', '音乐'));
    musicListNode = makeEl('ul');
    musicCol.append(musicListNode);
    panel.append(appCol, musicCol);

    rootNode.append(engineSel, inputNode, submitBtn, panel);
    mountSelf(ctx, rootNode);

    inputNode.addEventListener('input', () => {
      const has = inputNode.value.trim().length > 0;
      rootNode.classList.toggle('has-query', has);
      void bus('search:filter', { query: inputNode.value }).catch(() => {});
      renderAggregate(inputNode.value);
    });
    rootNode.addEventListener('submit', (e) => { e.preventDefault(); void submit(); });
    // Ctrl+/ 或 / 聚焦
    document.addEventListener('keydown', (e) => {
      if (e.key === '/' && document.activeElement !== inputNode && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || '')) {
        e.preventDefault();
        inputNode.focus();
      }
    });

    listen(ctx, 'storage:invalidate', ({ prefix } = {}) => {
      if (prefix && (prefix.startsWith('/system/repos-manifest') || prefix.startsWith('/cache/search'))) void refreshLocal();
    });

    try {
      await loadEngines();
      await refreshLocal();
    } catch (err) {
      report('E_MODULE_INIT', '搜索模块初始化失败', err);
    }
  },

  destroy() {
    for (const off of subs) { try { off(); } catch { /* noop */ } }
    subs.length = 0;
    rootNode?.remove();
    rootNode = engineSel = inputNode = appListNode = musicListNode = null;
    ctxRef = null;
  },
};
