/**
 * assets.mjs — 函数侧构建产物读取
 *
 * Netlify 打包函数时目录层级可能变平，硬编码 ../../public/xxx 会失效。
 * 这里按多个候选位置依次尝试；全部失败则返回内嵌兜底数据（永不 500）。
 * 同时支持通过 process.env 覆盖（便于 included_files 放在别处）。
 */
import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const ROOTS = [
  process.env.NETLIFY_ASSET_ROOT || '',
  join(DIR, '..', '..', 'public'),       // 源码结构：netlify/functions/_lib → 项目根/public
  join(DIR, '..', '..', '..', 'public'),
  join(DIR, '..', 'assets'),             // bundle 内平铺
  join(DIR, 'assets'),
  resolve('public'),
  resolve('.', 'public'),
  '/var/task/public',
  '/var/task/src/public',
].filter(Boolean);

const FALLBACKS = {
  'registry.json': { version: 1, apps: [], plugins: [], themes: [], groups: ['simulation','game','tool','media','ai','social','other'] },
  'music.json': { version: 1, tracks: [] },
  'config.json': {
    site: { title: 'Yingo', description: '个人主页 / 应用门户 / 可扩展应用运行时' },
    search: {
      engines: [
        { id: 'google', url: 'https://www.google.com/search?q={q}' },
        { id: 'bing', url: 'https://www.bing.com/search?q={q}' },
        { id: 'duckduckgo', url: 'https://duckduckgo.com/?q={q}' },
        { id: 'baidu', url: 'https://www.baidu.com/s?wd={q}' },
      ],
      defaultEngine: 'duckduckgo',
    },
    themes: { default: 'material-3' },
    api: { base: '/api', cacheTtlSeconds: 300 },
  },
};

/** 读取 JSON 构建产物；失败返回内嵌兜底，绝不抛错给客户端 */
export async function readAsset(name) {
  for (const root of ROOTS) {
    try {
      const raw = await readFile(join(root, name), 'utf8');
      return JSON.parse(raw);
    } catch { /* 试下一个候选 */ }
  }
  return FALLBACKS[name] || {};
}
