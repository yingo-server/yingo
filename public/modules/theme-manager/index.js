// 主题服务空壳：注册 theme:list / theme:apply / theme:bg-set 三条总线命令。
// 当前主题持久化到 /shared/theme/current.json；第三套（lime-tabs）背景参数写 /shared/theme/bg.json。
// 真实 token 注入、CSS 切换由 ThemeService / 主题模块负责，本模块做命令注册、持久化与状态 UI。
// 布局自决（ADR-005）：模块内部选择挂载插槽，不依赖任何 DOM id。

const MODULE_ID = 'theme-manager';
const SLOT_NAMES = ['theme', 'settings', 'drawer', 'panel', 'main'];
const CURRENT_PATH = '/shared/theme/current.json';
const BG_PATH = '/shared/theme/bg.json';
const BG_LEGACY_PATH = '/shared/theme/background.json'; // §8.4 中的旧路径，仅兼容读取，不写入
const FALLBACK_THEMES = [
  { id: 'material-3', name: '严格 MD3' },
  { id: 'neumorphism', name: '新拟物' },
  { id: 'lime-tabs', name: '青柠标签页' }
];

let ctxRef = null;
let rootNode = null;
let listNode = null;
let currentNode = null;
let bgUrlInput = null;
let bgBlurInput = null;
let bgTintInput = null;
let themes = FALLBACK_THEMES.slice();
let currentId = 'material-3';
let bgParams = { url: '', blur: 18, tint: '' };
const subscriptions = [];

function report(ctx, code, message, err) {
  const detail = { code, module: MODULE_ID };
  if (err) {
    detail.message = err && err.message ? err.message : String(err);
    detail.stack = err && err.stack ? err.stack : null;
  }
  ctx.notify('error', message, detail);
}

