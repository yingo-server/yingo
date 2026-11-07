/** GET /api/music — 音乐清单（构建产物），纯只读 */
import { handler as wrapHandler, ok } from './_lib/response.mjs';
import { readAsset } from './_lib/assets.mjs';

export const handler = wrapHandler(async () => {
  const m = await readAsset('music.json');
  return ok({ version: m.version || 1, tracks: Array.isArray(m.tracks) ? m.tracks : [] });
});
