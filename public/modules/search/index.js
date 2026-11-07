// 搜索模块空壳：只负责搜索框 UI、事件发射与外部引擎跳转（ADR-007）。
// ADR-013「双重覆盖」：① 模块自决挂到 search 插槽，参与默认分层观感；
// ② 框内同时聚合本地应用 / 本地音乐匹配结果，主提交仍跳外部引擎。
// 不做搜索代理、不做结果缓存、不做建议缓存、不做历史持久化、不实现业务搜索算法。

const MODULE_ID = 'search';
const SLOT_NAMES = ['search', 'main', 'content'];
const ENGINE_PATH = '/shared/search/engine.json';
const ENGINES_PATH = '/cache/search/engines.json';
const DEFAULT_ENGINES = [
  { id: 'google', name: 'Google', url: 'https://www.google.com/search?q={q}' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q={q}' },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q={q}' },
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={q}' }
];
const ENGINE_ALIASES = { g: 'google', b: 'bing', d: 'duckduckgo', ddg: 'duckduckgo', bd: 'baidu' };
const DIRECTIVE_HINT = '! 指令：!g / !ddg / !bd 指定引擎，!app 聚合应用，!music 聚合音乐，!help 查看说明';

let ctxRef = null;
let rootNode = null;
let engineSelect = null;
let inputNode = null;
let appResultsNode = null;
let musicResultsNode = null;
let hintNode = null;
let engines = DEFAULT_ENGINES.slice();
let apps = [];
let tracks = [];
const subscriptions = [];

// 统一异常入口：所有异常都上报通知中心，不静默吞掉。
function report(ctx, code, message, err) {
  const detail = { code, module: MODULE_ID };
  if (err) {
    detail.message = err && err.message ? err.message : String(err);
    detail.stack = err && err.stack ? err.stack : null;
  }
  ctx.notify('error', message, detail);
}

function isPromise(value) {
  return !!value && typeof value.then === 'function';
}

async function emit(ctx, command, payload) {
  const result = ctx.bus.emit(command, payload);
  return isPromise(result) ? await result : result;
}

async function on(ctx, command, handler) {
  const result = ctx.bus.on(command, handler);
  if (isPromise(result)) await result;
  subscriptions.push({ command, handler });
}

