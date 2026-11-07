/**
 * music-player — 框架内置「音乐模块」
 *
 * 定位：与 clock/search/apps-grid 一样是框架模块，不是 /apps/ 下的应用。
 * 数据源：/api/music 或本地 music.json（经 music:list 命令），曲目文件在 /assets/audio/。
 * 全部状态经 Storage Fabric（/shared/music/state.json），不直连任何原生存储 API。
 * 模块自决挂载位置（ADR-005）：优先 bottombar / music 插槽，缺失则自取容器。
 */

import { musicIcon } from './icons.js';

const MODULE_ID = 'music-player';
const STYLE_ID = 'yingo-style-music-player';
const SLOT_NAMES = ['bottombar', 'music', 'root'];
const STATE_PATH = '/shared/music/state.json';
const STATE_SCHEMA = 'music-state@1';

let ctxRef = null;
let rootNode = null;
let audio = null;
let unsubscribe = [];
let tracks = [];
let currentIndex = -1;
let repeatMode = 'all';       // all | one | off
let shuffle = false;
let history = [];
let volume = 0.8;
let muted = false;
let seekTimer = null;
let isSeeking = false;

/* ---------------- 工具 ---------------- */

function makeEl(tag, cls, text) {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}
function fmt(sec) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
function report(ctx, code, message, err) {
  const d = { code, module: MODULE_ID };
  if (err) { d.message = err.message || String(err); d.stack = String(err.stack || ''); }
  try { ctx.notify('error', message, d); } catch { /* 通知不可用时不影响播放 */ }
}
async function bus(ctx, cmd, payload) {
  const r = ctx.bus.emit(cmd, payload);
  return r && typeof r.then === 'function' ? await r : r;
}
function listen(ctx, cmd, fn) {
  const off = ctx.bus.on(cmd, fn);
  if (typeof off === 'function') unsubscribe.push(off);
  else unsubscribe.push([cmd, fn]);
}
function isPromise(v) { return !!v && typeof v.then === 'function'; }

/** 模块自带样式，由模块自行注入（ADR-005：不依赖 index.html 是否 link） */
function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID; link.rel = 'stylesheet';
  link.href = new URL('./style.css', import.meta.url).href;
  (document.head || document.body).appendChild(link);
}

function mountSelf(ctx, node) {
  for (const name of SLOT_NAMES) {
    try {
      let r = ctx.mount(name, node);
      if (isPromise(r)) r = r.then ? null : r;   // mount 为同步实现
      if (r !== false && (node.isConnected || node.parentNode)) return;
      const sl = ctx.slot(name);
      if (!sl) continue;
      const r2 = ctx.mount(sl, node);
      if (r2 !== false && (node.isConnected || node.parentNode)) return;
      sl.appendChild(node);
      return;
    } catch { /* 尝试下一个插槽 */ }
  }
  try { ctx.mount(document.body, node); } catch { document.body.appendChild(node); }
}

/* ---------------- UI ---------------- */

