# Yingo

个人主页 / 应用门户 / 可扩展应用运行时。原生 ESM 零依赖、无构建、Netlify 静态 + Functions 部署。

## 快速开始

```bash
# 生成本地清单（首次或新增应用/音乐后）
node scripts/gen-manifest.mjs
node scripts/gen-music-manifest.mjs
node scripts/check-spec.mjs

# 本地预览（必须用自带服务器：python -m http.server 不支持 Range，
# Chromium 播放大 MP3 会失败）
python3 scripts/serve.py 8899
# 打开 http://localhost:8899/
```

`?diag` 打开诊断中心（启动时间线、总线命令、VFS 指标）；`?theme=lime-tabs` 指定主题；`?no-plugins` 禁用外挂；`?strict` 严格启动。

## 架构

- **启动序列** 0→8 九阶段（bootloader / core / storage / diagnostics / theme / services / modules / plugins / userland），见 `public/core/stages.js`。
- **总线** 强类型命令 + schema 校验 + 中间件 + 事件重放，见 `public/core/bus.js`；只做 mixin，模块自决布局位置。
- **Storage Fabric** 统一 VFS，三层介质（memory / localStorage / IndexedDB）、六区命名空间、权限、TTL GC、失效广播、schema 迁移、JSON 导入导出，见 `public/core/storage/`。
- **三套主题** `material-3`（严格 MD3）/ `neumorphism`（新拟物）/ `lime-tabs`（自制，支持自定义背景图）。
- **内置模块**（框架自身功能，与 `/apps/` 应用无关）：clock（右上角时间）、search（多引擎 + 本地应用/音乐聚合 + `!` 指令）、apps-grid（应用网格 + 拖拽排序）、music-player（真实播放/进度/音量/循环/随机/列表，状态持久化）、theme-manager、admin（四分区 + VFS 文件浏览器）。
- 详细接口见 `docs/core-api.md`，完整规范与决策见 `SPEC.md`。

### 音乐

曲目放 `public/assets/audio/`，中文标题与作者可写在 `public/assets/audio/audio.json`，然后运行
`node scripts/gen-music-manifest.mjs` 生成 `public/music.json`。
播放器是框架内置模块（不是应用），通过 `music:list` / `music:play` / `music:next` 等总线命令工作，
状态存 `/shared/music/state.json`。浏览器自动播放策略要求用户首次点击播放按钮。

## Netlify 部署

`netlify.toml`：`publish = "public"`、`functions = "netlify/functions"`，构建命令跑两个生成脚本。
`/api/*` 重定向到 `/.netlify/functions/:splat`；SPA 回退到 `/index.html`。

**三个函数全部只读（GET/OPTIONS）**：`/api/apps`、`/api/music`、`/api/config`。
无写端点、无鉴权 token、无云端持久化；非 GET 一律 `405 E_READONLY`。
所有配置与状态只存在浏览器本地 VFS，备份靠管理面板 JSON 导入导出。

### 环境变量（Netlify 控制台设置，绝不写入仓库）

| 变量 | 用途 |
|---|---|
| `GITHUB_TOKEN` | 可选，未来选择性迁移旧项目时只读访问私有仓库。建议 fine-grained PAT，仅 `Contents: Read`、限定单仓。创建仓库用的账号级 PAT 用后即弃。 |
| `ALLOWED_ORIGINS` | 可选，默认 `*`。 |

函数侧 `netlify/functions/config.json` 只放**非敏感公开配置**，随 bundle 打包、不在 publish 内，URL 不可达。
项目根 `config.json` 是同源副本；`config.local.json` 已 gitignore。

### 域名

`344977.xyz` 主域 + `www.344977.xyz` 别名，同绑一个 Netlify 站点。API 不另设域名。

### CORS 与目录列表

`public/_headers` 对 `/api/*` 返回 `Access-Control-Allow-Origin: *` + `Allow: GET,OPTIONS`；
`/assets/*` 长缓存 immutable；全局 `nosniff` / CSP。
`_redirects` 对 `/config.json`、`/netlify/*`、`/assets/` 目录显式返回 404，**不部署任何目录列表页、不回退首页 200**。
静态资源缓存完全交给 Netlify CDN 与浏览器原生缓存，不引 Service Worker（ADR-011）。

## 目录约定

目录与文件名一律 kebab-case 全小写，禁止中文/空格/`.bak`/`.tmp`。
每个应用目录需含 `app.json`；资源归入 `assets/{audio,images,fonts,icons}/`。
新增应用后重跑 `gen-manifest.mjs` 并重新部署。

## 测试

`node scripts/check-spec.mjs` 做静态规范校验。内核启动、服务层与模块集成可由 `docs/core-api.md` 所列脚本验证。