// 布局自决（ADR-005）：依次尝试命名插槽，全部不可用时模块自取容器，不依赖任何 DOM id。
async function mountSelf(ctx, node, slotNames) {
  const errors = [];
  for (const name of slotNames) {
    try {
      let r = ctx.mount(name, node);
      if (isPromise(r)) r = await r;
      if (r !== false && (node.isConnected || node.parentNode)) return name;
      if (r === false) continue;
      const slot = ctx.slot(name);
      if (!slot) continue;
      let r2 = ctx.mount(slot, node);
      if (isPromise(r2)) r2 = await r2;
      if (r2 !== false && (node.isConnected || node.parentNode)) return name;
      if (r2 === false) continue;
      slot.appendChild(node);
      return name;
    } catch (err) {
      errors.push(err);
    }
  }
  try {
    let r = ctx.mount(document.body, node);
    if (isPromise(r)) r = await r;
    if (r !== false && !(node.isConnected || node.parentNode)) document.body.appendChild(node);
  } catch (err) {
    errors.push(err);
  }
  for (const err of errors) report(ctx, 'E_MODULE_INIT', '搜索模块挂载插槽失败，已使用自取容器', err);
  return 'self';
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function buildUi(ctx) {
  rootNode = makeEl('form', 'y-module y-module-search');
  rootNode.dataset.moduleId = MODULE_ID;
  rootNode.setAttribute('role', 'search');

  const row = makeEl('div', 'y-module-search-row');
  engineSelect = makeEl('select', 'y-module-search-engine');
  engineSelect.setAttribute('aria-label', '搜索引擎');
  engineSelect.addEventListener('change', () => {
    void persistSelectedEngine(ctx, engineSelect.value);
  });
  inputNode = makeEl('input', 'y-module-search-input');
  inputNode.type = 'search';
  inputNode.placeholder = '搜索';
  inputNode.setAttribute('aria-label', '搜索关键词');
  inputNode.addEventListener('input', () => {
    try {
      // 输入即发失效/过滤事件；不缓存任何结果。
      void emit(ctx, 'search:filter', { query: inputNode.value });
      renderLocalResults(inputNode.value, 'all');
      rootNode?.classList.toggle('has-query', inputNode.value.trim().length > 0);
    } catch (err) {
      report(ctx, 'E_SCHEMA', '搜索过滤事件发射失败', err);
    }
  });
  const submitBtn = makeEl('button', 'y-module-search-submit', '搜索');
  submitBtn.type = 'submit';
  row.append(engineSelect, inputNode, submitBtn);

  hintNode = makeEl('p', 'y-module-search-hint', DIRECTIVE_HINT);

  // 框内聚合区（ADR-013 C）：展示本地匹配结果，不缓存、不持久化。
  const aggregate = makeEl('div', 'y-module-search-aggregate');
  aggregate.append(
    makeEl('h4', 'y-module-search-aggregate-title', '框内聚合 · 本地结果'),
    makeEl('span', 'y-module-search-aggregate-label', '应用'),
    (appResultsNode = makeEl('ul', 'y-module-search-apps')),
    makeEl('span', 'y-module-search-aggregate-label', '音乐'),
    (musicResultsNode = makeEl('ul', 'y-module-search-music'))
  );
  renderLocalResults('', 'all');

  const custom = makeEl('details', 'y-module-search-custom');
  custom.append(makeEl('summary', '', '自定义引擎'));
  const customRow = makeEl('div', 'y-module-search-custom-row');
  const idInput = makeEl('input');
  idInput.placeholder = '引擎 id（kebab-case）';
  const urlInput = makeEl('input');
  urlInput.placeholder = 'URL 模板，含 {q}';
  const addBtn = makeEl('button', '', '添加');
  addBtn.type = 'button';
  const delSelect = makeEl('select', 'y-module-search-del-select');
  const delBtn = makeEl('button', '', '删除');
  delBtn.type = 'button';
  customRow.append(idInput, urlInput, addBtn);
  const manageRow = makeEl('div', 'y-module-search-custom-row');
  manageRow.append(delSelect, delBtn);
  custom.append(customRow, manageRow, makeEl('p', '', '自定义引擎持久化到 /cache/search/engines.json（带 TTL）。'));
  addBtn.addEventListener('click', async () => { await addCustomEngine(ctx, idInput, urlInput); });
  delBtn.addEventListener('click', async () => { await removeCustomEngine(ctx, delSelect); });
  rootNode._customUi = { delSelect };

  rootNode.append(row, hintNode, aggregate, custom);
  rootNode.addEventListener('submit', (event) => {
    event.preventDefault();
    void handleSubmit(ctx);
  });
}

function normalizeList(result, keys) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  for (const key of keys) {
    if (Array.isArray(result[key])) return result[key];
  }
  return [];
}

function normalizeEngines(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  if (Array.isArray(result.engines)) return result.engines;
  if (Array.isArray(result.custom)) return result.custom;
  return [];
}

function renderEngines() {
  if (!engineSelect) return;
  const previous = engineSelect.value;
  engineSelect.replaceChildren();
  for (const engine of engines) {
    const option = makeEl('option', '', engine.name || engine.id);
    option.value = engine.id;
    engineSelect.append(option);
  }
  if (previous && engines.some((e) => e.id === previous)) engineSelect.value = previous;
  if (!engineSelect.value && engines.length) engineSelect.value = engines[0].id;
}

function currentEngine() {
  const id = engineSelect ? engineSelect.value : '';
  return engines.find((e) => e.id === id) || engines[0] || DEFAULT_ENGINES[2];
}

