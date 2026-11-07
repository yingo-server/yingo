/**
 * clock — 时钟模块（清风版）
 * 全屏大字时钟 + 日期星期，位于搜索胶囊上方。
 * 零依赖、每分钟更新（分钟级显示无需秒级定时器，省电省帧）。
 */

const MODULE_ID = 'clock';
const SLOT_NAMES = ['clock', 'hero', 'topbar'];
const WEEK_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

let ctxRef = null;
let rootNode = null;
let dateNode = null;
let timeNode = null;
let timerId = null;
let lastMinute = -1;

function pad2(v) { return String(v).padStart(2, '0'); }

function report(code, message, err) {
  try {
    ctxRef?.notify('error', message, { code, module: MODULE_ID, ...(err ? { message: err.message } : {}) });
  } catch { /* noop */ }
}

function render() {
  if (!rootNode || !dateNode || !timeNode) return;
  const now = new Date();
  const minute = now.getHours() * 60 + now.getMinutes();
  if (minute === lastMinute) return;      // 无变化不重绘
  lastMinute = minute;
  dateNode.textContent = `${now.getFullYear()}年${pad2(now.getMonth() + 1)}月${pad2(now.getDate())}日 · ${WEEK_NAMES[now.getDay()]}`;
  timeNode.textContent = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

function tick() {
  render();
  const now = new Date();
  // 对齐到下一分钟的第 1 秒，减少唤醒次数
  const delay = (60 - now.getSeconds()) * 1000 + 50;
  timerId = setTimeout(tick, delay);
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
    } catch { /* 试下一个插槽 */ }
  }
  try { ctx.mount(null, node); } catch { document.body.appendChild(node); }
}

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    try {
      rootNode = makeEl('section', 'y-module y-clock');
      rootNode.dataset.moduleId = MODULE_ID;
      timeNode = makeEl('div', 'y-clock-time', '--:--');
      dateNode = makeEl('div', 'y-clock-date', '');
      rootNode.append(timeNode, dateNode);
      mountSelf(ctx, rootNode);
      render();
      tick();
    } catch (err) {
      report('E_MODULE_INIT', '时钟模块初始化失败', err);
    }
  },

  destroy() {
    if (timerId) { clearTimeout(timerId); timerId = null; }
    rootNode?.remove();
    rootNode = dateNode = timeNode = null;
    ctxRef = null; lastMinute = -1;
  },
};
