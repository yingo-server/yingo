/**
 * yingotab.js — 内容仓库拉取与合并引擎
 *
 * 设置中的每个仓库条目：{ url, mode }
 *   mode = 'jsdelivr' → https://cdn.jsdelivr.net/gh/<user>/<repo>@<branch>/yingotab.yml
 *         （url 填 https://github.com/<user>/<repo> 或 <user>/<repo>）
 *   mode = 'ghproxy'  → <proxy>/<encoded raw url>/yingotab.yml（前缀代理，url 填 raw 完整地址）
 *   mode = 'pages'    → url 直接就是站点基址（如 https://user.github.io/repo/）
 *
 * 合并规则：按设置顺序拉取，apps/music/widgets 依次拼接；id 冲突时先出现的保留。
 * 输出经总线 apps:list / music:list / widgets:list 消费。
 * 结果缓存进 VFS /system/repos-manifest.json（带 TTL），失败回退缓存。
 */

import { emit } from './bus.js';
import { makeError, E } from './errors.js';

const CACHE_PATH = '/cache/repos-manifest.json';   // /cache/* 可被设置面板清理，带 TTL
const SCHEMA = 'manifest-mirror@1';
const TTL_SECONDS = 30 * 60;        // 30 分钟

export const DEFAULT_REPOS = [
  { url: 'https://github.com/yingo-server/yingo-base', mode: 'jsdelivr' },
];

/* ---------------- URL 构造 ---------------- */

export function buildYmlUrl(repo) {
  const { url, mode } = repo;
  if (!url) throw makeError(E.E_VFS_PATH, '仓库条目缺少 url', { repo });
  switch (mode) {
    case 'jsdelivr': {
      const m = /github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/#?]+))?/.exec(url) || /^([\w.-]+)\/([\w.-]+)$/.exec(url.trim());
      if (!m) throw makeError(E.E_VFS_PATH, `jsdelivr 模式需要 GitHub 仓库地址: ${url}`, { url });
      const [, owner, repoName, branch] = m;
      return `https://cdn.jsdelivr.net/gh/${owner}/${repoName}@${branch || 'main'}/yingotab.yml`;
    }
    case 'ghproxy': {
      const raw = url.includes('raw.githubusercontent.com')
        ? url.replace(/\/yingotab\.yml$/, '')
        : url.replace(/github\.com/, 'raw.githubusercontent.com').replace(/\/tree\/[^/]+/, '');
      const proxy = repo.proxy || 'https://ghproxy.net';
      return `${proxy}/${raw}/yingotab.yml`;
    }
    case 'pages': {
      // pages 模式：url 为任意静态站点基址 —— GitHub Pages / Netlify / Vercel / 自建均可。
      // 推荐把应用仓部署到 Netlify 等带全球 CDN 的平台（yml 与资源同源、MIME 正确、速度快）。
      const base = url.endsWith('/') ? url : url + '/';
      return base + 'yingotab.yml';
    }
    default:
      throw makeError(E.E_VFS_PATH, `未知仓库模式: ${mode}`, { mode });
  }
}

/** 从仓库条目推断应用/音乐的资源基址（相对 yml 所在目录） */
export function buildBaseFor(repo) {
  const ymlUrl = buildYmlUrl(repo);
  return ymlUrl.replace(/yingotab\.yml$/, '');
}

/* ---------------- YAML 解析（自写子集，零依赖） ----------------
   支持格式（CI 生成器输出的精确子集）：
   version: 1
   apps:
     - id: 'x'
       name: 'x'
       icon: 'x'
       type: dock
       entry: 'apps/x/index.html'
   music: []
   widgets: []
   --------------------------------------------------------------- */

export function parseYml(text) {
  const out = { version: 1, apps: [], music: [], widgets: [] };
  let currentList = null;
  let currentItem = null;
  let itemIndent = 0;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\t/g, '  ');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;

    // 顶层键：apps: / music: / widgets: / version: 1
    if (indent === 0) {
      const listMatch = /^([a-zA-Z][\w-]*):\s*(\[\s*\])?\s*$/.exec(line);
      if (listMatch && listMatch[1] in out && listMatch[1] !== 'version') {
        currentList = listMatch[1];
        currentItem = null;
        if (listMatch[2]) out[currentList] = [];   // 显式空列表
        continue;
      }
      const verMatch = /^version:\s*(\d+)/.exec(line);
      if (verMatch) { out.version = Number(verMatch[1]) || 1; continue; }
      continue;
    }

    // 列表项起始：- id: 'x' 或 -
    const itemMatch = /^-\s*(.*)$/.exec(line.trim());
    if (itemMatch && currentList) {
      currentItem = {};
      itemIndent = indent;
      out[currentList].push(currentItem);
      const inline = /^([\w-]+):\s*(.*)$/.exec(itemMatch[1]);
      if (inline) currentItem[inline[1]] = stripQuotes(inline[2].trim());
      continue;
    }

    // 条目字段：缩进必须比 "- " 行更深，且属于当前 item
    const kvMatch = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (kvMatch && currentList && currentItem && indent > itemIndent) {
      currentItem[kvMatch[1]] = stripQuotes(kvMatch[2].trim());
      continue;
    }
  }
  return out;
}

