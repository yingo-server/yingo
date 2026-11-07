/**
 * settings — 设置面板（内置模块）
 * 分区：内容仓库（多 URL 管理+模式）/ 壁纸（内置四张 + URL/上传导入 + 预留动态）/ 关于。
 * 挂载：右侧抽屉（Kernel 预注册 drawer/admin/settings 插槽）。
 */

const MODULE_ID = 'settings';
const SLOT_NAMES = ['settings', 'admin', 'drawer', 'panel', 'main'];
const REPOS_PATH = '/shared/repos.json';

let ctxRef = null;
let rootNode = null;
const subscriptions = [];

function report(code, message, err) {
  try { ctxRef?.notify('error', message, { code, module: MODULE_ID, ...(err ? { message: err.message } : {}) }); }
  catch { /* noop */ }
}
async function bus(cmd, payload) {
  const r = ctxRef.bus.emit(cmd, payload);
  return r && typeof r.then === 'function' ? await r : r;
}
import { renderIcon } from '../../core/icons.js';

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
    } catch { /* next */ }
  }
  try { ctx.mount(null, node); } catch { document.body.appendChild(node); }
}

/* ================= 内容仓库分区 ================= */

function buildReposSection() {
  const sec = makeEl('section', 'y-settings-section');
  sec.append(makeEl('h3', '', '内容仓库'));
  sec.append(makeEl('p', 'y-settings-hint',
    '应用与音乐来自内容仓库（根目录 yingotab.yml）。支持多仓库，按顺序合并、id 去重。'));

  const list = makeEl('div', 'y-settings-repos');
  sec.append(list);

  const modes = [
    ['jsdelivr', 'jsDeliv（推荐，公开仓）'],
    ['pages', '静态站点（GitHub Pages / Netlify / Vercel）'],
    ['ghproxy', 'ghproxy 代理（raw 加速）'],
  ];

  async function renderList() {
    const { repos } = await bus('repos:list', {});
    list.replaceChildren();
    repos.forEach((repo, i) => {
      const row = makeEl('div', 'y-settings-repo-row');
      const urlInput = makeEl('input');
      urlInput.value = repo.url || '';
      urlInput.placeholder = 'https://github.com/user/repo';
      const modeSel = makeEl('select', 'y-settings-mode');
      for (const [v, label] of modes) {
        const o = makeEl('option', '', label); o.value = v; modeSel.append(o);
      }
      modeSel.value = repo.mode || 'jsdelivr';
      const save = makeEl('button', '', '保存');
      save.type = 'button';
      save.addEventListener('click', async () => {
        try {
          const current = (await bus('repos:list', {})).repos;
          current[i] = { url: urlInput.value.trim(), mode: modeSel.value };
          await bus('repos:set', { repos: current });
          ctx.notify('info', '仓库已更新，正在重新拉取清单', { module: MODULE_ID });
        } catch (err) { report('E_SCHEMA', '仓库保存失败', err); }
      });
      const del = makeEl('button', '', '移除');
      del.type = 'button';
      del.addEventListener('click', async () => {
        try {
          const current = (await bus('repos:list', {})).repos;
          current.splice(i, 1);
          await bus('repos:set', { repos: current });
          await renderList();
        } catch (err) { report('E_SCHEMA', '仓库移除失败', err); }
      });
      row.append(urlInput, modeSel, save, del);
      list.append(row);
    });
  }

  const addRow = makeEl('div', 'y-settings-repo-row y-settings-repo-add');
  const newUrl = makeEl('input');
  newUrl.placeholder = '添加仓库：https://github.com/user/repo';
  const newMode = makeEl('select', 'y-settings-mode');
  for (const [v, label] of modes) { const o = makeEl('option', '', label); o.value = v; newMode.append(o); }
  const addBtn = makeEl('button', 'y-btn-filled', '添加');
  addBtn.type = 'button';
  addBtn.addEventListener('click', async () => {
    const url = newUrl.value.trim();
    if (!url) return;
    try {
      const current = (await bus('repos:list', {})).repos;
      current.push({ url, mode: newMode.value });
      await bus('repos:set', { repos: current });
      newUrl.value = '';
      await renderList();
      ctx.notify('info', '仓库已添加', { module: MODULE_ID });
    } catch (err) { report('E_SCHEMA', '仓库添加失败', err); }
  });
  addRow.append(newUrl, newMode, addBtn);
  sec.append(addRow);

  const reloadBtn = makeEl('button', '', '⟳ 重新拉取全部仓库');
  reloadBtn.type = 'button';
  reloadBtn.addEventListener('click', async () => {
    try {
      await bus('apps:reload', {});
      ctx.notify('info', '清单已重新拉取', { module: MODULE_ID });
    } catch (err) { report('E_UPSTREAM', '重新拉取失败', err); }
  });
  sec.append(reloadBtn);

  void renderList();
  return sec;
}

