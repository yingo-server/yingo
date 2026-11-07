/**
 * 主题模块：新拟物化
 * 主题即模块：向 ThemeService 注册，切换只换 token 集合与主题 CSS。
 * 不规定任何模块位置（ADR-005）；CSS 由各主题 tokens.css 承载。
 */
const ID = 'neumorphism';

export default {
  id: ID,
  async init(ctx) {
    ctx.bus.on('theme:apply', ({ id }) => {
      document.documentElement.setAttribute('data-yingo-theme', ID);
      // 切换时移除其它主题的 link，始终只保留一份
      for (const other of ['material-3', 'neumorphism', 'lime-tabs']) {
        if (other !== ID) document.getElementById('theme-css-' + other)?.remove();
      }
      if (id === ID) ensureThemeCss(); else removeThemeCss();
    });
    if (ID === 'lime-tabs') {
      try {
        const bg = await ctx.bus.emit('storage:get', { path: '/shared/theme/bg.json', fallback: null });
        if (bg && bg.url) await ctx.bus.emit('theme:bg-set', bg);
      } catch (e) { ctx.notify('warn', '背景参数恢复失败', { code: 'E_THEME_BG', module: ID }); }
    }
    // 只在自己是当前主题时挂 CSS，避免三套 tokens 同时生效、互相覆盖
    if (document.documentElement.getAttribute('data-yingo-theme') === ID) ensureThemeCss();
    else removeThemeCss();
  },
  destroy() { removeThemeCss(); },
};

function removeThemeCss() { document.getElementById('theme-css-' + ID)?.remove(); }
function ensureThemeCss() {
  if (document.getElementById('theme-css-' + ID)) return;
  const link = document.createElement('link');
  link.id = 'theme-css-' + ID;
  link.rel = 'stylesheet';
  link.href = new URL('./tokens.css', import.meta.url).href;
  document.head.appendChild(link);
}
