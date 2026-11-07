/**
 * 规范静态校验（无第三方依赖）
 * 校验：命名 kebab-case、禁 .bak/.tmp/中文名、原生存储 API 白名单、
 *       config 无敏感字段、public 无凭据字面量、函数无写端点。
 * 失败非零退出并列出违规。
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];
const NAME_OK = /^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)*$/;
const SPECIAL = new Set(['.gitignore', '_headers', '_redirects', 'SPEC.md', 'README.md', 'LICENSE']);
const STORAGE_API = /\b(localStorage|sessionStorage|indexedDB|caches)\s*\./;
const SECRET_FIELD = /"(token|secret|password|apikey|api_key|authorization|access_token|private_key)"\s*:/i;
const CREDENTIAL = /ghp_[A-Za-z0-9]{10,}|sk-[A-Za-z0-9]{16,}/;

async function walk(dir) {
  const out = [];
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name === '.git' || e.name === 'node_modules' || e.name === '.netlify') continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

const files = await walk(ROOT);
for (const p of files) {
  const rel = relative(ROOT, p).replace(/\\/g, '/');
  const base = p.split('/').pop();
  // 1) 命名（SPECIAL 白名单 + 中文名单独报）
  if (!SPECIAL.has(base) && !NAME_OK.test(base)) problems.push(`[命名] ${rel}`);
  if (/[\u4e00-\u9fff]/.test(base)) problems.push(`[中文文件名] ${rel}`);
  if (/\.(bak|tmp|swp)$/i.test(base)) problems.push(`[临时/备份文件] ${rel}`);
  let text = '';
  try { text = await readFile(p, 'utf8'); } catch { continue; }
  // 2) 原生存储 API：仅 adapters/ 白名单
  if (rel.endsWith('.js') || rel.endsWith('.mjs')) {
    if (STORAGE_API.test(text) && !rel.includes('/storage/adapters/')) {
      problems.push(`[原生存储直调] ${rel}`);
    }
  }
  // 3) public/ 内不得有凭据字面量
  if (rel.startsWith('public/') && CREDENTIAL.test(text)) problems.push(`[凭据字面量] ${rel}`);
  // 4) config.json 不得含敏感字段
  if (base === 'config.json' && SECRET_FIELD.test(text)) problems.push(`[config 敏感字段] ${rel}`);
  // 5) 函数不得有写端点
  if (rel.startsWith('netlify/functions/') && /\b(PUT|POST|DELETE|PATCH)\b/.test(text) && /httpMethod/.test(text)) {
    problems.push(`[函数写端点] ${rel}`);
  }
  // 6) 禁止 Service Worker 注册（ADR-011）
  if (/serviceWorker\s*\.\s*register/.test(text)) problems.push(`[Service Worker 注册] ${rel}`);
}

console.log(`[check-spec] 扫描 ${files.length} 个文件`);
if (problems.length) {
  console.error(`[check-spec] ${problems.length} 项违规:`);
  for (const x of [...new Set(problems)]) console.error('  -', x);
  process.exit(1);
}
console.log('[check-spec] ✅ 全部通过');