// 有些 Kernel 实现对未注册服务返回 null，有些直接抛错；统一封装为「无服务返回 null」。
function safeService(ctx, name) {
  try {
    if (!ctx || typeof ctx.getService !== 'function') return null;
    return ctx.getService(name) || null;
  } catch (err) {
    // 未注册属正常降级，不上报异常；其它错误仍需可见。
    if (String(err && err.message).includes('未注册')) return null;
    report(ctx, 'E_SCHEMA', `获取服务 ${name} 失败`, err);
    return null;
  }
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

async function mountSelf(ctx, node, slotNames) {
  const errors = [];
  for (const name of slotNames) {
    try {
      let r = ctx.mount(name, node);
      if (isPromise(r)) r = await r;
      if (r !== false && (node.isConnected || node.parentNode)) return;
      if (r === false) continue;
      const slot = ctx.slot(name);
      if (!slot) continue;
      let r2 = ctx.mount(slot, node);
      if (isPromise(r2)) r2 = await r2;
      if (r2 !== false && (node.isConnected || node.parentNode)) return;
      if (r2 === false) continue;
      slot.appendChild(node);
      return;
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
  for (const err of errors) report(ctx, 'E_MODULE_INIT', '主题服务挂载插槽失败，已使用自取容器', err);
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function buildUi(ctx) {
  rootNode = makeEl('details', 'y-module y-module-theme-manager');
  rootNode.dataset.moduleId = MODULE_ID;
  rootNode.append(makeEl('summary', '', '主题与外观'));

  currentNode = makeEl('p', 'y-module-theme-manager-current', '当前主题：加载中');
  listNode = makeEl('div', 'y-module-theme-manager-list');

  const bgForm = makeEl('form', 'y-module-theme-manager-bg-form');
  bgForm.append(makeEl('h4', '', '第三套背景参数'));
  bgUrlInput = makeEl('input');
  bgUrlInput.type = 'text';
  bgUrlInput.placeholder = '背景图 URL / VFS 路径';
  bgBlurInput = makeEl('input');
  bgBlurInput.type = 'number';
  bgBlurInput.placeholder = '模糊半径';
  bgTintInput = makeEl('input');
  bgTintInput.type = 'text';
  bgTintInput.placeholder = '色调';
  const bgSubmit = makeEl('button', '', '应用背景');
  bgSubmit.type = 'submit';
  bgForm.append(bgUrlInput, bgBlurInput, bgTintInput, bgSubmit);
  bgForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void emit(ctx, 'theme:bg-set', {
      url: bgUrlInput.value,
      blur: Number(bgBlurInput.value) || 0,
      tint: bgTintInput.value
    }).catch((err) => report(ctx, 'E_SCHEMA', '主题背景设置失败', err));
  });

  rootNode.append(currentNode, listNode, bgForm);
}

function normalizeThemes(result) {
  let raw = result;
  if (raw && !Array.isArray(raw)) raw = raw.themes || raw.list || raw.items;
  if (!Array.isArray(raw)) return FALLBACK_THEMES.slice();
  const list = raw.map((item) => (typeof item === 'string' ? { id: item, name: item } : item && item.id ? { id: item.id, name: item.name || item.id } : null)).filter(Boolean);
  return list.length ? list : FALLBACK_THEMES.slice();
}

function render() {
  if (!rootNode) return;
  currentNode.textContent = `当前主题：${currentId}`;
  listNode.replaceChildren();
  for (const theme of themes) {
    const btn = makeEl('button', 'y-module-theme-manager-item', theme.name);
    btn.type = 'button';
    btn.dataset.themeId = theme.id;
    if (theme.id === currentId) btn.setAttribute('aria-current', 'true');
    btn.addEventListener('click', () => {
      void emit(ctxRef, 'theme:apply', { id: theme.id }).catch((err) => report(ctxRef, 'E_SCHEMA', '主题切换失败', err));
    });
    listNode.append(btn);
  }
  bgUrlInput.value = String(bgParams.url || '');
  bgBlurInput.value = String(bgParams.blur == null ? '' : bgParams.blur);
  bgTintInput.value = String(bgParams.tint || '');
}

// 命令 handler：theme:list 返回三套主题（清单，渲染由主题模块负责）。
async function handleList(ctx) {
  try {
    let serviceResult = null;
    const service = safeService(ctx, 'theme');
    if (service && typeof service.list === 'function') serviceResult = await service.list();
    if (serviceResult) themes = normalizeThemes(serviceResult);
    render();
    return { themes: themes.slice() };
  } catch (err) {
    report(ctx, 'E_SCHEMA', '获取主题列表失败', err);
    return { themes: themes.slice(), error: 'E_SCHEMA' };
  }
}

// 命令 handler：theme:apply 持久化当前主题，并把实际应用委托给 ThemeService（若存在）。
// 注意：handler 内绝不再 emit('theme:apply')，避免自递归；restore 也走只读路径。
async function handleApply(ctx, payload) {
  try {
    const id = payload && payload.id ? String(payload.id) : '';
    if (!id) {
      ctx.notify('error', '主题应用缺少 id', { code: 'E_SCHEMA', module: MODULE_ID });
      return { ok: false, error: 'E_SCHEMA' };
    }
    if (!themes.some((theme) => theme.id === id)) {
      ctx.notify('error', `未注册主题 ${id}，仅记录状态`, { code: 'E_NOT_FOUND', module: MODULE_ID, id });
    }
    currentId = id;
    // 只走 storage:* 总线命令，schema 由 StorageService 校验。
    await emit(ctx, 'storage:set', {
      path: CURRENT_PATH,
      value: { id, appliedAt: Date.now() },
      schema: 'theme-state@1'
    });
    const service = safeService(ctx, 'theme');
    if (service && typeof service.apply === 'function') await service.apply(id);
    render();
    return { ok: true, id };
  } catch (err) {
    report(ctx, 'E_VFS_BACKEND', '主题应用/持久化失败', err);
    return { ok: false, error: 'E_VFS_BACKEND' };
  }
}

// 命令 handler：theme:bg-set 写第三套背景参数（§5 命令载荷 url / blur / tint）。
async function handleBgSet(ctx, payload) {
  try {
    const value = {
      url: payload && payload.url != null ? String(payload.url) : '',
      blur: Number(payload && payload.blur) || 0,
      tint: payload && payload.tint != null ? String(payload.tint) : ''
    };
    await emit(ctx, 'storage:set', { path: BG_PATH, value, schema: 'theme-bg@1' });
    bgParams = value;
    const service = safeService(ctx, 'theme');
    if (service && typeof service.applyBg === 'function') await service.applyBg(value);
    render();
    return { ok: true, value: { ...value } };
  } catch (err) {
    report(ctx, 'E_VFS_BACKEND', '主题背景参数持久化失败', err);
    return { ok: false, error: 'E_VFS_BACKEND' };
  }
}

async function restore(ctx) {
  try {
    themes = normalizeThemes(await emit(ctx, 'config:get', { key: 'themes' }));
  } catch (err) {
    report(ctx, 'E_SCHEMA', '读取主题配置失败，已回退内置清单', err);
  }
  let saved = null;
  try {
    saved = await emit(ctx, 'storage:get', { path: CURRENT_PATH, fallback: null });
  } catch (err) {
    report(ctx, 'E_VFS_BACKEND', '读取当前主题失败', err);
  }
  const id = saved && saved.id ? String(saved.id) : (themes.find((theme) => theme.id === 'material-3') || themes[0] || {}).id;
  if (id) {
    currentId = id;
    // 只读恢复：委托主题服务实际应用 token，但绝不再次写盘（避免失效广播回环）。
    try {
      const service = safeService(ctx, 'theme');
      if (service && typeof service.apply === 'function') await service.apply(id);
    } catch (err) {
      report(ctx, 'E_SCHEMA', '恢复主题时服务应用失败', err);
    }
  }
  try {
    let bg = await emit(ctx, 'storage:get', { path: BG_PATH, fallback: null });
    if (!bg) bg = await emit(ctx, 'storage:get', { path: BG_LEGACY_PATH, fallback: null });
    if (bg && typeof bg === 'object') bgParams = { url: String(bg.url || ''), blur: Number(bg.blur) || 0, tint: String(bg.tint || '') };
  } catch (err) {
    report(ctx, 'E_VFS_BACKEND', '读取主题背景参数失败', err);
  }
  render();
}

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    try {
      buildUi(ctx);
      render();
      await mountSelf(ctx, rootNode, SLOT_NAMES);

      // 主题命令优先由 Kernel 的 ThemeService / app-services 提供；
      // 仅当探测不到既有 handler 时才注册兜底空壳，避免出现多订阅者返回值数组与重复写盘。
      let themeServiceExists = false;
      try {
        const probe = await emit(ctx, 'theme:list', {});
        themeServiceExists = probe !== undefined && probe !== null;
      } catch (err) {
        report(ctx, 'E_SCHEMA', '探测主题服务失败，将注册本地兜底 handler', err);
      }
      if (!themeServiceExists) {
        await on(ctx, 'theme:list', () => handleList(ctx));
        await on(ctx, 'theme:apply', (payload) => handleApply(ctx, payload));
        await on(ctx, 'theme:bg-set', (payload) => handleBgSet(ctx, payload));
      }
      const service = safeService(ctx, 'theme');
      if (service && typeof service.list === 'function') {
        try {
          themes = normalizeThemes(await service.list());
          render();
        } catch (err) {
          report(ctx, 'E_SCHEMA', '读取 ThemeService 清单失败', err);
        }
      }
      await restore(ctx);

      // 外部（例如管理面板）改写 /shared/theme 后刷新状态展示，不重复写盘。
      await on(ctx, 'storage:invalidate', (payload) => {
        try {
          const prefix = payload && payload.prefix ? String(payload.prefix) : '';
          if (!prefix || prefix.startsWith('/shared/theme')) void restore(ctx);
        } catch (err) {
          report(ctx, 'E_SCHEMA', '处理存储失效广播失败', err);
        }
      });
    } catch (err) {
      report(ctx, 'E_MODULE_INIT', '主题服务初始化失败', err);
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
      if (ctx) report(ctx, 'E_MODULE_INIT', '主题服务销毁失败', err);
      else console.error('[yingo] 主题服务销毁失败（通知中心不可用）', err);
    } finally {
      rootNode = null;
      listNode = null;
      currentNode = null;
      bgUrlInput = null;
      bgBlurInput = null;
      bgTintInput = null;
      themes = FALLBACK_THEMES.slice();
      currentId = 'material-3';
      bgParams = { url: '', blur: 18, tint: '' };
      ctxRef = null;
    }
  }
};