function buildUi() {
  ensureStyle();
  rootNode = makeEl('section', 'y-module y-module-music-player glass');
  rootNode.dataset.moduleId = MODULE_ID;

  const head = makeEl('div', 'y-mp-head');
  const cover = makeEl('div', 'y-mp-cover');
  cover.textContent = musicIcon('note');
  const info = makeEl('div', 'y-mp-info');
  const title = makeEl('div', 'y-mp-title', '未选择曲目');
  const artist = makeEl('div', 'y-mp-artist', '音乐模块 · 就绪');
  info.append(title, artist);
  head.append(cover, info);

  const controls = makeEl('div', 'y-mp-controls');
  const btnShuffle = makeEl('button', 'y-mp-btn', musicIcon('shuffle'));
  const btnPrev = makeEl('button', 'y-mp-btn', musicIcon('prev'));
  const btnPlay = makeEl('button', 'y-mp-btn y-mp-btn--primary', musicIcon('play'));
  const btnNext = makeEl('button', 'y-mp-btn', musicIcon('next'));
  const btnRepeat = makeEl('button', 'y-mp-btn', musicIcon('repeat'));
  [btnShuffle, btnPrev, btnPlay, btnNext, btnRepeat].forEach((b) => { b.type = 'button'; });
  btnShuffle.title = '随机播放'; btnPrev.title = '上一首'; btnPlay.title = '播放/暂停';
  btnNext.title = '下一首'; btnRepeat.title = '循环模式';
  controls.append(btnShuffle, btnPrev, btnPlay, btnNext, btnRepeat);

  const progressRow = makeEl('div', 'y-mp-progress-row');
  const timeNow = makeEl('span', 'y-mp-time', '00:00');
  const progress = makeEl('input', 'y-mp-progress');
  progress.type = 'range'; progress.min = '0'; progress.max = '100'; progress.value = '0';
  progress.setAttribute('aria-label', '播放进度');
  const timeTotal = makeEl('span', 'y-mp-time', '--:--');
  progressRow.append(timeNow, progress, timeTotal);

  const volRow = makeEl('div', 'y-mp-vol-row');
  const btnMute = makeEl('button', 'y-mp-btn y-mp-btn--small', musicIcon('volume'));
  btnMute.type = 'button'; btnMute.title = '静音';
  const volumeRange = makeEl('input', 'y-mp-volume');
  volumeRange.type = 'range'; volumeRange.min = '0'; volumeRange.max = '1';
  volumeRange.step = '0.01'; volumeRange.value = String(volume);
  volumeRange.setAttribute('aria-label', '音量');
  const speed = makeEl('select', 'y-mp-speed');
  for (const v of ['0.75', '1', '1.25', '1.5', '2']) {
    const o = makeEl('option', '', v + '×'); o.value = v; speed.append(o);
  }
  speed.value = '1'; speed.title = '播放速度';
  const btnList = makeEl('button', 'y-mp-btn y-mp-btn--small', '☰');
  btnList.type = 'button'; btnList.title = '播放列表';
  volRow.append(btnMute, volumeRange, speed, btnList);

  const listBox = makeEl('div', 'y-mp-list');
  listBox.hidden = true;

  const status = makeEl('div', 'y-mp-status', '');

  rootNode.append(head, controls, progressRow, volRow, listBox, status);
  rootNode._ui = { cover, title, artist, btnShuffle, btnPrev, btnPlay, btnNext, btnRepeat,
    timeNow, progress, timeTotal, btnMute, volumeRange, speed, btnList, listBox, status };
  return rootNode._ui;
}

function renderList(ui) {
  ui.listBox.replaceChildren();
  if (!tracks.length) {
    ui.listBox.append(makeEl('p', 'y-mp-empty', '暂无曲目（构建期由 gen-music-manifest.mjs 生成 music.json）'));
    return;
  }
  tracks.forEach((t, i) => {
    const row = makeEl('button', 'y-mp-list-item' + (i === currentIndex ? ' is-active' : ''));
    row.type = 'button';
    row.append(makeEl('span', 'y-mp-list-index', String(i + 1).padStart(2, '0')));
    row.append(makeEl('span', 'y-mp-list-title', t.title || t.id));
    if (t.artist) row.append(makeEl('span', 'y-mp-list-artist', t.artist));
    row.addEventListener('click', () => { playIndex(i); ui.listBox.hidden = true; });
    ui.listBox.append(row);
  });
}

function syncUi() {
  const ui = rootNode?._ui; if (!ui) return;
  const t = tracks[currentIndex];
  ui.title.textContent = t ? (t.title || t.id) : '未选择曲目';
  ui.artist.textContent = t ? (t.artist || '本地音乐') : '音乐模块 · 就绪';
  ui.btnPlay.textContent = audio && !audio.paused ? musicIcon('pause') : musicIcon('play');
  ui.btnShuffle.dataset.on = shuffle ? '1' : '0';
  ui.btnRepeat.textContent = musicIcon(repeatMode === 'one' ? 'repeat-one' : 'repeat');
  ui.btnRepeat.dataset.mode = repeatMode;
  ui.btnMute.textContent = musicIcon(muted || volume === 0 ? 'mute' : 'volume');
  ui.timeNow.textContent = fmt(audio?.currentTime || 0);
  ui.timeTotal.textContent = Number.isFinite(audio?.duration) && audio.duration > 0 ? fmt(audio.duration) : '--:--';
  if (!isSeeking && audio && Number.isFinite(audio.duration) && audio.duration > 0) {
    ui.progress.value = String(Math.round((audio.currentTime / audio.duration) * 100));
  }
  ui.volumeRange.value = String(muted ? 0 : volume);
  [...ui.listBox.children].forEach((n, i) => n.classList.toggle('is-active', i === currentIndex));
  ui.status.textContent = tracks.length
    ? `${currentIndex + 1} / ${tracks.length} · ${repeatMode === 'off' ? '不循环' : repeatMode === 'one' ? '单曲循环' : '列表循环'}${shuffle ? ' · 随机' : ''}`
    : '曲目清单为空';
}

/* ---------------- 播放逻辑 ---------------- */

async function loadTracks(ctx) {
  const res = await bus(ctx, 'music:list', {});
  tracks = Array.isArray(res?.tracks) ? res.tracks.filter((t) => t && t.file) : [];
  if (rootNode) renderList(rootNode._ui);
  return tracks;
}