/* ================= 壁纸分区 ================= */

function buildWallpaperSection() {
  const sec = makeEl('section', 'y-settings-section');
  sec.append(makeEl('h3', '', '壁纸'));
  const grid = makeEl('div', 'y-settings-wallpapers');
  sec.append(grid);

  // 内置图片壁纸（index.json，构建期生成）：缩略图渲染
  fetch('/assets/wallpapers/index.json', { cache: 'default' })
    .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.status))))
    .then((data) => {
      grid.replaceChildren();
      for (const wp of data.wallpapers || []) {
        const item = makeEl('button', 'y-settings-wp-item');
        item.type = 'button';
        item.dataset.wp = wp.id;
        item.title = wp.name;
        item.style.background = `center / cover no-repeat url("${wp.thumb}")`;
        item.addEventListener('click', async () => {
          try {
            const cfg = { mode: 'builtin', id: wp.id, blur: 0, tint: 'transparent' };
            await bus('wallpaper:set', cfg);
            await bus('wallpaper:changed', cfg);
            markActive();
            ctx.notify('info', `已切换壁纸：${wp.name}`, { module: MODULE_ID });
          } catch (err) { report('E_SCHEMA', '壁纸切换失败', err); }
        });
        grid.append(item);
      }
      markActive();
    })
    .catch(() => {
      // 清单不可用时回退四张渐变占位
      for (const [id, name] of [['aurora', '极光'], ['dusk', '暮色'], ['forest', '林间'], ['mono', '墨色']]) {
        const item = makeEl('button', 'y-settings-wp-item');
        item.type = 'button'; item.dataset.wp = id; item.textContent = name;
        grid.append(item);
      }
    });

  function markActive() {
    void bus('wallpaper:get', {}).then((cfg) => {
      for (const el of grid.querySelectorAll('.y-settings-wp-item')) {
        el.classList.toggle('is-active', el.dataset.wp === cfg?.id && cfg?.mode === 'builtin');
      }
    });
  }

  // 自定义壁纸：URL 或本地上传
  const customRow = makeEl('div', 'y-settings-repo-row');
  const urlInput = makeEl('input');
  urlInput.placeholder = '自定义壁纸 URL（或本地上传）';
  const file = makeEl('input');
  file.type = 'file'; file.accept = 'image/*';
  const applyBtn = makeEl('button', 'y-btn-filled', '应用');
  applyBtn.type = 'button';
  applyBtn.addEventListener('click', async () => {
    let bgUrl = urlInput.value.trim();
    if (!bgUrl && file.files?.[0]) {
      bgUrl = await new Promise((res, rej) => {
        const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej;
        r.readAsDataURL(file.files[0]);
      });
    }
    if (!bgUrl) { ctx.notify('warn', '请填写 URL 或选择图片', { module: MODULE_ID }); return; }
    try {
      await bus('wallpaper:set', { mode: 'custom', url: bgUrl, blur: 0, tint: 'rgba(0,0,0,.2)' });
      await bus('wallpaper:changed', { mode: 'custom', url: bgUrl, blur: 0, tint: 'rgba(0,0,0,.2)' });
      ctx.notify('info', '自定义壁纸已应用', { module: MODULE_ID });
    } catch (err) { report('E_SCHEMA', '壁纸应用失败', err); }
  });
  customRow.append(urlInput, file, applyBtn);
  sec.append(customRow);

  sec.append(makeEl('p', 'y-settings-hint', '动态壁纸（视频 / three.js 场景）为预留扩展，渲染器接口已就位。'));
  void markActive();
  return sec;
}

/* ================= 关于 ================= */

function buildAboutSection() {
  const sec = makeEl('section', 'y-settings-section');
  sec.append(makeEl('h3', '', '关于'));
  sec.append(makeEl('p', 'y-settings-hint',
    'YingoTab — 极简起始页框架 · Apache-2.0 开源。应用与音乐由内容仓库分发；翻译与天气为内置能力。'));
  return sec;
}

/* ================= 生命周期 ================= */

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    subscriptions.length = 0;
    rootNode = makeEl('section', 'y-module y-settings');
    rootNode.dataset.moduleId = MODULE_ID;
    rootNode.append(buildReposSection(), buildWallpaperSection(), buildAboutSection());
    mountSelf(ctx, rootNode);
  },

  destroy() {
    for (const off of subscriptions) { try { off(); } catch { /* noop */ } }
    subscriptions.length = 0;
    rootNode?.remove(); rootNode = null;
    ctxRef = null;
  },
};
