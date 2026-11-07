// 底部音乐条空壳：读音乐清单、播放/暂停/进度占位、状态持久化到 /shared/music/state.json。
// 全部存储走 storage:* 总线命令；不实现音频解码、不实现播放引擎、不接触原生存储 API。
// 布局自决（ADR-005）：模块内部选择底部插槽，不依赖任何 DOM id。

const MODULE_ID = 'music-player';
const SLOT_NAMES = ['bottombar', 'footer', 'main'];
const STATE_PATH = '/shared/music/state.json';

let ctxRef = null;
let rootNode = null;
let titleNode = null;
let playBtn = null;
let progressNode = null;
let timeNode = null;
let tracks = [];
let state = { id: null, playing: false, position: 0, volume: 1 };
const subscriptions = [];

function report(ctx, code, message, err) {
  const detail = { code, module: MODULE_ID };
  if (err) {
    detail.message = err && err.message ? err.message : String(err);
    detail.stack = err && err.stack ? err.stack : null;
  }
  ctx.notify('error', message, detail);
}

function isPromise(value) {
  return !!value && typeof value.then === 'function';
}

async function emit(ctx, command, payload) {
  const result = ctx.bus.emit(command, payload);
  return isPromise(result) ? await result : result;
}

async function on(ctx, command, handler) {
  const result = ctx.bus.on(command, handler);
  if (isPromise(result)) await result;
  subscriptions.push({ command, handler });
}

async function mountSelf(ctx, node, slotNames) {
  const errors = [];
  for (const name of slotNames) {
    try {
      let r = ctx.mount(name, node);
      if (isPromise(r)) r = await r;
      if (r !== false && (node.isConnected || node.parentNode)) return;
      if (r === false) continue;
      const slot = ctx.slot(name);
      if (!slot) continue;
      let r2 = ctx.mount(slot, node);
      if (isPromise(r2)) r2 = await r2;
      if (r2 !== false && (node.isConnected || node.parentNode)) return;
      if (r2 === false) continue;
      slot.appendChild(node);
      return;
    } catch (err) {
      errors.push(err);
    }
  }
  try {
    let r = ctx.mount(document.body, node);
    if (isPromise(r)) r = await r;
    if (r !== false && !(node.isConnected || node.parentNode)) document.body.appendChild(node);
  } catch (err) {
    errors.push(err);
  }
  for (const err of errors) report(ctx, 'E_MODULE_INIT', '音乐条挂载插槽失败，已使用自取容器', err);
}

function makeEl(tag, className, text) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function buildUi(ctx) {
  rootNode = makeEl('section', 'y-module y-module-music-player');
  rootNode.dataset.moduleId = MODULE_ID;
  rootNode.append(makeEl('span', 'y-module-music-player-label', '音乐'));

  playBtn = makeEl('button', 'y-module-music-player-play', '播放');
  playBtn.type = 'button';
  playBtn.addEventListener('click', () => {
    void togglePlay(ctx);
  });
  titleNode = makeEl('span', 'y-module-music-player-title', '未选择曲目（占位）');

  // 进度条仅作占位，不驱动任何解码或计时器。
  progressNode = makeEl('input', 'y-module-music-player-progress');
  progressNode.type = 'range';
  progressNode.min = '0';
  progressNode.max = '100';
  progressNode.value = '0';
  progressNode.disabled = true;
  progressNode.setAttribute('aria-label', '播放进度（占位）');
  timeNode = makeEl('span', 'y-module-music-player-time', '00:00 / --:--');

  const prev = makeEl('button', 'y-module-music-player-prev', '上一首');
  prev.type = 'button';
  prev.disabled = true;
  const next = makeEl('button', 'y-module-music-player-next', '下一首');
  next.type = 'button';
  next.disabled = true;

  rootNode.append(prev, playBtn, next, titleNode, progressNode, timeNode);
}

function normalizeTracks(result) {
  if (Array.isArray(result)) return result;
  if (result && Array.isArray(result.tracks)) return result.tracks;
  if (result && Array.isArray(result.items)) return result.items;
  return [];
}

