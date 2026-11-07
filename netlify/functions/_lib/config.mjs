/**
 * config.mjs — 公开配置（非敏感），过滤掉任何疑似凭据字段。
 * 绝不把 process.env 里的 token 返回给前端。
 */
import { readAsset } from './assets.mjs';

const FORBIDDEN = /^(token|secret|password|apikey|api_key|authorization|access_token|private_key)$/i;

export async function loadPublicConfig() {
  return strip(await readAsset('config.json'));
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
