/**
 * config.mjs — 读取函数侧 config.json（非敏感），过滤掉任何疑似凭据字段。
 * 绝不读取 process.env 里的 token 返回给前端；环境变量仅供未来只读访问私有仓库用。
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { E, errorBody } from './errors.mjs';

const DIR = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN = /^(token|secret|password|apikey|api_key|authorization|access_token|private_key)$/i;

export async function loadPublicConfig() {
  let cfg;
  try {
    cfg = JSON.parse(await readFile(join(DIR, '..', 'config.json'), 'utf8'));
  } catch (e) {
    throw Object.assign(new Error('函数侧 config.json 不可读'), { code: E.E_INTERNAL });
  }
  return strip(cfg);
}

function strip(v, depth = 0) {
  if (depth > 6 || v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => strip(x, depth + 1));
  const out = {};
  for (const [k, val] of Object.entries(v)) {
    if (FORBIDDEN.test(k)) continue;   // 永不外泄
    out[k] = strip(val, depth + 1);
  }
  return out;
}
