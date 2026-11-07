/** GET /api/apps — 应用清单（构建产物），纯只读 */
import { handler as wrapHandler, ok } from './_lib/response.mjs';
import { readAsset } from './_lib/assets.mjs';

const GROUPS = ['simulation', 'game', 'tool', 'media', 'ai', 'social', 'other'];

export const handler = wrapHandler(async (event) => {
  const reg = await readAsset('registry.json');
  let apps = Array.isArray(reg.apps) ? reg.apps : [];
  const q = (event.queryStringParameters?.q || '').toLowerCase();
  const group = event.queryStringParameters?.group || '';
  if (group) apps = apps.filter((a) => a.group === group);
  if (q) apps = apps.filter((a) => [a.name, a.id, a.description, ...(a.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(q));
  return ok({ version: reg.version || 1, apps, groups: reg.groups || GROUPS });
});