function buildExternalUrl(engine, query) {
  const template = engine && engine.url ? String(engine.url) : 'https://duckduckgo.com/?q={q}';
  return template.replace('{q}', encodeURIComponent(query));
}

// 简单 UI 级子串匹配：用于框内本地聚合，不产生任何缓存。
function matchItems(items, query, fields) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  return items.filter((item) => fields.some((field) => String(item && item[field] != null ? item[field] : '').toLowerCase().includes(q))).slice(0, 5);
}

function fillList(target, items, labelKey, emptyText, kind) {
  if (!target) return;
  target.replaceChildren();
  if (!items.length) {
    target.append(makeEl('li', 'y-module-search-empty', emptyText));
    return;
  }
  for (const item of items) {
    const li = makeEl('li', 'y-module-search-result');
    const btn = makeEl('button', 'y-module-search-result-btn', String(item[labelKey] || item.id || '未命名'));
    btn.type = 'button';
    btn.addEventListener('click', () => openLocalResult(item, kind));
    li.append(btn);
    target.append(li);
  }
}

/** 本地结果：应用打开链接 / 音乐通过总线播放（不跳转、不缓存） */
function openLocalResult(item, kind) {
  const ctx = ctxRef;
  if (!ctx) return;
  try {
    if (kind === 'music') {
      emit(ctx, 'music:play', { id: item.id }).catch((err) => report(ctx, 'E_MUSIC_PLAY', '播放失败', err));
      return;
    }
    const url = item.entry || item.url || item.path;
    if (url) window.open(url, '_blank', 'noopener,noreferrer');
    else ctx.notify('warn', '该应用未配置入口链接', { code: 'E_NOT_FOUND', module: MODULE_ID, id: item.id });
  } catch (err) { report(ctx, 'E_INTERNAL', '打开本地结果失败', err); }
}

function renderLocalResults(query, scope) {
  const q = String(query || '').replace(/^!\S+\s*/, '').trim();
  if (scope === 'all' || scope === 'apps') {
    fillList(appResultsNode, scope === 'apps' ? matchItems(apps, q, ['name', 'id', 'description', 'tags']) : matchItems(apps, q, ['name', 'id']), 'name', '输入关键词以匹配本地应用', 'apps');
  }
  if (scope === 'all' || scope === 'music') {
    fillList(musicResultsNode, matchItems(tracks, q, ['title', 'id', 'artist']), 'title', '输入关键词以匹配本地音乐', 'music');
  }
}

/** 读取 /cache/search/engines.json（带 TTL）中的自定义引擎 */
async function readCustomEngines(ctx) {
  try {
    const list = await emit(ctx, 'storage:get', { path: ENGINES_PATH, fallback: [] });
    return Array.isArray(list) ? list : [];
  } catch (err) { report(ctx, 'E_VFS_BACKEND', '读取自定义引擎失败', err); return []; }
}

async function writeCustomEngines(ctx, list) {
  try {
    await emit(ctx, 'storage:set', { path: ENGINES_PATH, value: list, schema: 'engine-list@1', ttl: 7 * 86400 });
  } catch (err) { report(ctx, 'E_VFS_BACKEND', '保存自定义引擎失败', err); }
}

async function addCustomEngine(ctx, idInput, urlInput) {
  const id = String(idInput.value || '').trim().toLowerCase();
  const url = String(urlInput.value || '').trim();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id) || !url.includes('{q}') || !/^https?:\/\//i.test(url)) {
    ctx.notify('error', '引擎 id 需 kebab-case，URL 需为 http(s) 且含 {q}', { code: 'E_SCHEMA', module: MODULE_ID });
    return;
  }
  const list = await readCustomEngines(ctx);
  if (list.some((e) => e.id === id) || DEFAULT_ENGINES.some((e) => e.id === id)) {
    ctx.notify('error', '引擎 id 已存在', { code: 'E_SCHEMA', module: MODULE_ID, id }); return;
  }
  list.push({ id, name: id, url });
  await writeCustomEngines(ctx, list);
  engines = [...DEFAULT_ENGINES, ...list];
  renderEngines();
  renderDeleteOptions(rootNode?._customUi?.delSelect, list);
  idInput.value = ''; urlInput.value = '';
  ctx.notify('info', `已添加引擎 ${id}`, { module: MODULE_ID });
}

