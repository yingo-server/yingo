// 应用网格空壳：通过总线取清单、渲染卡片占位，并订阅排序文件的失效广播。
// 不做应用 CRUD、不做持久化业务逻辑；排序只做最简占位应用，后续阶段替换。
// 布局自决（ADR-005）：模块内部选择挂载插槽，不依赖任何 DOM id。

const MODULE_ID = 'apps-grid';
const SLOT_NAMES = ['apps', 'main', 'content'];
const ORDER_PATH = '/shared/apps/order.json';

let ctxRef = null;
let rootNode = null;
let gridNode = null;
let statusNode = null;
let apps = [];
let filterQuery = '';
const subscriptions = [];

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
  for (const err of errors) report(ctx, 'E_MODULE_INIT', '应用网格挂载插槽失败，已使用自取容器', err);
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function buildUi() {
  rootNode = makeEl('section', 'y-module y-module-apps-grid');
  rootNode.dataset.moduleId = MODULE_ID;
  statusNode = makeEl('p', 'y-module-apps-grid-status', '应用清单加载中（占位）');
  gridNode = makeEl('div', 'y-module-apps-grid-cards');
  rootNode.append(makeEl('h2', 'y-module-apps-grid-title', '应用'), statusNode, gridNode);
}

function normalizeApps(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.apps)) return result.apps;
  if (result && Array.isArray(result.items)) return result.items;
  return [];
}

function normalizeOrder(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? item : item && item.id)).filter(Boolean);
  if (Array.isArray(value.order)) return value.order.map((item) => (typeof item === 'string' ? item : item && item.id)).filter(Boolean);
  return [];
}

// 占位排序：优先使用 /shared/apps/order.json 中的 id 顺序，其余按 app.order。
function applyOrder(list, order) {
  const rank = new Map(order.map((id, index) => [id, index]));
  return list.slice().sort((a, b) => {
    const ra = rank.has(a.id) ? rank.get(a.id) : Number.MAX_SAFE_INTEGER;
    const rb = rank.has(b.id) ? rank.get(b.id) : Number.MAX_SAFE_INTEGER;
    if (ra !== rb) return ra - rb;
    return (Number(a.order) || 0) - (Number(b.order) || 0);
  });
}

function render() {
  if (!gridNode || !statusNode) return;
  gridNode.replaceChildren();
  const q = filterQuery.trim().toLowerCase();
  let visible = apps.filter((app) => !app.hidden);
  if (q) {
    // UI 级占位过滤，与「search:filter」事件配套，不是业务搜索算法。
    visible = visible.filter((app) => ['name', 'id', 'description', 'group'].some((key) => String(app[key] == null ? '' : app[key]).toLowerCase().includes(q)));
  }
  for (const app of visible) {
    const card = makeEl('article', 'y-module-apps-grid-card');
    card.dataset.appId = String(app.id || '');
    card.append(makeEl('span', 'y-module-apps-grid-icon', String(app.icon || '·')));
    card.append(makeEl('h3', 'y-module-apps-grid-card-title', String(app.name || app.id || '未命名应用')));
    card.append(makeEl('p', 'y-module-apps-grid-card-desc', String(app.description || app.group || '占位描述')));
    const link = app.entry || app.path;
    if (link) {
      const anchor = makeEl('a', 'y-module-apps-grid-card-link', '打开（占位）');
      anchor.href = String(link);
      card.append(anchor);
    }
    gridNode.append(card);
  }
  statusNode.textContent = `共 ${apps.length} 项，显示 ${visible.length} 项（占位渲染）`;
}

async function refresh(ctx) {
  try {
    apps = normalizeApps(await emit(ctx, 'apps:list', {}));
  } catch (err) {
    apps = [];
    report(ctx, 'E_SCHEMA', '读取应用清单失败', err);
  }
  try {
    const orderValue = await emit(ctx, 'storage:get', { path: ORDER_PATH, fallback: [] });
    apps = applyOrder(apps, normalizeOrder(orderValue));
  } catch (err) {
    report(ctx, 'E_VFS_BACKEND', '读取应用排序失败', err);
  }
  render();
}

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    try {
      buildUi();
      await mountSelf(ctx, rootNode, SLOT_NAMES);
      render();
      await refresh(ctx);

      // 排序文件（或整个 /shared/apps 前缀）失效即刷新，不做轮询。
      await on(ctx, 'storage:invalidate', (payload) => {
        try {
          const prefix = payload && payload.prefix ? String(payload.prefix) : '';
          if (!prefix || prefix.startsWith('/shared/apps') || prefix === ORDER_PATH) void refresh(ctx);
        } catch (err) {
          report(ctx, 'E_SCHEMA', '处理存储失效广播失败', err);
        }
      });
      // 搜索模块的本地过滤事件（§5：SearchModule → AppsGrid）。
      await on(ctx, 'search:filter', (payload) => {
        try {
          filterQuery = payload && typeof payload.query === 'string' ? payload.query : '';
          render();
        } catch (err) {
          report(ctx, 'E_SCHEMA', '处理搜索过滤失败', err);
        }
      });
      // 清单重载事件（管理面板 / 服务触发）。
      await on(ctx, 'apps:reload', () => {
        void refresh(ctx);
      });
    } catch (err) {
      report(ctx, 'E_MODULE_INIT', '应用网格初始化失败', err);
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
      if (ctx) report(ctx, 'E_MODULE_INIT', '应用网格销毁失败', err);
      else console.error('[yingo] 应用网格销毁失败（通知中心不可用）', err);
    } finally {
      rootNode = null;
      gridNode = null;
      statusNode = null;
      apps = [];
      filterQuery = '';
      ctxRef = null;
    }
  }
};
