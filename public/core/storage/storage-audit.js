/**
 * storage-audit.js — 审计日志与指标（§6.11）
 * 记录每次读写的 origin / path / op / t；诊断面板可筛选导出。
 */

const MAX_AUDIT = 400;
const audit = [];
let metrics = { hits: 0, misses: 0, reads: 0, writes: 0, deletes: 0, gcRuns: 0, gcRemoved: 0, migrates: 0, invalidations: 0 };

export function record(op, path, extra = {}) {
  audit.push({ op, path, t: Date.now(), ...extra });
  if (audit.length > MAX_AUDIT) audit.shift();
  if (op === 'read') metrics.reads++;
  if (op === 'write') metrics.writes++;
  if (op === 'delete') metrics.deletes++;
}

export function bump(key, n = 1) {
  if (key in metrics) metrics[key] += n;
}

export function getAudit(filter = {}) {
  return audit.filter((a) =>
    (!filter.op || a.op === filter.op) &&
    (!filter.pathPrefix || a.path.startsWith(filter.pathPrefix)) &&
    (!filter.origin || a.origin === filter.origin)
  ).map((a) => ({ ...a }));
}

export function getMetrics() {
  const total = metrics.hits + metrics.misses;
  return {
    ...metrics,
    hitRate: total ? Number((metrics.hits / total).toFixed(3)) : 0,
    auditSize: audit.length,
  };
}

export function resetMetrics() {
  metrics = { hits: 0, misses: 0, reads: 0, writes: 0, deletes: 0, gcRuns: 0, gcRemoved: 0, migrates: 0, invalidations: 0 };
  audit.length = 0;
}

/** 导出为诊断用文本 */
export function auditToText() {
  return audit.map((a) =>
    `${new Date(a.t).toLocaleTimeString()} ${a.op.padEnd(8)} ${a.path} ${a.origin || ''} ${a.code || ''}`
  ).join('\n');
}
