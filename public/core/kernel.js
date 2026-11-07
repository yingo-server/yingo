/**
 * kernel.js — 启动序列与生命周期（Linux initcall 风格）
 *
 * 严格按 stages.js 的 0→8 顺序推进；每阶段：
 *   before 钩子 → 执行器 → after 钩子 → 记录 timeline；
 *   error 钩子 → 统一通知 → 按失败策略决定阻断或降级。
 * 单模块/插件失败只隔离 + 通知，不阻断启动。
 */

import { STAGES, runHooks, listHooks } from './stages.js';
import { emit, emitSync, initBus, on, reportError, getEventLog } from './bus.js';
import { registerService, getService, listServices } from './service-registry.js';
import { registerSlot, defineModule, definePlugin, listModules, createModuleContext, setModuleState, getModule as getModuleSafe } from './module-api.js';
import { initNotification, push as notifyPush, setStorageMetrics } from './notification.js';
import { initStorage, getStorageMetrics, getVfs as getVfsInstance, shutdownStorage } from './storage/storage-service.js';
import { initConfigService } from './config-service.js';
import { initAppServices } from './app-services.js';
import { makeError, serializeError, normalizeError, E } from './errors.js';

const timeline = [];
const bootReport = {
  startedAt: 0, finishedAt: 0, ready: false,
  stages: timeline, modules: [], plugins: [], hooks: [], degraded: [],
};

/**
 * @param {Object} options
 * @param {Object} options.config       公开配置（bootloader 阶段注入）
 * @param {Array}  options.modules      [{ id, manifest, factory }] 静态 import 的内置模块
 * @param {Array}  options.themes       主题模块（level 4）
 * @param {Object} options.layouts      布局模块（level 8 挂载）
 * @param {Array}  options.plugins       [{ id, entry, manifest }] 动态 import 外挂
 * @param {boolean} options.strict      严格模式下任一阶段失败即中止
 */
export async function boot(options = {}) {
  bootReport.startedAt = Date.now();
  initBus();
  emitSync('system:boot', { options: { strict: !!options.strict } });

  for (const stage of STAGES) {
    const t0 = performance.now();
    const rec = { level: stage.level, stage: stage.name, label: stage.label, status: 'running', t0, modules: [] };
    timeline.push(rec);
    await runHooks('before', stage.name, rec);
    try {
      await executeStage(stage, options, rec);
      rec.status = 'ok';
    } catch (err) {
      const e = normalizeError(err, E.E_BOOT_STAGE);
      rec.status = 'error';
      rec.error = serializeError(e);
      await runHooks('error', stage.name, { ...rec, error: e });
      await reportError(e.code, e.message, {
        stage: stage.name, module: e.detail?.module || '', detail: serializeError(e),
      }, e);
      if (isFatal(stage, options)) {
        rec.status = 'fatal';
        bootReport.ready = false;
        bootReport.finishedAt = Date.now();
        await publishSnapshot();
        throw e;
      }
      bootReport.degraded.push({ stage: stage.name, code: e.code });
      rec.status = 'degraded';
    } finally {
      rec.t1 = performance.now();
      rec.durationMs = Number((rec.t1 - t0).toFixed(2));
      await runHooks('after', stage.name, rec);
    }
  }

  bootReport.ready = true;
  bootReport.finishedAt = Date.now();
  bootReport.hooks = listHooks();
  await emit('system:ready', { timeline: timeline.map((x) => ({ ...x })) });
  await publishSnapshot();
  return bootReport;
}

function isFatal(stage, options) {
  if (options.strict) return true;
  return stage.level <= 1;      // bootloader / core 致命；其余可降级
}

/* ---------------- 各阶段执行器 ---------------- */

