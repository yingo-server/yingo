/**
 * weather — 天气组件（内置模块）
 * 数据：Open-Meteo（免费无 key，CORS ✓）
 * 定位：设置里可指定区域（lat/lon），未设置时用 ipwho.is 自动定位（CORS ✓）
 * 缓存：VFS /cache/weather.json，TTL 30 分钟；定位结果缓存 24h
 * UI：中部组件卡（清风风），失败静默隐藏（不占首屏）
 */

const MODULE_ID = 'weather';
const SLOT_NAMES = ['widgets', 'grid', 'main'];
const WEATHER_CACHE = '/cache/weather.json';
const GEO_CACHE = '/cache/geo.json';
const WMO = {
  0: ['晴', '☀️'], 1: ['多云', '🌤️'], 2: ['局部多云', '⛅'], 3: ['阴', '☁️'],
  45: ['雾', '🌫️'], 48: ['雾凇', '🌫️'],
  51: ['毛毛雨', '🌦️'], 53: ['毛毛雨', '🌦️'], 55: ['毛毛雨', '🌦️'],
  61: ['小雨', '🌧️'], 63: ['中雨', '🌧️'], 65: ['大雨', '🌧️'],
  66: ['冻雨', '🌧️'], 67: ['冻雨', '🌧️'],
  71: ['小雪', '🌨️'], 73: ['中雪', '🌨️'], 75: ['大雪', '❄️'], 77: ['雪粒', '❄️'],
  80: ['阵雨', '🌦️'], 81: ['阵雨', '🌦️'], 82: ['强阵雨', '⛈️'],
  85: ['阵雪', '🌨️'], 86: ['阵雪', '🌨️'],
  95: ['雷雨', '⛈️'], 96: ['雷雨夹雹', '⛈️'], 99: ['雷雨夹雹', '⛈️'],
};

let ctxRef = null;
let rootNode = null;
let destroyed = false;

function report(code, message, err) {
  try { ctxRef?.notify('error', message, { code, module: MODULE_ID, ...(err ? { message: err.message } : {}) }); }
  catch { /* noop */ }
}
async function bus(cmd, payload) {
  const r = ctxRef.bus.emit(cmd, payload);
  return r && typeof r.then === 'function' ? await r : r;
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
    } catch { /* next */ }
  }
  try { ctx.mount(null, node); } catch { document.body.appendChild(node); }
}

/* ---------------- 定位 ---------------- */

async function getLocation() {
  // 1) 用户设置优先
  const saved = await bus('storage:get', { path: '/shared/weather.json', fallback: null });
  if (saved?.lat != null && saved?.lon != null) {
    return { lat: saved.lat, lon: saved.lon, city: saved.city || '' };
  }
  // 2) 缓存（24h）
  const cached = await bus('storage:get', { path: GEO_CACHE, fallback: null });
  if (cached?.lat != null && cached?.updatedAt && Date.now() - cached.updatedAt < 24 * 3600 * 1000) {
    return cached;
  }
  // 3) ipwho.is 自动定位
  const res = await fetch('https://ipwho.is/', { cache: 'default' });
  if (!res.ok) throw new Error(`定位失败 ${res.status}`);
  const d = await res.json();
  if (d?.latitude == null) throw new Error('定位返回无效');
  const geo = { lat: d.latitude, lon: d.longitude, city: d.city || d.region || '', updatedAt: Date.now() };
  await bus('storage:set', { path: GEO_CACHE, value: geo, schema: 'any@1', ttl: 24 * 3600 }).catch(() => {});
  return geo;
}

/* ---------------- 天气 ---------------- */

async function loadWeather() {
  // 缓存 30 分钟
  const cached = await bus('storage:get', { path: WEATHER_CACHE, fallback: null });
  if (cached?.current && cached?.updatedAt && Date.now() - cached.updatedAt < 30 * 60 * 1000) {
    return cached;
  }
  const geo = await getLocation();
  const url = `https://api.open-meteo.com/v1/forecast?latitude=${geo.lat}&longitude=${geo.lon}&current=temperature_2m,weather_code,wind_speed_10m&daily=temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=1`;
  const res = await fetch(url, { cache: 'default' });
  if (!res.ok) throw new Error(`天气接口 ${res.status}`);
  const d = await res.json();
  const data = {
    city: geo.city,
    current: d.current,
    daily: d.daily,
    updatedAt: Date.now(),
  };
  await bus('storage:set', { path: WEATHER_CACHE, value: data, schema: 'any@1', ttl: 30 * 60 }).catch(() => {});
  return data;
}

/* ---------------- UI ---------------- */

function renderCard(data) {
  if (!rootNode) return;
  const cur = data.current || {};
  const code = cur.weather_code ?? -1;
  const [label, icon] = WMO[code] || ['—', '🌡️'];
  rootNode.replaceChildren();

  const head = makeEl('div', 'y-weather-head');
  head.append(makeEl('span', 'y-weather-icon', icon));
  const temp = makeEl('div', 'y-weather-temp', `${Math.round(cur.temperature_2m ?? '—')}°`);
  head.append(temp);

  const side = makeEl('div', 'y-weather-side');
  side.append(makeEl('div', 'y-weather-city', data.city || '当前位置'));
  side.append(makeEl('div', 'y-weather-label', `${label} · 风 ${(cur.wind_speed_10m ?? 0).toFixed(0)} km/h`));
  if (data.daily?.temperature_2m_max?.[0] != null) {
    side.append(makeEl('div', 'y-weather-range',
      `${Math.round(data.daily.temperature_2m_min[0])}° / ${Math.round(data.daily.temperature_2m_max[0])}°`));
  }
  head.append(side);
  rootNode.append(head);
}

function renderError(msg) {
  if (!rootNode) return;
  rootNode.replaceChildren(makeEl('p', 'y-weather-error', msg));
}

export default {
  id: MODULE_ID,

  async init(ctx) {
    ctxRef = ctx;
    destroyed = false;
    rootNode = makeEl('section', 'y-module y-weather glass');
    rootNode.dataset.moduleId = MODULE_ID;
    rootNode.append(makeEl('p', 'y-weather-error', '天气加载中…'));
    mountSelf(ctx, rootNode);
    try {
      const data = await loadWeather();
      if (!destroyed) renderCard(data);
    } catch (err) {
      if (!destroyed) {
        renderError('天气暂不可用');
        report('E_WEATHER', '天气数据加载失败', err);
        // 静默模式：10 分钟后重试一次
        setTimeout(() => {
          if (destroyed || !ctxRef) return;
          loadWeather().then(renderCard).catch(() => {});
        }, 10 * 60 * 1000);
      }
    }
  },

  destroy() {
    destroyed = true;
    rootNode?.remove();
    rootNode = null;
    ctxRef = null;
  },
};
