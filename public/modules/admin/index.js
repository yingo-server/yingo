// 管理面板壳（§11 / §12-8）：四个功能分区 + Storage VFS 文件浏览器组件。
// 不做真实应用 CRUD、主题渲染、插件启停算法；所有动作只发总线命令，异常统一通知。
// 布局自决（ADR-005）：模块内部选择挂载插槽，不依赖任何 DOM id。

import { createStorageBrowser } from './storage-browser.js';

const MODULE_ID = 'admin';
const SLOT_NAMES = ['admin', 'drawer', 'settings', 'panel', 'main'];
const ENABLED_PATH = '/module/admin/enabled.json'; // §8.4：模块启用状态属 admin 私有区

let ctxRef = null;
let rootNode = null;
let navNode = null;
let contentNode = null;
let storageBrowser = null;
const sections = new Map();
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
  for (const err of errors) report(ctx, 'E_MODULE_INIT', '管理面板挂载插槽失败，已使用自取容器', err);
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

/** 应用管理：用户级覆盖层（隐藏/排序/自定义链接），不改仓库 app.json */
const APPS_OVERLAY = '/shared/apps/overlay.json';

function buildAppsSection(ctx) {
  const el = makeEl('section', 'y-admin-section');
  el.dataset.sectionId = 'apps';
  el.append(makeEl('h3', '', '应用管理'));
  el.append(makeEl('p', 'y-admin-hint', '此处改动只作用于本机（用户级覆盖层），不修改仓库 app.json。'));

  const appList = makeEl('ul', 'y-admin-apps-list');
  el.append(appList);

  async function readOverlay() {
    try {
      const v = await emit(ctx, 'storage:get', { path: APPS_OVERLAY, fallback: {} });
      return v && typeof v === 'object' ? v : {};
    } catch (err) { report(ctx, 'E_VFS_BACKEND', '读取应用覆盖层失败', err); return {}; }
  }
  async function writeOverlay(v) {
    try { await emit(ctx, 'storage:set', { path: APPS_OVERLAY, value: v, schema: 'user-config@1' }); }
    catch (err) { report(ctx, 'E_VFS_BACKEND', '保存应用覆盖层失败', err); }
  }

  async function load() {
    try {
      const result = await emit(ctx, 'apps:list', {});
      const apps = Array.isArray(result) ? result : (result && Array.isArray(result.apps) ? result.apps : []);
      const overlay = await readOverlay();
      appList.replaceChildren();
      if (!apps.length) appList.append(makeEl('li', '', '（暂无应用：把 app.json 放入 public/apps/<slug>/ 后重跑 gen-manifest.mjs）'));
      for (const app of apps) {
        const li = makeEl('li', 'y-admin-app-row');
        const label = makeEl('label', 'y-admin-app-label');
        const cb = makeEl('input'); cb.type = 'checkbox';
        cb.checked = !(overlay[app.id] && overlay[app.id].hidden);
        cb.addEventListener('change', async () => {
          const o = await readOverlay();
          o[app.id] = { ...(o[app.id] || {}), hidden: !cb.checked };
          await writeOverlay(o);
          await emit(ctx, 'apps:reload', {}).catch(() => {});
          ctx.notify('info', `${app.name || app.id} 已${cb.checked ? '显示' : '隐藏'}`, { module: MODULE_ID });
        });
        label.append(cb, document.createTextNode(` ${app.name || app.id} · ${app.group || 'other'}`));
        li.append(label);
        const up = makeEl('button', '', '↑'); up.type = 'button'; up.title = '上移';
        const down = makeEl('button', '', '↓'); down.type = 'button'; down.title = '下移';
        const move = async (dir) => {
          const ids = apps.map((a) => String(a.id));
          const i = ids.indexOf(String(app.id)), j = i + dir;
          if (j < 0 || j >= ids.length) return;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          try { await emit(ctx, 'storage:set', { path: '/shared/apps/order.json', value: ids, schema: 'apps-order@1' }); }
          catch (err) { report(ctx, 'E_VFS_BACKEND', '保存排序失败', err); }
          await emit(ctx, 'storage:invalidate', { prefix: '/shared/apps/order.json', reason: 'admin:reorder' }).catch(() => {});
          await load();
        };
        up.addEventListener('click', () => move(-1));
        down.addEventListener('click', () => move(1));
        li.append(up, down);
        appList.append(li);
      }
    } catch (err) { report(ctx, 'E_SCHEMA', '读取应用清单失败', err); }
  }
  const reload = makeEl('button', '', '重新载入清单');
  reload.type = 'button';
  reload.addEventListener('click', async () => {
    try { await emit(ctx, 'apps:reload', {}); await load(); ctx.notify('info', '清单已重载', { module: MODULE_ID }); }
    catch (err) { report(ctx, 'E_SCHEMA', '重载失败', err); }
  });
  el.append(reload);
  void load();
  return el;
}

