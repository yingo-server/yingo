/**
 * service-registry.js — 服务定位器
 * 模块通过 bus.getService(name) 取服务；服务本身不强依赖具体模块。
 */

import { makeError, E } from './errors.js';

const services = new Map();     // name -> { value, owner, registeredAt }

export function registerService(name, value, owner = 'kernel') {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw makeError(E.E_INTERNAL, `服务名不合法: ${name}`);
  }
  if (services.has(name)) {
    throw makeError(E.E_INTERNAL, `服务重复注册: ${name}`);
  }
  services.set(name, { value, owner, registeredAt: Date.now() });
  return name;
}

export function getService(name) {
  const s = services.get(name);
  if (!s) throw makeError(E.E_NOT_FOUND, `服务未注册: ${name}`, { name });
  return s.value;
}

export function hasService(name) { return services.has(name); }
export function listServices() {
  return [...services.entries()].map(([name, s]) => ({ name, owner: s.owner, registeredAt: s.registeredAt }));
}
export function unregisterService(name) { return services.delete(name); }
export function clearServices() { services.clear(); }