async function executeStage(stage, options, rec) {
  switch (stage.name) {
    case 'bootloader': return stageBootloader(options, rec);
    case 'core': return stageCore(options, rec);
    case 'storage': return stageStorage(options, rec);
    case 'diagnostics': return stageDiagnostics(options, rec);
    case 'theme': return stageTheme(options, rec);
    case 'services': return stageServices(options, rec);
    case 'modules': return stageModules(options, rec);
    case 'plugins': return stagePlugins(options, rec);
    case 'userland': return stageUserland(options, rec);
    default: throw makeError(E.E_BOOT_STAGE, `未实现阶段 ${stage.name}`);
  }
}

function stageBootloader(options, rec) {
  const url = new URL(location.href);
  const flags = {
    strict: url.searchParams.has('strict'),
    theme: url.searchParams.get('theme'),
    diag: url.searchParams.has('diag'),
    noPlugins: url.searchParams.has('no-plugins'),
  };
  const root = document.getElementById('yingo-root') || document.body;
  registerSlot('root', root);
  registerService('config', options.config || {}, 'kernel');
  registerService('flags', flags, 'kernel');
  rec.modules.push('config', 'flags', 'slot:root');
}

function stageCore(options, rec) {
  registerService('bus', { emit, on }, 'kernel');
  registerService('errors', { E }, 'kernel');
  // 预注册命名插槽：框架只提供容器，模块自决挂载点（ADR-005）。
  // 布局模块（Level 8）可覆写这些插槽，但不改变「模块自决」原则。
  const root = document.getElementById('yingo-root') || document.body;
  const overlay = makeOverlay();
  registerSlot('overlay', overlay);
  // 主内容流
  for (const name of ['topbar', 'search', 'apps', 'music', 'theme']) {
    const n = document.createElement('section');
    n.className = `yingo-slot yingo-slot--${name}`;
    n.dataset.slot = name;
    root.appendChild(n);
    registerSlot(name, n);
  }
  // 工具/管理抽屉：默认折叠，由布局模块或管理面板展开
  const drawer = document.createElement('aside');
  drawer.className = 'yingo-slot yingo-slot--drawer';
  drawer.dataset.slot = 'drawer';
  drawer.setAttribute('data-collapsed', 'true');
  root.appendChild(drawer);
  for (const name of ['admin', 'settings', 'panel', 'drawer', 'sidebar', 'main']) {
    registerSlot(name, drawer);
  }
  // 抽屉开关：放顶栏内（时钟左侧），避免与音乐坞/搜索卡等悬浮元素冲突
  const toggle = document.createElement('button');
  toggle.id = 'yingo-drawer-toggle';
  toggle.type = 'button';
  toggle.className = 'yingo-drawer-toggle glass';
  toggle.setAttribute('aria-label', '打开管理面板');
  toggle.setAttribute('aria-expanded', 'false');
  toggle.textContent = '⚙';
  toggle.addEventListener('click', () => {
    const open = drawer.getAttribute('data-collapsed') === 'false';
    drawer.setAttribute('data-collapsed', open ? 'true' : 'false');
    toggle.setAttribute('aria-expanded', String(!open));
    toggle.textContent = open ? '⚙' : '✕';
  });
  const topbarSlot = root.querySelector?.('.yingo-slot--topbar');
  (topbarSlot || root).appendChild(toggle);
  rec.modules.push('bus', 'errors', 'slot:overlay', 'slot:topbar/search/apps/music/theme', 'slot:drawer(admin/settings/panel/sidebar/main)');
}

function makeOverlay() {
  let n = document.getElementById('yingo-overlay');
  if (!n) {
    n = document.createElement('div');
    n.id = 'yingo-overlay';
    (document.getElementById('yingo-root') || document.body).appendChild(n);
  }
  return n;
}

async function stageStorage(options, rec) {
  const report = await initStorage();
  registerService('storage', {
    getMetrics: getStorageMetrics,
    getVfs: () => getService('vfs'),
  }, 'kernel');
  registerService('vfs', getVfsInstance(), 'kernel');
  // 诊断面板同时拿到指标与分区占用
  const usage = await getVfsInstance().usage('/').catch(() => ({}));
  setStorageMetrics({ ...report.metrics, zones: usage.zones, totalSize: usage.totalSize, entryCount: usage.count });
  rec.modules.push('vfs:memory', 'vfs:localstorage', 'vfs:indexeddb', ...report.schemas.map((s) => s.name));
  if (report.degraded.length) bootReport.degraded.push({ stage: 'storage', backends: report.degraded });
}