async function removeCustomEngine(ctx, select) {
  const id = select?.value;
  if (!id) return;
  const list = (await readCustomEngines(ctx)).filter((e) => e.id !== id);
  await writeCustomEngines(ctx, list);
  engines = [...DEFAULT_ENGINES, ...list];
  renderEngines();
  renderDeleteOptions(select, list);
  ctx.notify('info', `已删除引擎 ${id}`, { module: MODULE_ID });
}

function renderDeleteOptions(select, list) {
  if (!select) return;
  select.replaceChildren();
  if (!list.length) { const o = makeEl('option', '', '(无自定义引擎)'); o.value = ''; select.append(o); return; }
  for (const e of list) { const o = makeEl('option', '', e.name || e.id); o.value = e.id; select.append(o); }
}

function parseDirective(raw) {
  const matched = /^!([a-z0-9-]+)(?:\s+([\s\S]*))?$/i.exec(raw.trim());
  if (!matched) return null;
  return { name: matched[1].toLowerCase(), query: (matched[2] || '').trim() };
}

async function loadEngines(ctx) {
  let config = null;
  try {
    config = await emit(ctx, 'config:get', { key: 'search' });
  } catch (err) {
    report(ctx, 'E_SCHEMA', '读取搜索配置失败，已回退内置引擎', err);
  }
  const configured = config && Array.isArray(config.engines) ? config.engines : [];
  let custom = [];
  try {
    custom = normalizeEngines(await emit(ctx, 'storage:get', { path: ENGINES_PATH, fallback: [] }));
  } catch (err) {
    report(ctx, 'E_VFS_BACKEND', '读取自定义引擎列表失败', err);
  }
  const merged = [];
  const seen = new Set();
  for (const engine of [...configured, ...custom, ...DEFAULT_ENGINES]) {
    if (!engine || !engine.id || !engine.url || seen.has(engine.id)) continue;
    seen.add(engine.id);
    merged.push({ id: engine.id, name: engine.name || engine.id, url: engine.url });
  }
  engines = merged;
  renderEngines();
  renderDeleteOptions(rootNode?._customUi?.delSelect, custom);

  try {
    const saved = await emit(ctx, 'storage:get', { path: ENGINE_PATH, fallback: null });
    const savedId = saved && (saved.id || saved.engine) ? (saved.id || saved.engine) : null;
    const defaultId = config && config.defaultEngine ? config.defaultEngine : null;
    const wanted = savedId || defaultId;
    if (wanted && engines.some((e) => e.id === wanted)) engineSelect.value = wanted;
  } catch (err) {
    report(ctx, 'E_VFS_BACKEND', '读取上次所选引擎失败', err);
  }
  if (!engineSelect.value && engines.length) engineSelect.value = engines[0].id;
}

async function persistSelectedEngine(ctx, id) {
  try {
    // 只记住「上次所选引擎」，不记结果 / 建议 / 历史（ADR-012、ADR-013）。
    // engine-state@1 要求 engine 字段（StorageService 内置 schema），同时保留 id 便于兼容读取。
    await emit(ctx, 'storage:set', { path: ENGINE_PATH, value: { engine: id, id }, schema: 'engine-state@1' });
  } catch (err) {
    report(ctx, 'E_VFS_BACKEND', '保存上次所选引擎失败', err);
  }
}