function ensureAudio(ctx) {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'metadata';
  audio.volume = volume;
  // 挂到 DOM：便于诊断、且部分浏览器仅对文档内 media element 允许完整控制
  audio.hidden = true;
  audio.dataset.yingoModule = MODULE_ID;
  (document.body || document.documentElement).appendChild(audio);
  audio.addEventListener('timeupdate', syncUi);
  audio.addEventListener('loadedmetadata', syncUi);
  audio.addEventListener('durationchange', syncUi);
  audio.addEventListener('play', () => { syncUi(); persistState(ctx); });
  audio.addEventListener('pause', () => { syncUi(); persistState(ctx); });
  audio.addEventListener('ended', () => onEnded(ctx));
  audio.addEventListener('error', () => {
    report(ctx, 'E_MUSIC_DECODE', `无法播放: ${tracks[currentIndex]?.file || '未知文件'}`);
    ui_status('文件不可用或格式不受支持');
  });
  return audio;
}

function ui_status(msg) { if (rootNode?._ui) rootNode._ui.status.textContent = msg; }

function playIndex(i, ctx = ctxRef) {
  if (!tracks.length) { ui_status('没有可播放的曲目'); return; }
  if (i < 0 || i >= tracks.length) i = 0;
  currentIndex = i;
  const t = tracks[i];
  const a = ensureAudio(ctx);
  a.src = t.file;
  a.playbackRate = Number(rootNode?._ui?.speed?.value || 1);
  a.load();
  const p = a.play();
  if (p && typeof p.catch === 'function') {
    p.catch((err) => {
      // 浏览器自动播放策略：不作为异常上报，提示用户点击
      ui_status('浏览器阻止自动播放，请点击播放按钮');
      syncUi();
    });
  }
  history = history.filter((x) => x !== i); history.push(i);
  renderList(rootNode._ui);
  syncUi();
  persistState(ctx);
}

function togglePlay(ctx) {
  if (!tracks.length) { ui_status('没有可播放的曲目'); return; }
  const a = ensureAudio(ctx);
  if (currentIndex < 0) { playIndex(0, ctx); return; }
  if (a.paused) {
    const p = a.play();
    if (p && typeof p.catch === 'function') {
      p.catch((err) => {
        if (err?.name === 'NotAllowedError') ui_status('浏览器阻止自动播放，请再次点击播放按钮');
        else ui_status(`播放失败：${err?.message || '未知错误'}`);
        syncUi();
      });
    }
  } else a.pause();
  syncUi();
}

function pickNext(step = 1) {
  if (!tracks.length) return 0;
  if (shuffle) {
    if (tracks.length === 1) return 0;
    let n; do { n = Math.floor(Math.random() * tracks.length); } while (n === currentIndex);
    return n;
  }
  return (currentIndex + step + tracks.length) % tracks.length;
}

function onEnded(ctx) {
  if (repeatMode === 'one') { const a = ensureAudio(ctx); a.currentTime = 0; a.play().catch(() => {}); return; }
  if (repeatMode === 'off' && currentIndex === tracks.length - 1 && !shuffle) { syncUi(); return; }
  playIndex(pickNext(1), ctx);
}

function next(ctx) { playIndex(pickNext(1), ctx); }
function prev(ctx) {
  if (audio && audio.currentTime > 3) { audio.currentTime = 0; return; }
  if (history.length > 1) { history.pop(); playIndex(history[history.length - 1], ctx); return; }
  playIndex(pickNext(-1), ctx);
}

async function persistState(ctx) {
  if (!ctx) return;
  const state = {
    id: tracks[currentIndex]?.id || null,
    index: currentIndex,
    position: Number.isFinite(audio?.currentTime) ? audio.currentTime : 0,
    playing: !!audio && !audio.paused,
    volume, muted, shuffle, repeatMode,
    playbackRate: Number(audio?.playbackRate || 1),
    updatedAt: Date.now(),
  };
  try { await bus(ctx, 'storage:set', { path: STATE_PATH, value: state, schema: STATE_SCHEMA }); }
  catch (err) { report(ctx, 'E_VFS_BACKEND', '播放状态持久化失败', err); }
}

async function restoreState(ctx) {
  try {
    const s = await bus(ctx, 'storage:get', { path: STATE_PATH, fallback: null });
    if (!s || typeof s !== 'object') return null;
    if (typeof s.volume === 'number') volume = Math.min(1, Math.max(0, s.volume));
    muted = !!s.muted; shuffle = !!s.shuffle;
    if (['all', 'one', 'off'].includes(s.repeatMode)) repeatMode = s.repeatMode;
    return s;
  } catch (err) { report(ctx, 'E_VFS_BACKEND', '播放状态恢复失败', err); return null; }
}

/* ---------------- 事件绑定 ---------------- */

