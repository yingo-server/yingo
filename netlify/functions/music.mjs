/** GET /api/music — 音乐清单（构建产物），纯只读 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handler as wrapHandler, ok } from './_lib/response.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));

export const handler = wrapHandler(async () => {
  let m;
  try {
    m = JSON.parse(await readFile(join(DIR, '..', '..', 'public', 'music.json'), 'utf8'));
  } catch {
    m = { version: 1, tracks: [] };
  }
  return ok({ version: m.version || 1, tracks: Array.isArray(m.tracks) ? m.tracks : [] });
});
