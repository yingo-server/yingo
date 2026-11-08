/**
 * icons.js — 统一图标解析与渲染（v2：内联优先，网络仅为增强）
 *
 * 回退链：内联表（零网络，肯定显示）→ lawnicons: CDN（增强）→ URL → emoji → 🧩
 * 渲染：SVG 内联（stroke 继承 currentColor），emoji 原样文本。
 * 暗色壁纸（默认）下描边图标反色显示；html[data-yingo-light] 时正常色。
 */

import { INLINE_ICONS } from './inline-icons.js';

const BASE = new URL('../assets/icons/', import.meta.url).href;
const LAWNICONS_CDN = 'https://cdn.jsdelivr.net/gh/LawnchairLauncher/lawnicons@main/svgs/';

const svgCache = new Map();      // url -> svgText | null

/** 判断是否 emoji：必须含 emoji 表意符号，纯字母/数字/连字符不算 */
function isEmoji(s) {
  // 排除 ASCII 可打印字符构成的串（如 'abc'、'lawnicons:x' 已在上游处理）
  if (/^[\x20-\x7E]+$/.test(s)) return false;
  return /\p{Extended_Pictographic}/u.test(s);
}

/** 解析 icon 字段 → { type, src }；type: 'inline' | 'lawnicons' | 'img' | 'emoji' | 'none' */
export function resolveIcon(icon) {
  const raw = String(icon ?? '').trim();
  if (!raw) return { type: 'none', src: '🧩' };
  if (raw.startsWith('lawnicons:')) {
    const name = raw.slice(10).trim();
    // 内联表命中（大小写/连字符容错）→ 零网络
    if (INLINE_ICONS[name]) return { type: 'inline', src: INLINE_ICONS[name] };
    const alias = Object.keys(INLINE_ICONS).find((k) => k.replace(/[-_]/g, '') === name.replace(/[-_]/g, ''));
    if (alias) return { type: 'inline', src: INLINE_ICONS[alias] };
    return { type: 'lawnicons', src: LAWNICONS_CDN + encodeURIComponent(name) + '.svg' };
  }
  if (/^https?:\/\//.test(raw)) return { type: 'img', src: raw };
  if (isEmoji(raw)) return { type: 'emoji', src: raw };
  const assetName = raw.replace(/^assets\/icons\//, '').replace(/\.svg$/, '');
  if (INLINE_ICONS[assetName]) return { type: 'inline', src: INLINE_ICONS[assetName] };
  return { type: 'asset', src: BASE + assetName + '.svg' };
}

async function fetchText(url) {
  if (svgCache.has(url)) return svgCache.get(url);
  let text = null;
  try {
    const res = await fetch(url, { cache: 'default' });
    if (res.ok && /<svg[\s>]/i.test(await res.clone().text())) text = await res.text();
  } catch { /* 回退 */ }
  svgCache.set(url, text);
  return text;
}

/** 让 SVG 描边跟随文字色：去掉固定 #000/stroke 颜色，继承 currentColor */
function makeCurrentColor(svgText) {
  return svgText
    .replace(/stroke="#[0-9a-fA-F]{3,8}"/g, 'stroke="currentColor"')
    .replace(/fill="#[0-9a-fA-F]{3,8}"/g, (m, off, full) => (full.indexOf('fill="none"') === -1 ? 'fill="currentColor"' : m));
}

/**
 * 渲染图标到容器。
 * @returns {Promise<Element>} 实际渲染的节点（span>svg 或 span 文本）
 */
export async function renderIcon(container, icon, { size = 22, title } = {}) {
  const { type, src } = resolveIcon(icon);
  const span = document.createElement('span');
  span.className = 'y-icon';
  span.style.cssText = `display:inline-flex;width:${size}px;height:${size}px;align-items:center;justify-content:center;font-size:${size * 0.8}px;line-height:1`;
  if (title) span.title = title;

  if (type === 'emoji' || type === 'none') {
    span.textContent = src;
    container.append(span);
    return span;
  }

  if (type === 'img') {
    const img = document.createElement('img');
    img.src = src;
    img.alt = title || 'icon';
    img.style.cssText = 'width:100%;height:100%;object-fit:contain';
    span.append(img);
    container.append(span);
    return span;
  }

  // inline：零网络直接渲染；lawnicons / asset：拉 SVG 文本内联（失败回退 emoji）
  const text = type === 'inline' ? src : await fetchText(src);
  if (text) {
    const holder = document.createElement('span');
    holder.innerHTML = makeCurrentColor(text);
    const svg = holder.querySelector('svg');
    if (svg) {
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.style.cssText = 'width:100%;height:100%;display:block';
      span.append(svg);
      container.append(span);
      return span;
    }
  }
  // 回退：占位 emoji
  span.textContent = '🧩';
  container.append(span);
  return span;
}