function stripQuotes(s) {
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) return s.slice(1, -1).replace(/\\"/g, '"');
  return s;
}

/* ---------------- 拉取 + 合并 ---------------- */

async function fetchRepo(repo, signal) {
  const ymlUrl = buildYmlUrl(repo);
  const base = buildBaseFor(repo);
  // cache-busting：CDN/浏览器缓存新鲜度由 VFS TTL 管理，网络层总是取最新
  const bust = ymlUrl + (ymlUrl.includes('?') ? '&' : '?') + 'cb=' + Math.floor(Date.now() / 600000); // 10min 粒度，兼顾缓存命中
  const res = await fetch(bust, { cache: 'default', signal });
  if (!res.ok) throw makeError(E.E_UPSTREAM, `拉取失败 ${res.status}: ${ymlUrl}`, { url: ymlUrl });
  const text = await res.text();
  const parsed = parseYml(text);
  // 给每项打上来源标记，应用 entry 用仓库基址解析为绝对 URL
  for (const app of parsed.apps || []) {
    app.source = repo.url;
    app.mode = repo.mode;
    if (app.entry && !/^https?:\/\//.test(app.entry)) app.url = base + app.entry.replace(/^\//, '');
  }
  for (const track of parsed.music || []) {
    track.source = repo.url;
    if (track.file && !/^https?:\/\//.test(track.file)) track.url = base + track.file.replace(/^\//, '');
  }
  return parsed;
}

export function mergeManifests(list) {
  const merged = { version: 1, apps: [], music: [], widgets: [], sources: [] };
  const seenApp = new Set();
  const seenMusic = new Set();
  for (const m of list) {
    if (!m) continue;
    merged.sources.push({ url: m.__source, ok: true, count: (m.apps?.length || 0) + (m.music?.length || 0) });
    for (const app of m.apps || []) {
      if (seenApp.has(app.id)) continue;
      seenApp.add(app.id);
      merged.apps.push(app);
    }
    for (const track of m.music || []) {
      const key = track.id || track.file;
      if (seenMusic.has(key)) continue;
      seenMusic.add(key);
      merged.music.push(track);
    }
    for (const w of m.widgets || []) merged.widgets.push(w);
  }
  return merged;
}

/**
 * 主入口：按设置顺序拉取全部仓库并合并。
 * @param {Array<{url,mode,proxy?}>} repos
 * @returns {{ merged, errors[] }}
 */
export async function loadRepos(repos = DEFAULT_REPOS) {
  const list = [];
  const errors = [];
  await Promise.all(repos.map(async (repo, i) => {
    try {
      const m = await fetchRepo(repo);
      m.__source = repo.url;
      list[i] = m;
    } catch (err) {
      list[i] = null;
      errors.push({ url: repo.url, mode: repo.mode, message: err?.message || String(err) });
    }
  }));
  // 失败的仓库回退：尝试上次成功缓存的整体清单（stale-while-revalidate 语义）
  let cached = null;
  try { cached = await emit('storage:get', { path: CACHE_PATH, fallback: null }); } catch { /* noop */ }
  const valid = list.filter(Boolean);
  if (!valid.length && cached?.merged) {
    // 有缓存但全部拉取失败：返回缓存，并后台尝试一次刷新
    setTimeout(() => { void loadRepos(repos).catch(() => {}); }, 1500);
    return { merged: cached.merged, errors, fromCache: true };
  }
  const merged = mergeManifests(valid);
  // 写缓存（带 TTL），失败不影响返回
  try {
    await emit('storage:set', { path: CACHE_PATH, value: { merged, savedAt: Date.now() }, schema: SCHEMA, ttl: TTL_SECONDS });
  } catch { /* noop */ }
  return { merged, errors, fromCache: false };
}

/** 从 VFS 读用户设置里的仓库列表；未配置时返回默认 */
export async function getUserRepos() {
  const saved = await emit('storage:get', { path: '/shared/repos.json', fallback: null });
  if (Array.isArray(saved?.repos) && saved.repos.length) return saved.repos;
  return DEFAULT_REPOS;
}