function bind(ui, ctx) {
  ui.btnPlay.addEventListener('click', () => togglePlay(ctx));
  ui.btnNext.addEventListener('click', () => next(ctx));
  ui.btnPrev.addEventListener('click', () => prev(ctx));
  ui.btnShuffle.addEventListener('click', () => { shuffle = !shuffle; syncUi(); persistState(ctx); });
  ui.btnRepeat.addEventListener('click', () => {
    repeatMode = repeatMode === 'all' ? 'one' : repeatMode === 'one' ? 'off' : 'all';
    syncUi(); persistState(ctx);
  });
  ui.btnList.addEventListener('click', () => { ui.listBox.hidden = !ui.listBox.hidden; renderList(ui); });
  ui.btnMute.addEventListener('click', () => {
    muted = !muted; if (audio) audio.muted = muted; syncUi(); persistState(ctx);
  });
  ui.volumeRange.addEventListener('input', (e) => {
    volume = Number(e.target.value); muted = volume === 0;
    if (audio) { audio.volume = volume; audio.muted = muted; }
    syncUi();
  });
  ui.volumeRange.addEventListener('change', () => persistState(ctx));
  ui.speed.addEventListener('change', (e) => {
    const v = Number(e.target.value);
    if (audio) audio.playbackRate = v;
    persistState(ctx);
  });
  ui.progress.addEventListener('pointerdown', () => { isSeeking = true; });
  ui.progress.addEventListener('input', (e) => {
    if (!audio || !Number.isFinite(audio.duration)) return;
    ui.timeNow.textContent = fmt((Number(e.target.value) / 100) * audio.duration);
  });
  ui.progress.addEventListener('change', (e) => {
    if (audio && Number.isFinite(audio.duration)) {
      audio.currentTime = (Number(e.target.value) / 100) * audio.duration;
    }
    isSeeking = false; syncUi(); persistState(ctx);
  });

  // 总线命令：外部模块可控制播放器
  listen(ctx, 'music:play', ({ id, index }) => {
    let i = typeof index === 'number' ? index : tracks.findIndex((t) => t.id === id);
    if (i < 0) i = 0;
    playIndex(i, ctx);
  });
  listen(ctx, 'music:next', () => next(ctx));
  listen(ctx, 'music:prev', () => prev(ctx));
  listen(ctx, 'music:toggle', () => togglePlay(ctx));
  listen(ctx, 'music:state', ({ state }) => { if (state) syncUi(); });
  listen(ctx, 'storage:invalidate', ({ prefix }) => {
    if (prefix && prefix.startsWith('/shared/music/')) return;  // 自己写的，忽略
  });
  listen(ctx, 'apps:reload', () => { /* 应用重载与音乐无关，保留订阅以保持接口一致 */ });
}

/* ---------------- 生命周期 ---------------- */

export default {
  id: MODULE_ID,
  async init(ctx) {
    ctxRef = ctx;
    unsubscribe = [];
    const ui = buildUi();
    mountSelf(ctx, rootNode);
    try {
      await loadTracks(ctx);
      const saved = await restoreState(ctx);
      bind(ui, ctx);
      if (audio) { audio.volume = volume; audio.muted = muted; }
      // 恢复上次曲目但不自动播放（遵守浏览器自动播放策略）
      if (tracks.length) {
        let i = saved && typeof saved.index === 'number' ? saved.index : tracks.findIndex((t) => t.id === saved?.id);
        if (i < 0 || i >= tracks.length) i = 0;
        currentIndex = i;
        const a = ensureAudio(ctx);
        a.src = tracks[i].file;
        a.volume = volume; a.muted = muted;
        if (typeof saved?.playbackRate === 'number') { a.playbackRate = saved.playbackRate; ui.speed.value = String(saved.playbackRate); }
        if (Number.isFinite(saved?.position) && saved.position > 0) {
          a.addEventListener('loadedmetadata', () => {
            try { a.currentTime = Math.min(saved.position, a.duration || saved.position); } catch { /* noop */ }
          }, { once: true });
        }
      }
      renderList(ui);
      syncUi();
    } catch (err) { report(ctx, 'E_MODULE_INIT', '音乐模块初始化失败', err); }
  },
  destroy() {
    for (const off of unsubscribe) {
      try { if (typeof off === 'function') off(); else if (Array.isArray(off)) ctxRef?.bus?.off?.(off[0], off[1]); } catch { /* noop */ }
    }
    unsubscribe = [];
    if (seekTimer) clearInterval(seekTimer);
    if (audio) { audio.pause(); audio.src = ''; audio.remove(); audio = null; }
    rootNode?.remove(); rootNode = null; ctxRef = null;
    tracks = []; currentIndex = -1; history = [];
  },
};
