/**
 * module-api.js — 框架提供给模块/插件的 API（ADR-005）
 * ★ 框架只提供插槽与能力，模块自己决定渲染到哪；不替模块做决定。
 */

import { emit, on, off, mixin, setOrigin, getCommands as busGetCommands } from './bus.js';
import { getService } from './service-registry.js';
import { createScopedHandle } from './storage/storage-service.js';
import { makeError, E } from './errors.js';

const slots = new Map();        // name -> HTMLElement
const modules = new Map();      // id -> manifest

/** 注册命名插槽（由布局模块调用；框架不强制任何模块使用某个插槽） */
export function registerSlot(name, node) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw makeError(E.E_INTERNAL, `插槽名不合法: ${name}`);
  if (!(node instanceof Element)) throw makeError(E.E_INTERNAL, `插槽必须是 DOM 元素: ${name}`);
  slots.set(name, node);
  return name;
}

export function slot(name) {
  // 未注册时返回 null：模块兼容层会自行回退到其它插槽或自取容器（ADR-005）
  return slots.get(name) || null;
}

export function hasSlot(name) { return slots.has(name); }
export function listSlots() { return [...slots.keys()]; }

/**
 * mount(target, node)
 * target 可为插槽名、DOM 元素、或 null（模块自取容器）。
 * ★ 位置由模块内部决定 —— 这里只是把节点放进指定容器，不做任何布局判断。
 */
export function mount(target, node) {
  let container;
  if (target == null) container = slots.get('root') || document.getElementById('yingo-root') || document.body;
  else if (typeof target === 'string') {
    container = slots.get(target);
    // 未注册插槽：返回 false 让模块自行回退（不抛异常、不替模块做决定）
    if (!container) return false;
  } else if (target instanceof Element) container = target;
  else return false;
  if (node instanceof Element) container.appendChild(node);
  else if (typeof node === 'string') container.insertAdjacentHTML('beforeend', node);
  return () => { if (node instanceof Element) node.remove(); };
}

/** 定义内置模块（静态 import 后注册） */
export function defineModule(manifest) { return define('module', manifest); }
/** 定义外挂（动态 import 后注册） */
export function definePlugin(manifest) { return define('plugin', { ...manifest, kind: 'plugin' }); }

function define(kind, manifest) {
  if (!manifest || !/^[a-z][a-z0-9-]*$/.test(manifest.id || '')) {
    throw makeError(E.E_SCHEMA, `模块 id 不合法: ${manifest?.id}`);
  }
  if (manifest.layout !== 'self-decided') {
    throw makeError(E.E_SCHEMA, `模块 ${manifest.id} 的 layout 必须为 self-decided（ADR-005）`);
  }
  if (modules.has(manifest.id)) throw makeError(E.E_SCHEMA, `模块重复注册: ${manifest.id}`);
  const entry = {
    ...manifest,
    kind,
    level: manifest.level ?? (kind === 'plugin' ? 7 : 6),
    permissions: manifest.permissions || [],
    hooks: manifest.hooks || [],
    optional: !!manifest.optional,
    enabled: manifest.enabled !== false,
    state: 'registered',
  };
  modules.set(entry.id, entry);
  return entry;
}

export function getModule(id) { return modules.get(id); }
export function listModules(kind = null) {
  return [...modules.values()].filter((m) => !kind || m.kind === kind);
}
export function setModuleState(id, state, extra = {}) {
  const m = modules.get(id);
  if (m) Object.assign(m, { state, ...extra });
}

/**
 * 构造注入给模块的 ctx。
 * ★ bus.mixin() 是总线唯一负责的注入动作：把能力挂上去，不决定模块行为。
 */
export function createModuleContext(entry) {
  const permissions = entry.permissions || [];
  const vfs = createScopedHandle(entry.id, entry.kind === 'plugin' ? 'plugin' : 'module', permissions);
  const ctx = {
    id: entry.id,
    kind: entry.kind,
    permissions,
    level: entry.level,
  };
  // mixin 注入能力；模块自己调用 mount() 决定位置
  mixin(ctx, {
    bus: {
      emit: async (cmd, payload = {}) => {
        setOrigin(entry.id);
        // 存储命令自动带上来源，供权限中间件二次校验
        if (/^storage:(set|del|clear|import)$/.test(cmd)) {
          payload = { ...payload, __origin: entry.id, __permissions: permissions };
        }
        return emit(cmd, payload);
      },
      on: (cmd, handler, opts) => on(cmd, handler, opts),
      off: (cmd, handler) => off(cmd, handler),
      mixin: (t, caps) => mixin(t, caps),
      commands: () => busGetCommands(),
    },
    mount,
    slot,
    hasSlot,
    listSlots,
    getService,
    vfs,
    notify: (level, message, detail = {}) => emit('notify:push', { level, message, detail: { ...detail, module: entry.id } }),
    requirePermission: (perm) => {
      if (!permissions.includes(perm)) {
        throw makeError(E.E_PLUGIN_PERMISSION, `模块 ${entry.id} 缺少权限 ${perm}`, { module: entry.id, perm });
      }
      return true;
    },
  });
  return ctx;
}