function stageDiagnostics(options, rec) {
  initNotification();
  registerService('notification', { push: notifyPush }, 'kernel');
  rec.modules.push('notification', 'diagnostics');
}

async function stageTheme(options, rec) {
  const themes = options.themes || [];
  for (const t of themes) {
    try {
      defineModule(t.manifest);
      const ctx = createModuleContext(t.manifest);
      await t.factory.init(ctx);
      setModuleState(t.manifest.id, 'ready');
      rec.modules.push(`theme:${t.manifest.id}`);
    } catch (err) {
      await isolate(t.manifest?.id || 'theme', 'theme', err);
    }
  }
  // 读取持久化主题并应用
  const saved = await emit('storage:get', { path: '/shared/theme/current.json', fallback: null }).catch(() => null);
  const id = getService('flags').theme || saved?.id || options.config?.themes?.default || 'material-3';
  await emit('theme:apply', { id }).catch(() => {});
}

async function stageServices(options, rec) {
  registerService('commands', () => import('./bus.js').then((m) => m.getCommands()), 'kernel');
  // 配置服务（config:get / config:set）
  initConfigService(options.config || {});
  // 应用/音乐/主题/模块服务（apps:list、music:list、theme:apply ...）
  initAppServices({
    themes: (options.themes || []).map((t) => t.manifest?.id).filter(Boolean),
  });
  // 主题服务定位别名：模块可 ctx.getService('theme') 取命令式接口
  registerService('theme', {
    list: () => emit('theme:list', {}),
    apply: (id) => emit('theme:apply', { id }),
    setBackground: (p) => emit('theme:bg-set', p),
  }, 'kernel');
  // 清单镜像写入 /system/*（来自预引导缓存/网络，代码侧零额外请求）
  for (const [name, data, path] of [
    ['registry', options.registry, '/system/registry.json'],
    ['music', options.music, '/system/music.json'],
  ]) {
    if (data && typeof data === 'object') {
      try {
        await emit('storage:set', { path, value: data, schema: 'manifest-mirror@1' });
        rec.modules.push(`mirror:${name}`);
      } catch { /* 镜像失败不阻断 */ }
    } else {
      // 回退：尝试从静态路径读取（Netlify 无函数时的兼容路径）
      try {
        const res = await fetch(`/${name}.json`, { cache: 'default' });
        if (res.ok) {
          await emit('storage:set', { path, value: await res.json(), schema: 'manifest-mirror@1' });
          rec.modules.push(`mirror:${name}`);
        }
      } catch { /* 清单缺失不阻断，函数侧会兜底 */ }
    }
  }
  rec.modules.push('config-service', 'apps-service', 'music-service', 'theme-service', 'module-service');
}

async function stageModules(options, rec) {
  for (const m of options.modules || []) {
    if (!m || !m.manifest) continue;
    try {
      defineModule(m.manifest);
      const ctx = createModuleContext(m.manifest);
      m._ctx = ctx;
      await m.factory.init(ctx);
      setModuleState(m.manifest.id, 'ready');
      rec.modules.push(m.manifest.id);
      bootReport.modules.push({ id: m.manifest.id, state: 'ready' });
    } catch (err) {
      await isolate(m.manifest.id, 'module', err);
    }
  }
}

async function stagePlugins(options, rec) {
  if (getService('flags').noPlugins) { rec.modules.push('(skipped)'); return; }
  const list = options.plugins || [];
  for (const p of list) {
    try {
      const mod = await import(p.entry);
      const factory = mod.default || mod;
      const manifest = { ...(p.manifest || {}), id: p.id || p.manifest?.id, layout: 'self-decided', kind: 'plugin' };
      definePlugin(manifest);
      const ctx = createModuleContext(manifest);
      await factory.init?.(ctx);
      setModuleState(manifest.id, 'ready');
      rec.modules.push(`plugin:${manifest.id}`);
      bootReport.plugins.push({ id: manifest.id, state: 'ready' });
    } catch (err) {
      await isolate(p.id || p.manifest?.id || 'unknown', 'plugin', err);
    }
  }
}

