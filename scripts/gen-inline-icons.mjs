import fs from 'node:fs';
import path from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const ICONS = {};
const dir = path.join(ROOT, 'public', 'assets', 'icons');

for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.svg')).sort()) {
  let text = fs.readFileSync(path.join(dir, f), 'utf-8');
  text = text.split(/\s+/).join(' ').trim();
  ICONS[f.replace(/\.svg$/, '')] = text;
}

const body = JSON.stringify(ICONS);
const out = path.join(ROOT, 'public', 'core', 'inline-icons.js');
fs.writeFileSync(
  out,
  '/**\n'
  + ' * inline-icons.js — 本地图标内联表（构建期由 assets/icons/*.svg 生成，零网络请求）\n'
  + ' * 来源：Tabler Icons (MIT) 与 Lawnicons (Apache-2.0)，详见 assets/icons/README.md\n'
  + ' * 重新生成：node scripts/gen-inline-icons.mjs\n'
  + ' */\n'
  + `export const INLINE_ICONS = ${body};\n`,
);

console.log(`inline-icons.js: ${Object.keys(ICONS).length} icons, ${fs.statSync(out).size} bytes`);