function buildThemeSection(ctx) {
  const el = makeEl('section', 'y-admin-section');
  el.dataset.sectionId = 'theme';
  el.append(makeEl('h3', '', '主题与外观'));

  const themeList = makeEl('div', 'y-admin-theme-list');
  el.append(themeList);
  void (async () => {
    try {
      const r = await emit(ctx, 'theme:list', {});
      const themes = Array.isArray(r) ? r : (r && Array.isArray(r.themes) ? r.themes : []);
      themeList.replaceChildren();
      for (const t of themes) {
        const id = typeof t === 'string' ? t : t.id;
        const btn = makeEl('button', '', `切换到 ${id || '?'}`);
        btn.type = 'button';
        btn.addEventListener('click', async () => {
          try { await emit(ctx, 'theme:apply', { id }); ctx.notify('info', `已切换主题 ${id}`, { module: MODULE_ID }); }
          catch (err) { report(ctx, 'E_SCHEMA', '主题切换失败', err); }
        });
        themeList.append(btn);
      }
      if (!themes.length) themeList.append(makeEl('p', '', '（主题服务未返回清单）'));
    } catch (err) { report(ctx, 'E_SCHEMA', '读取主题清单失败', err); }
  })();

  const bgForm = makeEl('form', 'y-admin-theme-bg-form');
  const url = makeEl('input'); url.placeholder = '背景图 URL（或 /assets/images/…）';
  const blur = makeEl('input'); blur.type = 'number'; blur.min = '0'; blur.max = '60'; blur.value = '18';
  const tint = makeEl('input'); tint.placeholder = 'rgba(0,0,0,.25)'; tint.value = 'rgba(6,18,10,.55)';
  const radius = makeEl('input'); radius.type = 'number'; radius.min = '0'; radius.max = '48'; radius.value = '22';
  const file = makeEl('input'); file.type = 'file'; file.accept = 'image/*';
  const submit = makeEl('button', '', '应用外观'); submit.type = 'submit';
  bgForm.append(makeEl('label', '', '背景 URL'), url,
    makeEl('label', '', '或上传本地图片'), file,
    makeEl('label', '', '模糊 px'), blur,
    makeEl('label', '', '色调'), tint,
    makeEl('label', '', '圆角 px'), radius, submit);
  bgForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    let bgUrl = url.value.trim();
    // 本地上传：读为 data URL 存入 VFS（纯本地，不落仓库、不上传远端）
    if (!bgUrl && file.files && file.files[0]) {
      try { bgUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej;
        r.readAsDataURL(file.files[0]);
      }); } catch (err) { report(ctx, 'E_VFS_EXPORT', '读取图片失败', err); return; }
    }
    if (!bgUrl) { ctx.notify('warn', '请填写背景 URL 或选择图片', { module: MODULE_ID }); return; }
    try {
      await emit(ctx, 'theme:bg-set', { url: bgUrl, blur: Number(blur.value) || 0, tint: tint.value });
      document.documentElement.style.setProperty('--yingo-radius-lg', `${Number(radius.value) || 0}px`);
      await emit(ctx, 'storage:set', {
        path: '/shared/theme/appearance.json',
        value: { url: bgUrl, blur: Number(blur.value) || 0, tint: tint.value, radius: Number(radius.value) || 0 },
        schema: 'theme-bg@1',
      }).catch(() => {});
      ctx.notify('info', '外观已应用', { module: MODULE_ID });
    } catch (err) { report(ctx, 'E_SCHEMA', '外观设置失败', err); }
  });
  el.append(bgForm);
  return el;
}

