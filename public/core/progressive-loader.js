/**
 * progressive-loader.js — 渐进加载器
 *
 * 思路（对应用户要求）：
 *   1. 只加载「关键路径」最小集合（clock + search + apps-grid），立刻渲染出可用界面；
 *   2. 首屏出现后，用 requestIdleCallback / 分批懒加载其余模块、主题、插件；
 *   3. 全程进度条（分阶段加权，带逐项明细）；
 *   4. 结果缓存在 localStorage（带版本 + TTL），二次访问直接从缓存恢复清单，
 *      并用 modulepreload 预热资源，实现「缓存快速加载」。
 *
 * 零第三方依赖、零构建。所有缓存经 Storage Fabric 的 storage:* 命令（不直连原生 API），
 * 但本模块在 Kernel 之前运行，故使用一个受控的「预引导缓存」白名单例外（见 PREBOOT_KEY）。
 */

export const PREBOOT_KEY = 'yingo:preboot:v1';
const TTL_MS = 6 * 60 * 60 * 1000;   // 6 小时

/* ---------------- 进度条 UI ---------------- */

export function createProgress() {
  let bar = document.getElementById('yingo-boot-progress');
  if (bar) return { update, done, fail };
  const host = document.getElementById('yingo-root') || document.body;
  bar = document.createElement('div');
  bar.id = 'yingo-boot-progress';
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.innerHTML = `
    <div class="ybp-shell">
      <div class="ybp-brand">Yingo</div>
      <div class="ybp-track"><div class="ybp-fill"></div></div>
      <div class="ybp-meta"><span class="ybp-label">正在准备界面…</span><span class="ybp-pct">0%</span></div>
      <div class="ybp-detail"></div>
    </div>`;
  host.appendChild(bar);

  let pct = 0, label = '', details = [];
  function render() {
    const fill = bar.querySelector('.ybp-fill');
    const lbl = bar.querySelector('.ybp-label');
    const p = bar.querySelector('.ybp-pct');
    const d = bar.querySelector('.ybp-detail');
    if (fill) fill.style.width = pct + '%';
    if (lbl) lbl.textContent = label;
    if (p) p.textContent = Math.round(pct) + '%';
    if (d) d.textContent = details.slice(-3).join(' · ');
    bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  }
  function update(value, text, detail) {
    if (typeof value === 'number') pct = Math.max(pct, Math.min(100, value));
    if (text) label = text;
    if (detail) { details.push(detail); if (details.length > 8) details.shift(); }
    render();
  }
  function done() {
    update(100, '就绪');
    bar.classList.add('is-done');
    setTimeout(() => { bar.classList.add('is-hidden'); setTimeout(() => bar.remove(), 400); }, 260);
  }
  function fail(msg) {
    bar.classList.add('is-error');
    update(pct, '加载出现问题', msg);
  }
  render();
  return { update, done, fail };
}

/* ---------------- 预引导缓存（Kernel 之前唯一例外） ---------------- */

export function readCache() {
  try {
    const raw = localStorage.getItem(PREBOOT_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (c.v !== 1 || !c.t || Date.now() - c.t > TTL_MS) { localStorage.removeItem(PREBOOT_KEY); return null; }
    return c;
  } catch { return null; }
}

export function writeCache(data) {
  try { localStorage.setItem(PREBOOT_KEY, JSON.stringify({ v: 1, t: Date.now(), ...data })); }
  catch { /* 配额满忽略 */ }
}

/** 用 modulepreload 预热（浏览器原生，不改变执行时机） */
export function preload(urls) {
  for (const u of urls) {
    try {
      if (document.querySelector(`link[rel="modulepreload"][href="${u}"]`)) continue;
      const l = document.createElement('link');
      l.rel = 'modulepreload'; l.href = u;
      document.head.appendChild(l);
    } catch { /* noop */ }
  }
}

/** 空闲调度：优先 requestIdleCallback，退化到 setTimeout */
export function whenIdle(fn, timeout = 800) {
  if (typeof requestIdleCallback === 'function') return requestIdleCallback(fn, { timeout });
  return setTimeout(fn, 32);
}

/** 分批执行，每批之间让出主线程，避免长任务卡住首屏交互 */
export async function inBatches(items, batchSize, fn, onItem) {
  const out = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const res = await Promise.allSettled(batch.map(fn));
    res.forEach((r, j) => {
      const item = batch[j];
      if (r.status === 'fulfilled' && r.value) out.push(r.value);
      onItem?.(item, r);
    });
    await new Promise((r) => setTimeout(r, 0));
  }
  return out;
}
