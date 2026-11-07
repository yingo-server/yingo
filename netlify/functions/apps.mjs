/** GET /api/apps — 应用清单（构建产物），纯只读 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { handler as wrapHandler, ok } from './_lib/response.mjs';
import { E } from './_lib/errors.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const GROUPS = ['simulation', 'game', 'tool', 'media', 'ai', 'social', 'other'];

export const handler = wrapHandler(async (event) => {
  let reg;
  try {
    reg = JSON.parse(await readFile(join(DIR, '..', '..', 'public', 'registry.json'), 'utf8'));
  } catch {
    reg = { version: 1, apps: [], plugins: [], themes: [], groups: GROUPS };
  }
  let apps = Array.isArray(reg.apps) ? reg.apps : [];
  const q = (event.queryStringParameters?.q || '').toLowerCase();
  const group = event.queryStringParameters?.group || '';
  if (group) apps = apps.filter((a) => a.group === group);
  if (q) apps = apps.filter((a) => [a.name, a.id, a.description, ...(a.tags || [])].filter(Boolean).join(' ').toLowerCase().includes(q));
  return ok({ version: reg.version || 1, apps, groups: reg.groups || GROUPS });
});
