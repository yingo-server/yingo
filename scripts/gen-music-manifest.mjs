/**
 * 构建期扫描 public/assets/audio/ → public/music.json
 * 纯静态清单，函数名仅按文件名生成 slug。
 */
import { readdir, writeFile } from 'node:fs/promises';
import { join, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AUDIO = join(ROOT, 'public', 'assets', 'audio');
const OUT = join(ROOT, 'public', 'music.json');

let files = [];
try { files = await readdir(AUDIO); } catch { /* 目录不存在视为空 */ }
const tracks = files
  .filter((f) => /\.(mp3|flac|ogg|m4a)$/i.test(f))
  .sort()
  .map((f) => ({
    id: basename(f, extname(f)).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
    title: basename(f, extname(f)),
    file: `/assets/audio/${f}`,
    cover: null,
    duration: null,
  }));
await writeFile(OUT, JSON.stringify({ version: 1, tracks }, null, 2) + '\n', 'utf8');
console.log(`[gen-music] ${tracks.length} tracks → public/music.json`);
