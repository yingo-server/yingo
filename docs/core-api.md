# Yingo Core · 内核与 Storage Fabric 接口速查

> 面向模块/插件开发者。契约以 `SPEC.md` 为准，本文是实现层的落地索引。

## 启动序列（0→8，严格顺序）

| Level | 阶段 | 本层做的事 |
|---|---|---|
| 0 | `bootloader` | 解析 URL flags（`?strict`、`?theme=`、`?diag`、`?no-plugins`）、注册 `root` 插槽、`config` / `flags` 服务 |
| 1 | `core` | 初始化 Bus、注册 `bus`/`errors` 服务、预注册命名插槽 `topbar` / `search` / `apps` / `music` / `sidebar` / `overlay` |
| 2 | `storage` | Storage Fabric 初始化（三适配器、schema、GC 定时器、索引恢复）、注册 `vfs` 服务 |
| 3 | `diagnostics` | 通知中心 + 诊断面板（含 Storage 指标页） |
| 4 | `theme` | 主题模块 init、读 `/shared/theme/current.json` 并 `theme:apply` |
| 5 | `services` | `config-service` / `app-services` 注册全部 handler；清单镜像写入 `/system/*`；注册 `theme` 服务定位别名 |
| 6 | `modules` | 六个内置模块 `init(ctx)`，单模块失败只隔离 + 通知 |
| 7 | `plugins` | 按 `registry.json` 的 `plugins[]` 动态 `import`，注入受限 VFS 句柄 |
| 8 | `userland` | 布局模块 init（可覆写插槽）、清理 `/tmp/*`、发 `system:ready` |

只读快照：`window.__YINGO_BOOT__`（timeline / modules / services / hooks / events / storage）。

## 模块 ctx 契约

```js
export default {
  id: 'my-module',
  async init(ctx) {
    ctx.mount('apps', node);        // 或 ctx.mount(document.body, node)；自决位置
    ctx.bus.on('apps:list', h);     // 返回取消函数
    ctx.bus.off('apps:list', h);
    await ctx.bus.emit('storage:get', { path: '/shared/x.json' });
    ctx.vfs.write('state.json', v, 'any@1');   // 相对 /module/<id>/
    ctx.getService('theme');
    ctx.notify('error', msg, { code: 'E_XXX' });
    ctx.requirePermission('storage:write:shared');
  },
  destroy() {}
};
```

- `mount(target, node)`：target 为插槽名 / DOM 元素 / null；**未注册插槽返回 `false`**（不抛错），模块自行回退。
- `slot(name)`：未注册返回 `null`。
- `layout: 'self-decided'` 是 `module.json` 的强制值（ADR-005）。

## 总线命令（强类型，schema 校验）

定义在 `core/bus-schema.js`，全部命令经中间件链：日志 → 权限 → schema → handler → 重放记录。
未注册命令或字段类型不符 → `E_SCHEMA`。

主要命名空间：`system:*`、`notify:*`、`config:*`、`theme:*`、`apps:*`、`search:*`、`music:*`、`module:*`、`storage:*`（15 条）。
`core/bus.js` 导出：`initBus / on / off / emit / emitSync / use / mixin / reportError / getEventLog / replay`。

## Storage Fabric

- 三层：`memory`(L1 强制前置) → `localstorage`(L2) → `indexeddb`(L3)。
- **无 Cache API、无 remote、无 Service Worker**；静态资源缓存交给 Netlify `_headers`。
- 六区路径：`/system`（只读）、`/shared`（写需 `storage:write:shared`）、`/module/<id>`、`/plugin/<id>`（私有）、`/cache`（TTL+GC）、`/tmp`（会话级）。
- 条目强制 meta：`version / schema / ttl / size / origin / contentType / createdAt / updatedAt / backend`。
- 写穿透：持久层成功才更新 L1；后端失败自动降级 + 通知（不静默吞错）。
- 变更自动 `storage:invalidate` 广播，订阅者无需轮询。
- 备份：`storage:export` / `storage:import`（`dryRun` 返回冲突预览），导出不含 `/system/*`，不含 Blob 内容。
- 插件句柄：`createScopedHandle(id, 'plugin', permissions)`，路径自动前缀化 + 权限中间件二次校验。

**禁止**：任何模块/主题/插件直接调用 `localStorage` / `indexedDB` / `caches`。
仅 `core/storage/adapters/{localstorage,indexeddb}.js` 两个文件是白名单，`scripts/check-spec.mjs` 会静态扫描。

## 函数（纯只读）

`/api/apps`、`/api/music`、`/api/config` 仅 GET；`OPTIONS` 返回 204 + CORS；其它方法 `405 E_READONLY`。
无鉴权 token、无写端点、无云端持久化。

## 测试

```bash
node /tmp/boot_test.mjs        # 启动 9 阶段 + VFS/广播/备份
node /tmp/services_test.mjs    # config/apps/music/theme/module 命令
node /tmp/integration_test.mjs # 六个真实模块集成
node scripts/check-spec.mjs    # 规范静态校验
```
