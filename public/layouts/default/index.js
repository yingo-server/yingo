/**
 * 默认布局模块：只提供命名插槽的视觉顺序，不替任何模块决定挂载位置（ADR-005）。
 * Kernel 已在 core 阶段预注册插槽；本模块仅补充样式与顺序提示，可整包替换。
 */
export default {
  id: 'default',
  async init(ctx) {
    const names = ['topbar', 'search', 'apps', 'music', 'sidebar'];
    for (const name of names) {
      const node = ctx.slot(name);
      if (!node) continue;
      node.dataset.layout = 'default';
      node.style.order = String(names.indexOf(name));
    }
    const side = ctx.slot('sidebar');
    if (side) side.setAttribute('data-collapsed', 'true');
  },
  destroy() { for (const n of document.querySelectorAll('[data-layout="default"]')) delete n.dataset.layout; },
};
