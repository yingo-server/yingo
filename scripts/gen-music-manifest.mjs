/**
 * 构建期扫描 public/assets/audio/ → public/music.json
 * 纯静态清单，函数名仅按文件名生成 slug。
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO = join(ROOT, 'public', 'assets', 'audio');
const OUT = join(ROOT, 'public', 'music.json');
const META = join(AUDIO, 'audio.json');

// 可选元数据表（中文标题、作者）；缺失时回退文件名
let TITLES = {}, ARTISTS = {};
try {
  const meta = JSON.parse(await readFile(META, 'utf8'));
  for (const [id, val] of Object.entries(meta)) {
    if (typeof val === 'string') TITLES[id] = val;
    else if (val && typeof val === 'object') { TITLES[id] = val.title; ARTISTS[id] = val.artist || ''; }
  }
} catch { /* 无元数据合法 */ }

let files = [];
try { files = await readdir(AUDIO); } catch { /* 目录不存在视为空 */ }
const tracks = files
  .filter((f) => /\.(mp3|flac|ogg|m4a)$/i.test(f))
  .sort()
  .map((f) => {
    const id = basename(f, extname(f)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return {
      id,
      title: TITLES[id] || basename(f, extname(f)),
      artist: ARTISTS[id] || '',
      file: `/assets/audio/${f}`,
      cover: null,
      duration: null,
    };
  });
await writeFile(OUT, JSON.stringify({ version: 1, tracks }, null, 2) + '\n', 'utf8');
console.log(`[gen-music] ${tracks.length} tracks → public/music.json`);
