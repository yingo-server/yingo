/**
 * notification.js — 统一通知中心 + 可展开诊断面板（ADR-008）
 * 取代朴素 toast：轻量消息短条呈现；启动/模块异常进诊断面板。
 * 本模块只订阅总线命令，不反向依赖 Kernel。
 */

import { on, emit, onReplay, getEventLog, getCommands } from './bus.js';
import { serializeError, E } from './errors.js';

const MAX_ITEMS = 200;
const items = [];                 // { id, level, message, detail, at, read }
const listeners = new Set();
let panelRoot = null;
let trayRoot = null;
let diagRoot = null;
let seq = 0;

const LEVELS = ['debug', 'info', 'warn', 'error'];

export function initNotification() {
  on('notify:push', ({ level, message, detail }) => push(level, message, detail));
  on('system:error', ({ code, stage, module, detail }) => {
    push('error', `[${code}] ${stage || ''}${module ? ' / ' + module : ''}`, { code, stage, module, detail });
  });
  onReplay((entry) => {
    if (entry.status === 'error') push('warn', `命令失败: ${entry.command}`, entry.error);
  });
  // 结构自带，不依赖任何模块挂载位置
  ensureRoots();
  subscribeBootTimeline();
  return { push, destroy, getItems: () => items.map((x) => ({ ...x })) };
}

async function subscribeBootTimeline() {
  // 启动时间线由 kernel 写入，这里通过 system:ready 拉取一次
  on('system:ready', ({ timeline }) => {
    bootTimeline = Array.isArray(timeline) ? timeline : [];
    renderDiagnostics();
  });
}
let bootTimeline = [];

export function push(level, message, detail = {}) {
  const lvl = LEVELS.includes(level) ? level : 'info';
  const item = {
    id: ++seq, level: lvl, message: String(message),
    detail: serializeDetail(detail), at: Date.now(), read: false,
  };
  items.push(item);
  if (items.length > MAX_ITEMS) items.shift();
  emitToListeners();
  renderTray();
  renderDiagnostics();
  return item;
}

function serializeDetail(d) {
  try { return JSON.parse(JSON.stringify(d ?? {})); }
  catch { return { note: 'detail 不可序列化' }; }
}

export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
function emitToListeners() { for (const f of listeners) { try { f([...items]); } catch { /* noop */ } } }

export function getItems() { return items.map((x) => ({ ...x })); }
export function clear() { items.length = 0; emitToListeners(); renderTray(); renderDiagnostics(); }

/* ---------------- DOM ---------------- */

function ensureRoots() {
  if (panelRoot) return;
  ensureStyles();
  const host = document.getElementById('yingo-root') || document.body;

  trayRoot = el('div', 'yingo-notify-tray');
  trayRoot.setAttribute('role', 'status');
  trayRoot.setAttribute('aria-live', 'polite');
  host.appendChild(trayRoot);

  panelRoot = el('div', 'yingo-diagnostics');
  panelRoot.hidden = true;
  panelRoot.innerHTML = `
    <header class="yingo-diag-head">
      <strong>诊断中心</strong>
      <div class="yingo-diag-actions">
        <button type="button" data-act="clear">清空</button>
        <button type="button" data-act="copy">复制日志</button>
        <button type="button" data-act="close">关闭</button>
      </div>
    </header>
    <div class="yingo-diag-body">
      <section><h4>启动时间线</h4><div data-pane="boot"></div></section>
      <section><h4>总线命令</h4><div data-pane="commands"></div></section>
      <section><h4>事件日志</h4><div data-pane="events"></div></section>
      <section><h4>Storage Fabric</h4><div data-pane="storage"></div></section>
      <section><h4>通知与异常</h4><div data-pane="items"></div></section>
    </div>`;
  host.appendChild(panelRoot);
  panelRoot.addEventListener('click', onPanelClick);

  diagRoot = el('button', 'yingo-diag-toggle');
  diagRoot.type = 'button';
  diagRoot.textContent = '● 诊断';
  diagRoot.addEventListener('click', () => { panelRoot.hidden = !panelRoot.hidden; renderDiagnostics(); });
  host.appendChild(diagRoot);
}

