/**
 * stages.js — 启动阶段定义（Linux initcall 风格，ADR-004）
 * 固定 9 阶段 0→8，严格顺序推进，不做依赖图拓扑排序。
 */

export const STAGES = Object.freeze([
  { level: 0, name: 'bootloader', label: '引导装载' },
  { level: 1, name: 'core', label: '内核核心' },
  { level: 2, name: 'storage', label: '存储结构' },
  { level: 3, name: 'diagnostics', label: '诊断中心' },
  { level: 4, name: 'theme', label: '主题服务' },
  { level: 5, name: 'services', label: '系统服务' },
  { level: 6, name: 'modules', label: '内置模块' },
  { level: 7, name: 'plugins', label: '外挂加载' },
  { level: 8, name: 'userland', label: '用户态就绪' },
]);

export const STAGE_BY_NAME = Object.freeze(
  Object.fromEntries(STAGES.map((s) => [s.name, s]))
);

/** 钩子名：before:<stage> / after:<stage> / error:<stage> */
const hooks = new Map();

export function registerStageHook(stage, when, fn) {
  if (!STAGE_BY_NAME[stage]) throw new Error(`未知阶段: ${stage}`);
  if (!['before', 'after', 'error'].includes(when)) throw new Error(`未知钩子: ${when}`);
  const key = `${when}:${stage}`;
  if (!hooks.has(key)) hooks.set(key, []);
  hooks.get(key).push(fn);
  return () => {
    const arr = hooks.get(key) || [];
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
  };
}

export async function runHooks(when, stage, arg) {
  const arr = hooks.get(`${when}:${stage}`) || [];
  for (const fn of [...arr]) {
    try { await fn(arg); }
    catch (err) { console.warn(`[boot] hook ${when}:${stage} 失败`, err); }
  }
}

export function listHooks() {
  return [...hooks.entries()].map(([key, arr]) => ({ hook: key, count: arr.length }));
}