async function stageUserland(options, rec) {
  const layouts = options.layouts || [];
  for (const l of layouts) {
    try {
      const ctx = createModuleContext({ ...l.manifest, kind: 'module' });
      await l.factory.init?.(ctx);
      rec.modules.push(`layout:${l.manifest.id}`);
    } catch (err) { await isolate(l.manifest?.id || 'layout', 'layout', err); }
  }
  // 渐进模式下 /tmp/* 由后台加载阶段结束后再清，此处跳过
  if (!options.progressive) {
    await emit('storage:clear', { prefix: '/tmp/', scope: 'session' }).catch(() => {});
  }
}

async function isolate(id, kind, err) {
  const e = normalizeError(err, kind === 'plugin' ? E.E_PLUGIN_LOAD : E.E_MODULE_INIT);
  setModuleState(id, 'failed', { error: serializeError(e) });
  bootReport.modules.push({ id, state: 'failed', code: e.code });
  await reportError(e.code, `${kind} ${id} 初始化失败: ${e.message}`, {
    stage: kind === 'plugin' ? 'plugins' : 'modules', module: id, detail: serializeError(e),
  }, e);
}

/**
 * mountDeferred — 渐进加载阶段 B 的热注册入口
 * 内核已经 boot() 完成后再加载的模块，走同一套 defineModule/createModuleContext/init，
 * 并追加到 boot timeline 的 userland 记录里，诊断面板可见。
 */
export async function mountDeferred(entry, kind = 'module') {
  if (!entry || !entry.manifest?.id) return false;
  const id = entry.manifest.id;
  try {
    const manifest = { ...entry.manifest, layout: 'self-decided', kind: kind === 'plugin' ? 'plugin' : 'module' };
    // 占位模块重试时可能已注册，先允许幂等
    if (!getModuleSafe(id)) {
      if (kind === 'plugin') definePlugin(manifest);
      else defineModule(manifest);
    }
    const ctx = createModuleContext(manifest);
    await entry.factory?.init?.(ctx);
    setModuleState(id, 'ready', { deferred: true });
    const rec = timeline.find((s) => s.stage === 'userland');
    if (rec) rec.modules.push(`${kind}:${id}`);
    bootReport.modules.push({ id, state: 'ready', deferred: true });
    await publishSnapshot();   // 刷新 __YINGO_BOOT__
    return true;
  } catch (err) {
    const e = normalizeError(err, E.E_MODULE_INIT);
    setModuleState(id, 'failed', { error: serializeError(e) });
    await reportError(e.code, `延迟加载 ${id} 失败: ${e.message}`, {
      stage: 'userland', module: id, detail: serializeError(e),
    }, e);
    return false;
  }
}

/** 只读快照，供 devtools 与诊断 */
async function publishSnapshot() {
  const snapshot = Object.freeze({
    ready: bootReport.ready,
    startedAt: bootReport.startedAt,
    finishedAt: bootReport.finishedAt,
    timeline: timeline.map((x) => ({ ...x })),
    modules: listModules().map((m) => ({ id: m.id, kind: m.kind, level: m.level, state: m.state, deferred: !!m.deferred })),
    services: listServices(),
    hooks: listHooks(),
    events: getEventLog().slice(-100),
    storage: getStorageMetrics(),
  });
  Object.defineProperty(window, '__YINGO_BOOT__', {
    value: snapshot, writable: false, configurable: true, enumerable: false,
  });
  return snapshot;
}

export function getBootTimeline() { return timeline.map((x) => ({ ...x })); }
export function getBootReport() { return { ...bootReport }; }
export async function shutdown() {
  await shutdownStorage();
  registerSlot; // no-op to keep tree-shaking friendly
}
