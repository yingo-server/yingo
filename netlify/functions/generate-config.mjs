/**
 * generate-config.mjs — 公有函数：生成 YingoTab 配置文件
 * GET /api/generate-config?repos=<url1,url2,...>&mode=<jsdelivr|ghproxy|pages>
 *
 * 拉取各内容仓库的 yingotab.yml → 合并 → 返回合并后的 JSON 与 YAML。
 * 纯只读、无鉴权、无持久化；不主动触发任何外部写操作。
 * 用途：让没有浏览器跨域问题的客户端（CI/脚本）一次性获取合并清单。
 */
const GROUPS = ['dock', 'grid'];

export const handler = async (event) => {
  const method = (event.httpMethod || 'GET').toUpperCase();
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  };
  if (method === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (method !== 'GET') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: { code: 'E_READONLY', message: '只读接口' } }) };
  }

  const q = event.queryStringParameters || {};
  const urls = (q.repos || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!urls.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: { code: 'E_SCHEMA', message: '缺少 repos 参数（逗号分隔的仓库 URL）' } }) };
  }
  const mode = ['jsdelivr', 'ghproxy', 'pages'].includes(q.mode) ? q.mode : 'jsdelivr';

  const results = await Promise.allSettled(urls.map(async (u) => {
    const ymlUrl = toYmlUrl(u, mode);
    const res = await fetch(ymlUrl, { cache: 'default' });
    if (!res.ok) throw new Error(`${res.status} ${ymlUrl}`);
    const text = await res.text();
    return { url: u, ymlUrl, parsed: parseYml(text) };
  }));

  const merged = { version: 1, apps: [], music: [], widgets: [], sources: [] };
  const seenA = new Set(), seenM = new Set();
  for (const r of results) {
    if (r.status === 'rejected') {
      merged.sources.push({ url: null, ok: false, error: String(r.reason?.message || r.reason) });
      continue;
    }
    const { url, ymlUrl, parsed } = r.value;
    merged.sources.push({ url, ymlUrl, ok: true });
    for (const a of parsed.apps || []) {
      if (seenA.has(a.id)) continue;
      seenA.add(a.id);
      merged.apps.push(a);
    }
    for (const t of parsed.music || []) {
      if (seenM.has(t.id || t.file)) continue;
      seenM.add(t.id || t.file);
      merged.music.push(t);
    }
    for (const w of parsed.widgets || []) merged.widgets.push(w);
  }
  return { statusCode: 200, headers, body: JSON.stringify(merged) };
};

function toYmlUrl(url, mode) {
  switch (mode) {
    case 'jsdelivr': {
      const m = /github\.com\/([^/]+)\/([^/#?]+)(?:\/tree\/([^/#?]+))?/.exec(url)
        || /^([\w.-]+)\/([\w.-]+)$/.exec(url.trim());
      if (!m) throw new Error(`无效 GitHub 仓库地址: ${url}`);
      return `https://cdn.jsdelivr.net/gh/${m[1]}/${m[2]}@${m[3] || 'main'}/yingotab.yml`;
    }
    case 'ghproxy': {
      const raw = url.includes('raw.githubusercontent.com')
        ? url : url.replace('github.com', 'raw.githubusercontent.com').replace(/\/tree\/[^/]+/, '');
      return `https://ghproxy.net/${raw}/yingotab.yml`;
    }
    case 'pages':
      return url.endsWith('/') ? url + 'yingotab.yml' : url + '/yingotab.yml';
    default:
      throw new Error(`未知 mode: ${mode}`);
  }
}

/** 与前端 core/yingotab.js 相同的 YAML 子集解析器 */
function parseYml(text) {
  const out = { version: 1, apps: [], music: [], widgets: [] };
  let list = null, item = null, itemIndent = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\t/g, '  ');
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const indent = line.length - line.trimStart().length;
    if (indent === 0) {
      const lm = /^([a-zA-Z][\w-]*):\s*(\[\s*\])?\s*$/.exec(line);
      if (lm && lm[1] in out && lm[1] !== 'version') { list = lm[1]; item = null; if (lm[2]) out[list] = []; continue; }
      const vm = /^version:\s*(\d+)/.exec(line);
      if (vm) { out.version = Number(vm[1]) || 1; continue; }
      continue;
    }
    const im = /^-\s*(.*)$/.exec(line.trim());
    if (im && list) { item = {}; itemIndent = indent; out[list].push(item); const kv = /^([\w-]+):\s*(.*)$/.exec(im[1]); if (kv) item[kv[1]] = unq(kv[2].trim()); continue; }
    const km = /^([\w-]+):\s*(.*)$/.exec(line.trim());
    if (km && list && item && indent > itemIndent) { item[km[1]] = unq(km[2].trim()); continue; }
  }
  return out;
}
function unq(s) {
  if (s.length >= 2 && ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))) {
    return s.slice(1, -1).replace(/''/g, "'");
  }
  return s;
}
