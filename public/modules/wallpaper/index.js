/**
 * wallpaper — 壁纸框架（壁纸即主题）
 *
 * 渲染器注册机制：每种壁纸类型是一个渲染器 { id, init(el, config), destroy() }。
 * 内置：静态壁纸（内置四张渐变 + 用户自定义 URL/上传）。
 * 预留：dynamic 模式（动态视频/three.js 场景）——渲染器接口已就位，后续按 id 注册即可。
 * 全屏 fixed 层，位于所有内容之下；自动明暗随系统。
 */

const MODULE_ID = 'wallpaper';
const SLOT_NAMES = ['wallpaper', 'root'];
const CFG_PATH = '/shared/wallpaper.json';

/** 内置静态壁纸（纯 CSS 渐变，零资源加载） */
const BUILTIN_WALLPAPERS = {
  aurora: { name: '极光', css: 'linear-gradient(160deg,#0b1020 0%,#1b2a4a 38%,#3d5a80 70%,#98c1d9 100%)' },
  dusk: { name: '暮色', css: 'linear-gradient(150deg,#2d1b3d 0%,#5e3a5e 45%,#c76a6a 80%,#f4b896 100%)' },
  forest: { name: '林间', css: 'linear-gradient(165deg,#0c1a12 0%,#1d3b2a 50%,#4a7c59 85%,#a7c957 100%)' },
  mono: { name: '墨色', css: 'linear-gradient(170deg,#141414 0%,#2b2b2b 60%,#4d4d4d 100%)' },
};

let ctxRef = null;
let layerEl = null;
let current = null;
let renderer = null;
const subscriptions = [];

function report(code, message, err) {
  try {
    ctxRef?.notify('error', message, { code, module: MODULE_ID, ...(err ? { message: err.message } : {}) });
  } catch { /* noop */ }
}

async function bus(cmd, payload) {
  const r = ctxRef.bus.emit(cmd, payload);
  return r && typeof r.then === 'function' ? await r : r;
}

/* ---------------- 渲染器注册表 ---------------- */

const RENDERERS = {
  /** 静态壁纸：CSS 渐变或图片 URL（含 data URL 上传） */
  static: {
    id: 'static',
    async init(el, cfg) {
      const wp = cfg.id && BUILTIN_WALLPAPERS[cfg.id] ? BUILTIN_WALLPAPERS[cfg.id]
        : cfg.url ? { name: '自定义', css: null, image: cfg.url }
        : BUILTIN_WALLPAPERS.aurora;
      el.style.background = wp.css || `center / cover no-repeat url("${wp.image}")`;
    },
    destroy(el) { el.style.background = ''; },
  },
  /** 动态壁纸：预留接口。cfg.renderer 指向注册进来的动态渲染器 id。 */
  dynamic: {
    id: 'dynamic',
    async init(el, cfg) {
      // 未来实现：视频壁纸（<video loop>）、three.js 场景、WebGL 粒子等
      // 渲染器通过 registerRenderer('my-dynamic', {...}) 注册后即可使用
      const r = DYNAMIC_RENDERERS.get(cfg.renderer || cfg.id);
      if (r) { await r.init(el, cfg); return; }
      // 未注册时回退静态
      el.style.background = BUILTIN_WALLPAPERS.aurora.css;
    },
    destroy(el) {
      for (const r of DYNAMIC_RENDERERS.values()) { try { r.destroy?.(el); } catch { /* noop */ } }
      el.style.background = '';
    },
  },
};

/** 动态壁纸渲染器注册表（扩展点） */
const DYNAMIC_RENDERERS = new Map();
export function registerRenderer(id, renderer) { DYNAMIC_RENDERERS.set(id, renderer); }

/* ---------------- 生命周期 ---------------- */

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    subscriptions.length = 0;
    // 全屏壁纸层：fixed，z-index -2（背景伪元素之下、页面之上都没有——它在最底）
    layerEl = document.createElement('div');
    layerEl.id = 'yingo-wallpaper';
    layerEl.setAttribute('aria-hidden', 'true');
    document.body.prepend(layerEl);

    await apply(savedOrDefault());
    try {
      const off = ctx.bus.on('wallpaper:changed', (cfg) => { void apply(cfg); });
      if (typeof off === 'function') subscriptions.push(off);
    } catch (err) { report('E_MODULE_INIT', '订阅壁纸变更失败', err); }
  },

  destroy() {
    for (const off of subscriptions) { try { off(); } catch { /* noop */ } }
    subscriptions.length = 0;
    try { renderer?.destroy?.(layerEl); } catch { /* noop */ }
    layerEl?.remove(); layerEl = null;
    renderer = null; ctxRef = null;
  },
};

function savedOrDefault() {
  return current || { mode: 'builtin', id: 'aurora', blur: 0, tint: 'transparent' };
}

async function apply(cfg) {
  if (!layerEl) return;
  const mode = cfg?.mode || 'builtin';
  const rendererId = mode === 'dynamic' ? 'dynamic' : 'static';
  const next = RENDERERS[rendererId];
  if (!next) return;
  try {
    if (renderer && renderer !== next) { try { renderer.destroy?.(layerEl); } catch { /* noop */ } }
    renderer = next;
    await renderer.init(layerEl, cfg || {});
    current = { ...savedOrDefault(), ...cfg };
    // 模糊/色调由 CSS 变量承载（全局统一）
    const rs = document.documentElement.style;
    rs.setProperty('--yingo-wallpaper-blur', `${cfg.blur ?? 0}px`);
    rs.setProperty('--yingo-wallpaper-tint', cfg.tint || 'transparent');
  } catch (err) {
    report('E_WALLPAPER', '壁纸应用失败', err);
    layerEl.style.background = BUILTIN_WALLPAPERS.aurora.css;
  }
}

/* ---------------- 样式 ---------------- */
const STYLE_ID = 'yingo-style-wallpaper';
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
#yingo-wallpaper {
  position: fixed; inset: 0; z-index: -2;
  background-size: cover; background-position: center;
  filter: blur(var(--yingo-wallpaper-blur, 0px));
  transform: scale(1.04);
  transition: background 600ms ease, filter 400ms ease;
}
body::after {
  content: ""; position: fixed; inset: 0; z-index: -1; pointer-events: none;
  background: var(--yingo-wallpaper-tint, transparent);
}
  `;
  document.head.appendChild(s);
}
// 模块加载即注入（首屏前）
ensureStyle();
