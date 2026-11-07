/**
 * 构建期扫描 public/apps/<slug>/app.json → public/registry.json
 * 目录为空也产出合法空清单；运行时零扫描、零联网。
 */
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APPS = join(ROOT, 'public', 'apps');
const OUT = join(ROOT, 'public', 'registry.json');
const GROUPS = ['simulation', 'game', 'tool', 'media', 'ai', 'social', 'other'];
const THEMES = ['material-3', 'neumorphism', 'lime-tabs'];

const apps = [];
let entries = [];
try { entries = await readdir(APPS, { withFileTypes: true }); }
catch { /* apps/ 不存在视为空 */ }

for (const e of entries) {
  if (!e.isDirectory()) continue;
  const dir = join(APPS, e.name);
  const meta = join(dir, 'app.json');
  try {
    await stat(meta);
    const data = JSON.parse(await readFile(meta, 'utf8'));
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(e.name)) {
      console.warn('[gen-manifest] 跳过非 kebab-case 目录:', e.name); continue;
    }
    apps.push({ ...data, id: data.id || e.name, path: `/apps/${e.name}/` });
  } catch { /* 无 app.json 的目录不纳入清单 */ }
}
apps.sort((a, b) => (a.order ?? 999) - (b.order ?? 999) || String(a.id).localeCompare(String(b.id)));

const manifest = {
  version: 1,
  generatedAt: new Date().toISOString(),
  apps,
  plugins: [],
  themes: THEMES,
  groups: GROUPS,
};
await writeFile(OUT, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log(`[gen-manifest] ${apps.length} apps, ${THEMES.length} themes → public/registry.json`);
