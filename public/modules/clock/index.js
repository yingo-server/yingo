// 时钟模块：第一阶段唯一允许包含极简真实逻辑的内置模块。
// 布局自决（ADR-005）：模块内部选择 topbar 命名插槽，框架不指定任何 DOM id。
// destroy 必须清掉每秒定时器，避免模块卸载后继续刷新。

const MODULE_ID = 'clock';
const SLOT_NAME = 'topbar';
const WEEK_NAMES = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];

let ctxRef = null;
let rootNode = null;
let dateNode = null;
let timeNode = null;
let timerId = null;

function pad2(value) {
  return String(value).padStart(2, '0');
}

// 统一异常入口：所有异常都经通知中心上报，携带错误码与模块标识。
function report(ctx, code, message, err) {
  const detail = { code, module: MODULE_ID };
  if (err) {
    detail.message = err && err.message ? err.message : String(err);
    detail.stack = err && err.stack ? err.stack : null;
  }
  ctx.notify('error', message, detail);
}

function render() {
  if (!rootNode || !dateNode || !timeNode) return;
  const now = new Date();
  const y = now.getFullYear();
  const m = pad2(now.getMonth() + 1);
  const d = pad2(now.getDate());
  const h = pad2(now.getHours());
  const min = pad2(now.getMinutes());
  const s = pad2(now.getSeconds());
  dateNode.textContent = `${y}-${m}-${d} ${WEEK_NAMES[now.getDay()]}`;
  timeNode.textContent = `${h}:${min}:${s}`;
  rootNode.setAttribute('datetime', now.toISOString());
}

async function mountSelf(ctx, node) {
  // 先把挂载意图交给 ctx.mount()；只有明确返回 false 时，才用 ctx.slot() 取回容器再挂载。
  let result = ctx.mount(SLOT_NAME, node);
  if (result && typeof result.then === 'function') result = await result;
  if (result !== false) return;
  const slot = ctx.slot(SLOT_NAME);
  if (!slot) throw new Error(`插槽 ${SLOT_NAME} 不可用`);
  let fallback = ctx.mount(slot, node);
  if (fallback && typeof fallback.then === 'function') fallback = await fallback;
  if (fallback === false) throw new Error(`插槽 ${SLOT_NAME} 拒绝挂载`);
}

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    try {
      rootNode = document.createElement('time');
      rootNode.className = 'y-module y-module-clock';
      rootNode.dataset.moduleId = MODULE_ID;
      rootNode.style.marginLeft = 'auto';
      rootNode.style.textAlign = 'right';

      dateNode = document.createElement('span');
      dateNode.className = 'y-module-clock-date';
      timeNode = document.createElement('span');
      timeNode.className = 'y-module-clock-time';
      timeNode.style.marginLeft = '8px';
      rootNode.append(dateNode, timeNode);

      await mountSelf(ctx, rootNode);
      render();
      timerId = window.setInterval(() => {
        try {
          render();
        } catch (err) {
          report(ctxRef || ctx, 'E_MODULE_INIT', '时钟刷新失败', err);
        }
      }, 1000);
    } catch (err) {
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
      report(ctx, 'E_MODULE_INIT', '时钟模块初始化失败', err);
    }
  },

  destroy() {
    const ctx = ctxRef;
    try {
      if (timerId !== null) {
        window.clearInterval(timerId);
        timerId = null;
      }
      if (rootNode && rootNode.parentNode) rootNode.parentNode.removeChild(rootNode);
    } catch (err) {
      if (ctx) report(ctx, 'E_MODULE_INIT', '时钟模块销毁失败', err);
      else console.error('[yingo] 时钟模块销毁失败（通知中心不可用）', err);
    } finally {
      rootNode = null;
      dateNode = null;
      timeNode = null;
      ctxRef = null;
    }
  }
};