function render() {
  if (!rootNode) return;
  const track = tracks.find((item) => item.id === state.id) || tracks[0] || null;
  titleNode.textContent = track ? String(track.title || track.id || '未命名曲目') : '无可用曲目（占位）';
  playBtn.textContent = state.playing ? '暂停' : '播放';
  progressNode.value = String(Math.min(100, Math.max(0, Number(state.position) || 0)));
  timeNode.textContent = '00:00 / --:--（占位）';
}

async function saveState(ctx) {
  // 状态持久化的唯一落点：/shared/music/state.json，走 storage:set 强类型命令。
  // 不额外发 music:state（Kernel 的 MusicService 会再次写同一路径并广播，造成重复写盘）。
  await emit(ctx, 'storage:set', { path: STATE_PATH, value: { ...state }, schema: 'music-state@1' });
}

async function togglePlay(ctx) {
  try {
    if (!tracks.length) {
      ctx.notify('error', '音乐清单为空，播放为占位操作', { code: 'E_NOT_FOUND', module: MODULE_ID });
      return;
    }
    const track = tracks.find((item) => item.id === state.id) || tracks[0];
    state = { ...state, id: track.id, playing: !state.playing };
    // 占位：真实播放由后续阶段的 MusicService / 解码器实现。
    await emit(ctx, 'music:play', { id: track.id });
    await saveState(ctx);
    render();
  } catch (err) {
    report(ctx, 'E_SCHEMA', '音乐播放/暂停占位操作失败', err);
  }
}

async function refresh(ctx) {
  try {
    tracks = normalizeTracks(await emit(ctx, 'music:list', {}));
    if (tracks.length && !tracks.some((item) => item.id === state.id)) state.id = tracks[0].id;
    if (!tracks.length) state.id = null;
  } catch (err) {
    tracks = [];
    report(ctx, 'E_SCHEMA', '读取音乐清单失败', err);
  }
  try {
    const saved = await emit(ctx, 'storage:get', { path: STATE_PATH, fallback: null });
    if (saved && typeof saved === 'object') {
      state = {
        id: saved.id != null ? saved.id : state.id,
        playing: !!saved.playing,
        position: Number(saved.position) || 0,
        volume: saved.volume == null ? 1 : Number(saved.volume)
      };
    }
  } catch (err) {
    report(ctx, 'E_VFS_BACKEND', '读取音乐状态失败', err);
  }
  render();
}

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    try {
      buildUi(ctx);
      await mountSelf(ctx, rootNode, SLOT_NAMES);
      render();
      await refresh(ctx);

      // 清单镜像失效时刷新曲目来源（不缓存搜索结果、不自建清单副本）。
      await on(ctx, 'storage:invalidate', (payload) => {
        try {
          const prefix = payload && payload.prefix ? String(payload.prefix) : '';
          if (prefix.startsWith('/system') || prefix === STATE_PATH) void refresh(ctx);
        } catch (err) {
          report(ctx, 'E_SCHEMA', '处理存储失效广播失败', err);
        }
      });
    } catch (err) {
      report(ctx, 'E_MODULE_INIT', '音乐条初始化失败', err);
    }
  },

  destroy() {
    const ctx = ctxRef;
    try {
      for (const { command, handler } of subscriptions) {
        try {
          ctx.bus.off(command, handler);
        } catch (err) {
          report(ctx, 'E_MODULE_INIT', `取消订阅 ${command} 失败`, err);
        }
      }
      subscriptions.length = 0;
      if (rootNode && rootNode.parentNode) rootNode.parentNode.removeChild(rootNode);
    } catch (err) {
      if (ctx) report(ctx, 'E_MODULE_INIT', '音乐条销毁失败', err);
      else console.error('[yingo] 音乐条销毁失败（通知中心不可用）', err);
    } finally {
      rootNode = null;
      titleNode = null;
      playBtn = null;
      progressNode = null;
      timeNode = null;
      tracks = [];
      state = { id: null, playing: false, position: 0, volume: 1 };
      ctxRef = null;
    }
  }
};