function buildModulesSection(ctx) {
  const el = makeEl('section', 'y-admin-section');
  el.dataset.sectionId = 'modules';
  el.append(makeEl('h3', '', '模块管理'));
  el.append(makeEl('p', 'y-admin-hint', '显示各模块启动阶段 / 状态；外挂可启停，内置核心模块不可禁用。'));

  const moduleList = makeEl('ul', 'y-admin-module-list');
  el.append(moduleList);
  const refresh = makeEl('button', '', '刷新模块清单');
  refresh.type = 'button';
  el.append(refresh);

  async function loadModules() {
    try {
      const result = await emit(ctx, 'module:list', {});
      const modules = Array.isArray(result) ? result : result && Array.isArray(result.modules) ? result.modules : [];
      let enabled = [];
      try {
        const saved = await emit(ctx, 'storage:get', { path: ENABLED_PATH, fallback: [] });
        enabled = Array.isArray(saved) ? saved : saved && Array.isArray(saved.ids) ? saved.ids : [];
      } catch (err) {
        report(ctx, 'E_VFS_BACKEND', '读取模块启用状态失败', err);
      }
      moduleList.replaceChildren();
      for (const mod of modules) {
        const id = typeof mod === 'string' ? mod : mod.id;
        const li = makeEl('li', '', `${id || '?'} · level ${mod && mod.level != null ? mod.level : '—'}`);
        const toggle = makeEl('button', '', enabled.includes(id) ? '停用' : '启用');
        toggle.type = 'button';
        toggle.addEventListener('click', () => {
          void (async () => {
            try {
              // 发强类型命令 + 持久化用户级启用状态；重启后由 Kernel 应用。
              await emit(ctx, 'module:toggle', { id, enabled: !enabled.includes(id) });
              await emit(ctx, 'storage:set', { path: ENABLED_PATH, value: { ids: enabled.includes(id) ? enabled.filter((x) => x !== id) : [...enabled, id] }, schema: 'module-state@1' });
              await loadModules();
            } catch (err) {
              report(ctx, 'E_SCHEMA', '模块启停失败', err);
            }
          })();
        });
        li.append(toggle);
        const diag = makeEl('button', '', '诊断');
        diag.type = 'button';
        diag.addEventListener('click', () => {
          void emit(ctx, 'module:diag', { id }).catch((err) => report(ctx, 'E_SCHEMA', '模块诊断失败', err));
        });
        li.append(diag);
        moduleList.append(li);
      }
      if (!modules.length) moduleList.append(makeEl('li', '', '（模块服务未返回清单）'));
    } catch (err) {
      report(ctx, 'E_SCHEMA', '读取模块清单失败', err);
    }
  }
  refresh.addEventListener('click', () => {
    void loadModules();
  });
  void loadModules();
  return el;
}