function el(tag, cls) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

/** 样式由 index.html 直接 link；此处仅保证降级场景（模块单独被引用）不裸奔 */
function ensureStyles() {
  if (document.querySelector('link[href*="notification.css"]')) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = new URL('./notification.css', import.meta.url).href;
  (document.head || document.body).appendChild(link);
}

function onPanelClick(ev) {
  const act = ev.target?.dataset?.act;
  if (act === 'close') panelRoot.hidden = true;
  if (act === 'clear') clear();
  if (act === 'copy') {
    const text = JSON.stringify({ boot: bootTimeline, items, events: getEventLog() }, null, 2);
    navigator.clipboard?.writeText(text).catch(() => {});
  }
}

function renderTray() {
  if (!trayRoot) return;
  const recent = items.filter((i) => i.level === 'error' || i.level === 'warn').slice(-3).reverse();
  trayRoot.replaceChildren();
  for (const it of recent) {
    const n = el('div', `yingo-notify yingo-notify--${it.level}`);
    n.textContent = it.message;
    n.title = '点击打开诊断中心';
    n.addEventListener('click', () => { panelRoot.hidden = false; renderDiagnostics(); });
    trayRoot.appendChild(n);
  }
  if (diagRoot) {
    const errors = items.filter((i) => i.level === 'error').length;
    diagRoot.textContent = errors ? `● 诊断 (${errors})` : '● 诊断';
    diagRoot.dataset.hasError = errors ? '1' : '0';
  }
}

function renderDiagnostics() {
  if (!panelRoot || panelRoot.hidden) return;
  const panes = panelRoot.querySelectorAll('[data-pane]');
  const set = (name, text) => {
    const p = [...panes].find((x) => x.dataset.pane === name);
    if (p) p.textContent = text;
  };
  set('boot', bootTimeline.map((s) =>
    `${String(s.level).padStart(2, '0')} ${s.stage.padEnd(12)} ${s.status} ${s.durationMs ?? '-'}ms ${(s.modules || []).join(',')}`
  ).join('\n') || '(等待 system:ready)');
  set('commands', getCommands().map((c) => `${c.name}(${c.fields.join(', ')})${c.permission ? ' ← ' + c.permission : ''}`).join('\n'));
  set('events', getEventLog().slice(-80).map((e) =>
    `#${e.id} ${e.command} ${e.status} ${(e.t1 - e.t0).toFixed(1)}ms${e.error ? ' ' + e.error.code : ''}`
  ).join('\n'));
  set('items', items.slice(-80).map((i) =>
    `[${new Date(i.at).toLocaleTimeString()}] ${i.level.toUpperCase()} ${i.message} ${JSON.stringify(i.detail).slice(0, 180)}`
  ).join('\n'));
  set('storage', [
    `命中率      ${storageMetrics.hitRate ?? '-'}  (hits ${storageMetrics.hits ?? 0} / misses ${storageMetrics.misses ?? 0})`,
    `读 / 写 / 删 ${storageMetrics.reads ?? 0} / ${storageMetrics.writes ?? 0} / ${storageMetrics.deletes ?? 0}`,
    `失效广播    ${storageMetrics.invalidations ?? 0}`,
    `迁移 / GC   ${storageMetrics.migrates ?? 0} / ${storageMetrics.gcRuns ?? 0} (清理 ${storageMetrics.gcRemoved ?? 0})`,
    `审计条数    ${storageMetrics.auditSize ?? 0}`,
    '',
    '分区占用:',
    JSON.stringify(storageMetrics.zones || {}, null, 2),
  ].join('\n'));
}

/** 供 storage 诊断面板追加指标（§6.11） */
export function setStorageMetrics(metrics) {
  storageMetrics = metrics || {};
  renderDiagnostics();
}
let storageMetrics = {};

export function destroy() {
  trayRoot?.remove(); panelRoot?.remove(); diagRoot?.remove();
  panelRoot = trayRoot = diagRoot = null;
  listeners.clear();
}
