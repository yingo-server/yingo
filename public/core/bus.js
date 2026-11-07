/**
 * bus.js — 强类型命令总线
 *
 * 架构约束（ADR-005）：
 *   - 总线只负责 mixin（注入能力）与命令分发，**不决定模块渲染位置**。
 *   - 每条命令经 中间件链：日志 → 权限 → schema 校验 → handler → 记录。
 *   - 所有命令调用进事件日志，诊断面板可重放。
 */

import { validate, getCommand, registerBuiltinCommands, listCommands } from './bus-schema.js';
import { makeError, serializeError, normalizeError, E } from './errors.js';

const handlers = new Map();       // command -> Set<{fn, once, id}>
const middlewares = [];           // 有序中间件
const eventLog = [];              // 可重放
const replayHandlers = new Set();
const MAX_LOG = 500;

let seq = 0;
let started = false;

/** 注册内置命令契约（core 阶段调用） */
export function initBus() {
  if (started) return;
  started = true;
  registerBuiltinCommands();
  // 内置中间件：审计日志（最先执行，最后收尾）
  use(async (cmd, payload, next) => {
    const id = ++seq;
    const entry = { id, command: cmd, payloadKeys: Object.keys(payload || {}), t0: performance.now(), status: 'pending' };
    eventLog.push(entry);
    try {
      const result = await next();
      entry.status = 'ok';
      entry.t1 = performance.now();
      return result;
    } catch (err) {
      entry.status = 'error';
      entry.t1 = performance.now();
      entry.error = serializeError(err);
      throw err;
    } finally {
      if (eventLog.length > MAX_LOG) eventLog.shift();
      for (const fn of replayHandlers) {
        try { fn({ ...entry }); } catch { /* 诊断回调不得影响主流程 */ }
      }
    }
  });
}

/** 中间件签名：async (command, payload, next) => any */
export function use(fn) {
  if (typeof fn !== 'function') throw makeError(E.E_INTERNAL, '中间件必须是函数');
  middlewares.push(fn);
  return () => {
    const i = middlewares.indexOf(fn);
    if (i >= 0) middlewares.splice(i, 1);
  };
}

/** 订阅命令；返回取消函数 */
export function on(command, fn, opts = {}) {
  if (typeof fn !== 'function') throw makeError(E.E_INTERNAL, 'handler 必须是函数');
  if (!handlers.has(command)) handlers.set(command, new Set());
  const item = { fn, once: !!opts.once, id: opts.id || `h${++seq}` };
  handlers.get(command).add(item);
  return () => handlers.get(command)?.delete(item);
}

export function off(command, fn) {
  const set = handlers.get(command);
  if (!set) return;
  for (const item of [...set]) if (item.fn === fn) set.delete(item);
}

/**
 * 分发命令。返回 handler 的返回值；无 handler 时返回 undefined（不报错）。
 * 结构类命令（system:error / notify:push）在 core 阶段也会被调用，故 initBus 必须先行。
 */
export async function emit(command, payload = {}) {
  if (!started) initBus();
  validate(command, payload);      // 强类型：未注册/字段不符直接抛 E_SCHEMA

  const def = getCommand(command);
  const ctx = { command, payload, definition: def, origin: currentOrigin, timestamp: Date.now() };

  // 组装中间件链
  let index = -1;
  const dispatch = async () => {
    const set = handlers.get(command);
    if (!set || set.size === 0) return undefined;
    const results = [];
    for (const item of [...set]) {
      if (item.once) set.delete(item);
      try {
        results.push(await item.fn(payload, ctx));
      } catch (err) {
        const e = normalizeError(err, E.E_INTERNAL);
        // handler 内异常统一进入 system:error，但不中断其它订阅者
        await safeReport(command, e);
      }
    }
    // 单订阅者直接返回值；多订阅者返回数组，便于 storage:get 之类取标量
    return results.length === 1 ? results[0] : results;
  };

  const next = async () => {
    index += 1;
    if (index < middlewares.length) return middlewares[index](command, payload, next);
    return dispatch();
  };
  return next();
}

/** 同步版本：用于启动期极早阶段（尚未有任何异步中间件时） */
export function emitSync(command, payload = {}) {
  if (!started) initBus();
  validate(command, payload);
  const set = handlers.get(command);
  if (!set || set.size === 0) return undefined;
  const results = [];
  for (const item of [...set]) {
    if (item.once) set.delete(item);
    try { results.push(item.fn(payload, { command, payload, sync: true })); }
    catch (err) { console.error('[bus] sync handler error', command, err); }
  }
  return results.length === 1 ? results[0] : results;
}

async function safeReport(command, err) {
  try {
    // 避免 system:error 自身递归
    if (command !== 'system:error' && command !== 'notify:push') {
      await emit('notify:push', {
        level: 'error',
        message: `命令 ${command} 处理失败: ${err.message}`,
        detail: { code: err.code, command },
      });
    }
  } catch { console.error('[bus] report failed', err); }
}

/**
 * ★ mixin：总线唯一负责的「注入」动作。
 * 把能力挂到目标对象上，不替目标决定做什么、渲染到哪。
 */
export function mixin(target, capabilities = {}) {
  if (!target || typeof target !== 'object') {
    throw makeError(E.E_INTERNAL, 'mixin 目标必须是对象');
  }
  for (const [key, value] of Object.entries(capabilities)) {
    if (key in target && !Object.prototype.hasOwnProperty.call(target, `__mixin_${key}`)) {
      // 允许覆盖框架占位属性，但记录痕迹便于诊断
      Object.defineProperty(target, `__mixin_${key}`, { value: target[key], enumerable: false });
    }
    Object.defineProperty(target, key, {
      value, enumerable: true, configurable: true, writable: false,
    });
  }
  return target;
}

/** 当前调用来源（由权限中间件写入，供审计） */
let currentOrigin = 'kernel';
export function setOrigin(origin) { currentOrigin = origin || 'unknown'; }
export function getOrigin() { return currentOrigin; }

/** 诊断：事件日志、命令表、重放 */
export function getEventLog() { return eventLog.map((e) => ({ ...e })); }
export function onReplay(fn) { replayHandlers.add(fn); return () => replayHandlers.delete(fn); }
export function getCommands() { return listCommands(); }

/** 重放：把某条日志的 payload 重新分发（仅用于诊断，不重放写命令） */
export async function replay(entryId, payloadOverride = null) {
  const entry = eventLog.find((e) => e.id === entryId);
  if (!entry) throw makeError(E.E_NOT_FOUND, `日志 ${entryId} 不存在`);
  if (/set|del|clear|import|migrate|gc|toggle/.test(entry.command)) {
    throw makeError(E.E_SCHEMA, '写命令不可重放', { command: entry.command });
  }
  return emit(entry.command, payloadOverride || {});
}

/** 统一异常入口：模块/Kernel 都调这个，不直接 console.error 了事 */
export async function reportError(code, message, detail = {}, cause = null) {
  const err = makeError(code, message, detail, cause);
  try {
    await emit('system:error', {
      code, stage: detail.stage || '', module: detail.module || '', detail: serializeError(err),
    });
  } catch { console.error('[yingo]', err); }
  return err;
}

export function replaceEventLogForTest(list) {
  eventLog.length = 0;
  list.forEach((e) => eventLog.push(e));
}