async function refreshLocalLists(ctx) {
  try {
    apps = normalizeList(await emit(ctx, 'apps:list', {}), ['apps', 'items']);
  } catch (err) {
    report(ctx, 'E_SCHEMA', '读取应用清单失败', err);
  }
  try {
    tracks = normalizeList(await emit(ctx, 'music:list', {}), ['tracks', 'items']);
  } catch (err) {
    report(ctx, 'E_SCHEMA', '读取音乐清单失败', err);
  }
  renderLocalResults(inputNode ? inputNode.value : '', 'all');
}

async function handleSubmit(ctx) {
  try {
    const raw = inputNode ? inputNode.value.trim() : '';
    if (!raw) return;
    const directive = parseDirective(raw);

    if (directive) {
      const name = directive.name;
      if (name === 'help') {
        hintNode.textContent = DIRECTIVE_HINT;
        return;
      }
      if (name === 'app' || name === 'music') {
        // 框内聚合：只发过滤事件 + 渲染，不跳外部引擎。
        await emit(ctx, 'search:filter', { query: directive.query });
        renderLocalResults(directive.query, name === 'app' ? 'apps' : 'music');
        return;
      }
      const engineId = ENGINE_ALIASES[name] || name;
      const engine = engines.find((e) => e.id === engineId);
      if (!engine || !directive.query) {
        ctx.notify('error', '未知 ! 指令或缺少查询词', { code: 'E_SEARCH_BANG', module: MODULE_ID, directive: name });
        return;
      }
      engineSelect.value = engine.id;
      await emit(ctx, 'search:submit', { engine: engine.id, query: directive.query });
      window.location.assign(buildExternalUrl(engine, directive.query));
      return;
    }

    await emit(ctx, 'search:filter', { query: raw });
    renderLocalResults(raw, 'all');
    const engine = currentEngine();
    // 先发可观测事件；若总线 handler 显式接管（handled / preventDefault / false），模块不再自行跳转。
    const result = await emit(ctx, 'search:submit', { engine: engine.id, query: raw });
    const handled = result === false || (result && (result.handled === true || result.preventDefault === true));
    if (handled) return;
    window.location.assign(buildExternalUrl(engine, raw));
  } catch (err) {
    report(ctx, 'E_SCHEMA', '搜索提交失败', err);
  }
}

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    try {
      buildUi(ctx);
      await mountSelf(ctx, rootNode, SLOT_NAMES);
      await loadEngines(ctx);
      await refreshLocalLists(ctx);

      // 共享清单被改写后刷新本地来源数据；不缓存任何搜索结果。
      await on(ctx, 'storage:invalidate', (payload) => {
        try {
          const prefix = payload && payload.prefix ? String(payload.prefix) : '';
          if (prefix.startsWith('/system') || prefix.startsWith('/cache/search')) void refreshLocalLists(ctx);
        } catch (err) {
          report(ctx, 'E_SCHEMA', '处理存储失效广播失败', err);
        }
      });
    } catch (err) {
      report(ctx, 'E_MODULE_INIT', '搜索模块初始化失败', err);
    }
  },

  destroy() {
    const ctx = ctxRef;
    try {
      for (const { command, handler } of subscriptions) {
        try {
          ctx.bus.off(command, handler);
        } catch (err) {
          report(ctx, 'E_MODULE_INIT', `取消订阅 ${command} 失败`, err);
        }
      }
      subscriptions.length = 0;
      if (rootNode && rootNode.parentNode) rootNode.parentNode.removeChild(rootNode);
    } catch (err) {
      if (ctx) report(ctx, 'E_MODULE_INIT', '搜索模块销毁失败', err);
      else console.error('[yingo] 搜索模块销毁失败（通知中心不可用）', err);
    } finally {
      rootNode = null;
      engineSelect = null;
      inputNode = null;
      appResultsNode = null;
      musicResultsNode = null;
      hintNode = null;
      engines = DEFAULT_ENGINES.slice();
      apps = [];
      tracks = [];
      ctxRef = null;
    }
  }
};