function buildDataSection(ctx) {
  const el = makeEl('section', 'y-admin-section');
  el.dataset.sectionId = 'data';
  el.append(makeEl('h3', '', '数据与清理'));
  const actions = makeEl('div', 'y-admin-data-actions');
  const btnExport = makeEl('button', '', '导出备份 .json'); btnExport.type = 'button';
  const btnImport = makeEl('button', '', '导入备份'); btnImport.type = 'button';
  const fileInput = makeEl('input'); fileInput.type = 'file'; fileInput.accept = '.json,application/json'; fileInput.hidden = true;
  const btnGc = makeEl('button', '', '一键 GC'); btnGc.type = 'button';
  const btnClearCache = makeEl('button', '', '清理 /cache'); btnClearCache.type = 'button';
  const btnReset = makeEl('button', '', '重置全部'); btnReset.type = 'button';
  const dataStatus = makeEl('p', 'y-admin-hint', '');
  actions.append(btnExport, btnImport, fileInput, btnGc, btnClearCache, btnReset);
  el.append(actions, dataStatus);

  btnExport.addEventListener('click', async () => {
    try {
      const pkg = await emit(ctx, 'storage:export', { prefixes: ['/shared/', '/module/', '/plugin/', '/cache/'] });
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: 'application/json' });
      const a = makeEl('a'); a.href = URL.createObjectURL(blob);
      a.download = `yingo-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
      dataStatus.textContent = `已导出 ${pkg.entries?.length || 0} 个条目`;
    } catch (err) { report(ctx, 'E_VFS_EXPORT', '导出备份失败', err); }
  });
  btnImport.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files && fileInput.files[0]; if (!f) return;
    try {
      const payload = JSON.parse(await f.text());
      const preview = await emit(ctx, 'storage:import', { payload, dryRun: true });
      const conflicts = preview?.conflicts?.length || 0;
      if (conflicts && !confirm(`将覆盖 ${conflicts} 个已有条目，继续？`)) { dataStatus.textContent = '导入已取消'; return; }
      const r = await emit(ctx, 'storage:import', { payload, dryRun: false });
      dataStatus.textContent = `导入完成：写入 ${r?.written ?? 0}，跳过 ${r?.invalid?.length ?? 0}`;
      ctx.notify('info', '备份导入完成', { module: MODULE_ID });
    } catch (err) { report(ctx, 'E_VFS_EXPORT', '导入备份失败', err); }
    finally { fileInput.value = ''; }
  });
  btnGc.addEventListener('click', async () => {
    try { const n = await emit(ctx, 'storage:gc', {}); dataStatus.textContent = `GC 清理 ${n} 个过期条目`; }
    catch (err) { report(ctx, 'E_VFS_EXPORT', 'GC 失败', err); }
  });
  btnClearCache.addEventListener('click', async () => {
    if (!confirm('清理 /cache 与 /tmp 全部条目？')) return;
    try { await emit(ctx, 'storage:clear', { prefix: '/cache/' }); await emit(ctx, 'storage:clear', { prefix: '/tmp/' }); dataStatus.textContent = '缓存已清理'; }
    catch (err) { report(ctx, 'E_VFS_EXPORT', '清理失败', err); }
  });
  btnReset.addEventListener('click', async () => {
    if (!confirm('重置全部本地数据（/shared、/cache、/tmp、模块私有区）？建议先导出备份。')) return;
    try {
      for (const p of ['/shared/', '/cache/', '/tmp/']) await emit(ctx, 'storage:clear', { prefix: p });
      dataStatus.textContent = '已重置，刷新页面后生效';
      ctx.notify('info', '本地数据已重置', { module: MODULE_ID });
    } catch (err) { report(ctx, 'E_VFS_EXPORT', '重置失败', err); }
  });

  // 文件浏览器组件单独放在 storage-browser.js，这里只负责嵌入与生命周期。
  storageBrowser = createStorageBrowser(ctx);
  el.append(storageBrowser.el);
  return el;
}

function buildUi(ctx) {
  rootNode = makeEl('details', 'y-module y-module-admin');
  rootNode.dataset.moduleId = MODULE_ID;
  rootNode.append(makeEl('summary', '', '管理面板'));

  navNode = makeEl('nav', 'y-admin-nav');
  contentNode = makeEl('div', 'y-admin-content');

  const builders = [
    ['apps', '应用管理', buildAppsSection],
    ['theme', '主题与外观', buildThemeSection],
    ['modules', '模块管理', buildModulesSection],
    ['data', '数据与清理', buildDataSection]
  ];
  for (const [id, label, builder] of builders) {
    const btn = makeEl('button', 'y-admin-nav-item', label);
    btn.type = 'button';
    btn.dataset.sectionId = id;
    btn.addEventListener('click', () => showSection(id));
    navNode.append(btn);
    try {
      sections.set(id, builder(ctx));
    } catch (err) {
      report(ctx, 'E_MODULE_INIT', `构建分区 ${id} 失败`, err);
      sections.set(id, makeEl('section', 'y-admin-section y-admin-section-error', '分区构建失败（见通知中心）'));
    }
  }
  rootNode.append(navNode, contentNode);
  showSection('apps');
}

function showSection(id) {
  try {
    if (!contentNode) return;
    contentNode.replaceChildren(sections.get(id) || sections.get('apps'));
    if (navNode) {
      for (const btn of navNode.querySelectorAll('.y-admin-nav-item')) {
        if (btn.dataset.sectionId === id) btn.setAttribute('aria-current', 'true');
        else btn.removeAttribute('aria-current');
      }
    }
  } catch (err) {
    if (ctxRef) report(ctxRef, 'E_MODULE_INIT', '切换管理分区失败', err);
    else console.error('[yingo] 切换管理分区失败（通知中心不可用）', err);
  }
}

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    try {
      buildUi(ctx);
      await mountSelf(ctx, rootNode, SLOT_NAMES);

      // 失效广播由 storage-browser.js 组件自行订阅并刷新文件树；
      // 四个分区的数据只在初始化 / 用户点击时读取，不做轮询、不发正常信息通知。

    } catch (err) {
      report(ctx, 'E_MODULE_INIT', '管理面板初始化失败', err);
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
      if (storageBrowser) storageBrowser.destroy();
      storageBrowser = null;
      sections.clear();
      if (rootNode && rootNode.parentNode) rootNode.parentNode.removeChild(rootNode);
    } catch (err) {
      if (ctx) report(ctx, 'E_MODULE_INIT', '管理面板销毁失败', err);
      else console.error('[yingo] 管理面板销毁失败（通知中心不可用）', err);
    } finally {
      rootNode = null;
      navNode = null;
      contentNode = null;
      ctxRef = null;
    }
  }
};
