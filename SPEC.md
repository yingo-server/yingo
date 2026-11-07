# Yingo · 系统规范文档 (SPEC v1.3 · 已批准)

> **状态：✅ 已批准（用户「全部自主完成」）。§12 实现已按本文档落地。**
> v1.3：用户授权「全部自主完成」，§14 剩余待确认项由本文档自主定案（ADR-013），并按 §12 完成框架实现。
> v1.2：第 7 轮重问（4 问）+ 第 8 轮连带定案（4 问）**均已由用户实际回答**。Storage Fabric 定为统一 VFS / 三层介质 / 纯本地 / 三区+权限 / 不设配额 / Netlify 承担静态缓存 / JSON 导入导出；三个函数全部只读。此前按超时默认定案的残留内容已全部清除。
> 项目定位：个人主页 / 应用门户 / 可扩展应用运行时。
> 本文档粒度为「可直接开工」：含完整目录树、接口签名、总线命令表、启动阶段表、**Storage Fabric 统一虚拟文件系统（纯本地三层介质）**、API 契约、数据结构、错误码与验收清单。
> 约定：接口名、字段名、命令名一律英文；说明用中文；关键决策以 ADR 记录。

---

## 0. 术语表

| 术语 | 含义 |
|---|---|
| **Kernel** | 启动序列与生命周期管理器，负责阶段推进与模块 init |
| **Bus** | 强类型命令总线，只负责 mixin（模块注入/组合）与通知，不决定模块渲染位置 |
| **Module** | 内置核心模块，静态 `import` |
| **Plugin** | 外挂，由 `registry.json` 清单声明、运行时动态 `import` |
| **Stage** | 启动阶段（类比 Linux `initcall` 分级） |
| **Hook** | 阶段前后可注册钩子 |
| **Slot / Module API** | 框架提供给模块的渲染/注册 API；**模块自己决定渲染到哪** |
| **Manifest** | 构建期生成的静态应用索引 `registry.json` |
| **Notification** | "toast" 的正式统称：统一通知中心 + 可展开诊断面板 |
| **Storage Fabric** | 统一虚拟文件系统（VFS），带路径语义、多后端适配器、权限与 GC；**与 Kernel / Bus 同级的一级子系统** |
| **VFS 路径** | 形如 `/shared/theme/current.json` 的命名空间路径，是唯一的存储寻址方式 |
| **Adapter** | 存储后端适配器（**仅三**：memory / localstorage / indexeddb） |
| **publish 目录** | Netlify 静态发布根，其中的文件可被公网下载 |
| **functions 目录** | `netlify/functions/`，打包进 serverless bundle，**不在 publish 内，URL 不可达** |

---

## 1. 已确认决策汇总（来自 6 轮澄清）

| # | 决策 |
|---|---|
| D1 | 本地 `/var/minis/workspace/yingo` 为独立新仓库；GitHub 新建私有仓库 `yingo` |
| D2 | 旧仓 `yingo-server.github.io` 保留只读归档；**旧子项目本阶段不迁移**，未来逐个选择性迁移 |
| D3 | 域名 `344977.xyz` + `www.344977.xyz` 同绑一个 Netlify 站点；**API 不需要额外域名**，走 `/api/*` 重定向 |
| D4 | 用提供的 PAT 建仓，并把 PAT 预置为 Netlify 环境变量（不落盘到仓库） |
| D5 | 应用索引走**构建时生成 manifest**（函数不联网扫描、不实时扫描） |
| D6 | 命名规范：**kebab-case 全小写**，禁中文/空格/大写混用；每个应用带 `app.json` |
| D7 | 资源**深度清洗**：去 `.bak/.tmp`、中文名转 slug、图片转 webp、按类型归入 `assets/{audio,images,fonts}/`（本阶段只写规则，不实际迁旧文件） |
| D8 | 启动模型：**分级阶段 + 钩子**（不做依赖图拓扑排序） |
| D9 | 模块边界：**内置核心静态打包 + 清单外挂动态 import**（带权限/沙箱选项） |
| D10 | 总线：**强类型命令**（命名空间命令 + schema 校验 + 中间件 + 事件日志/重放） |
| D11 | 技术栈：**原生 ESM 零依赖、无构建**（浏览器直接 import 源码）；强类型靠运行时 schema + JSDoc（`tsc --checkJs` 可选） |
| D12 | 总线只负责 mixin；**模块自己决定布局位置**；框架提供模块 API 与插槽 |
| D13 | 异常由总线发通知（Notification，非单纯 toast） |
| D14 | 搜索：多引擎切换 + 应用过滤 + 音乐与 `!` 指令；**提交后跳转外部搜索引擎**，不做服务端搜索代理、不缓存搜索结果、不做搜索历史持久化 |
| D15 | 主题即模块；三套内置：严格 MD3 / 新拟物 / 自制"青柠标签页"风（支持自定义背景图、模糊、色调） |
| D16 | 管理范围：应用管理 + 主题外观 + 模块管理 + 数据与清理（全选） |
| D17 | 函数清单：`apps` / `music` / `config` 三个；无 `search` |
| D18 | CORS 按「资源文件 / 静态文件 / API」三类分别处理（逐路径头矩阵见 §9.3） |
| D19 | 文档：中文 + ADR、可直接开工粒度 |
| D20 | 批准后第一阶段交付：**框架骨架**（目录 + git init + 启动序列 + 总线 + 三套主题空壳 + 管理面板壳 + 三个函数），暂不填业务逻辑 |
| D21 | **缓存系统 = 文件系统管理，与 Kernel / Bus 同等重要的一级子系统；统一 VFS，插件共享同一套 API** |
| D22 | 存储介质**三层**：内存 L1 / localStorage / IndexedDB；**去掉 Cache API**（第 8 轮确认） |
| D23 | **纯本地，永不写远端**：三个函数全部只读 GET，移除 `PUT /api/config` 与 `CONFIG_ADMIN_TOKEN`（第 8 轮确认） |
| D24 | 三区 + 权限：`/system` 只读、`/module/<id>` `/plugin/<id>` 私有、`/shared` 需显式授权；**不设插件配额**（第 7 轮确认） |
| D25 | 启动阶段新增独立 `storage` 级，阶段总数 0→8（原 0→7） |
| D26 | **B 已确认**：PAT → `GITHUB_TOKEN` 环境变量，绝不落盘；函数侧 `config.json` 只放非敏感配置 |
| D27 | 全站禁止直接调用原生存储 API 与自定义裸键名；由 `check-spec.mjs` 静态校验 |
| D28 | 静态资源/HTTP 缓存**交给 Netlify CDN + `_headers` 的 `Cache-Control` + 浏览器 HTTP 缓存**；不引 Service Worker、不做前端离线缓存（第 8 轮确认） |
| D29 | 插件**不设配额**（`quotaBytes` 仅预留字段，不实现超限策略） |
| D30 | 管理面板「数据与清理」提供 **JSON 导入导出**：导出为 `.json`，导入校验 `schemaVersion` 与 schema，冲突可预览 |
| D31 | `remote` 适配器、`storage:sync`、`E_VFS_SYNC`、`E_VFS_QUOTA` 全部移除 |
| D32 | 第 7 轮四问曾超时并按默认定案，用户要求重问；**本表以第 7/8 轮实际回答为准**，推翻两处默认（介质、云端同步） |
| D33 | 「搜索引擎选择缓存」语义：**记住上次所选引擎 + 缓存自定义引擎列表**（`/shared/search/engine.json`、`/cache/search/engines.json` 带 TTL）；不缓存结果/建议/不做搜索历史 |
| D34 | 管理面板内含**可视化 VFS 文件浏览器**（树形浏览 / 预览 / 删除 / 上传 / 查看 meta） |
| D35 | 一致性 = **写穿透 + 失效广播**（已在 §6.3 / §6.6 落地） |
### 用户原话中的关键约束（逐字保留语义）

- "旧的项目先不管，到时候我们会逐个的选择性迁移。先做好整体的框架和规划……门户和整个系统框架一定要最佳的兼容性，最强的扩展性。"
- "模块化是肯定要有的，同时布局，也就是说在什么位置由模块内部决定，总线只负责 mixin。"
- "如果出现异常总线可以弹出 toast 报错；此处的 toast 只是对于通知消息或者弹窗的一种统称，那时候你要选择更合适的形式。"
- "框架提供给模块 API，具体位置由模块内部决定。"
- "关于搜索这个东西，我们只负责搜索框，具体的搜索功能跳转到搜索引擎完成。"
- "你可以把它做成 Linux 内核的启动线路。"
- "设置 CORS 头为所有，但不要开启对于文件目录。"
- "这个（PAT）可以放在我们 API 函数的文件夹索引中。"

---

## 2. ADR 记录

### ADR-001 独立新仓库，旧仓归档
- **背景**：旧仓是 167MB 的 36 个独立子站混合体，命名与结构混乱（ `.bak`、中文文件名、孤立模块）。
- **备选**：在旧仓内建子目录 / 推倒重建旧仓。
- **决定**：新建独立私有仓库 `yingo`；旧仓只读归档，未来逐个选择性迁移。
- **后果**：新仓不受历史包袱影响；迁移需按 §4 的规范逐个改造，是长期成本。

### ADR-002 构建时生成应用索引，函数不联网扫描
- **背景**：D5 与用户"API 自动扫描仓库文件夹"的初始表述存在张力。
- **决定**：`scripts/gen-manifest.mjs` 在部署前运行一次 → 产出 `registry.json` 提交进仓库；`/api/apps` 只读这份产物并补元数据。**运行时零构建、零联网扫描**。
- **备选（否决）**：函数实时调 GitHub API 扫描 —— 受速率限制、不可复现、冷启动慢。
- **后果**：新增应用需重跑脚本（可挂到 CI / Netlify build hook）；清单是唯一事实来源。
- **注**：PAT 仍预置为函数环境变量，供未来"选择性迁移"或补元数据用，但 `apps` 主路径不依赖它。

### ADR-003 无构建 + 强类型 + manifest 的调和
- **决定**：前端浏览器直接 `import` 源码，无打包器；`registry.json` 由独立 Node 脚本生成（不参与运行时）；"强类型"以运行时 schema 校验 + JSDoc 注解实现，可选 `tsc --checkJs` 做静态检查，不引入编译产物。
- **后果**：调试所见即所得；代价是无法 tree-shaking、依赖浏览器原生 ESM 与 HTTP/2。

### ADR-004 分级阶段 + 钩子（非依赖图）
- **背景**：用户要求"Linux 内核启动线路"。
- **决定**：固定 7 个 initcall 级阶段，严格顺序推进；模块在注册时声明 `level` 与 `hooks`，**不做 depends 拓扑排序**。
- **后果**：启动顺序完全可预测、可观测、可降级；跨阶段依赖靠 level 约定而非自动解析。

### ADR-005 总线只做 mixin，模块自决布局
- **决定**：Bus 提供命令、服务注册、通知、模块注入；框架提供 `mount(target)` 等模块 API 与命名插槽，**不规定任何模块的位置**。默认首页的观感由「布局模块」（本身也是一个可替换插件）决定。
- **后果**：极高扩展性；代价是不同布局模块下视觉一致性需由主题 token 保证。

### ADR-006 敏感数据不进 publish 目录（对原方案的修正）✅ **用户已确认接受（D26）**
- **背景**：用户原话要求 `config.json` 放根目录、靠私有仓库 + 函数保护、CORS 全开。
- **风险**：Netlify 会把 publish 目录内任何文件原样公开下载，`/config.json` 一旦落在其中即公网可读，与仓库私不私有无关。
- **决定**：
  - PAT / API Key → **Netlify 环境变量**（`GITHUB_TOKEN` 等），由函数 `process.env` 读取；
  - 非敏感公开配置 → `netlify/functions/config.json`（位于函数目录，**打包进 bundle 但不进 publish，URL 不可达**）；本地开发用 `config.local.json`（gitignored）覆盖；
  - 任何凭据**绝不写入** `public/`、前端 JS、HTML 或 `registry.json`。
- **后果**：静态站点零文件泄露面；函数仍可读配置（见 §9 路由问答）。

### ADR-007 搜索只做框，跳转外部引擎
- **决定**：不设 `/api/search`，不做服务端代理、不缓存结果、不持久化历史；提交时按所选引擎拼 URL 并 `location` 跳转。
- **后果**：零 Key、零 CORS 问题；应用过滤与 `!` 指令在前端本地完成。

### ADR-008 通知形式选择
- **决定**：采用「统一通知中心（Notification Center）+ 可展开诊断面板」，而非单纯 toast。轻量消息以短条呈现；模块异常/启动失败进诊断面板，含阶段、模块、错误码、堆栈、重放入口。
- **后果**：满足"异常可报错"，同时避免 toast 淹没启动期错误。

### ADR-009 Storage Fabric 作为一级子系统（统一 VFS）
- **背景**：用户强调「缓存系统也就是文件系统管理同等重要！不要做成屎」，且「后续的插件也共享」。旧仓的反面教材是散落 `localStorage` 调用、随意键名、`.bak`/`.tmp`、无版本无失效。
- **备选（否决）**：① 简单 KV + TTL；② 缓存与文件管理拆成两套系统；③ 各模块各自管理存储。
- **决定**：单一 VFS 层（§6），带目录/路径语义、**三层介质适配器**、强制元数据包装、三区权限、GC / 失效广播 / 迁移 / 审计 / 诊断；有**独立启动阶段**；所有读写走强类型总线命令 `storage:*`；插件通过 `bus.mixin()` 获得受限句柄。
- **后果**：一处实现、全站复用，插件共享有边界；代价是抽象层本身有复杂度，需要完整测试与 schema 注册纪律。
- **注**：本 ADR 的四项细节最初来自一次超时问答，用户要求重问；第 7 轮重问结果为「统一 VFS / 三层介质 / 纯本地 / 三区+权限」，**推翻了两处默认（去掉 Cache API、去掉远端同步）**，下文以重问结果为准。

### ADR-010 三个函数全部只读（对 v1.1 的修订）
- **背景**：第 8 轮用户选择「纯本地、永不写远端」+「全部移除」PUT。
- **决定**：`/api/apps`、`/api/music`、`/api/config` **仅 GET**；移除 `PUT /api/config`、`CONFIG_ADMIN_TOKEN`、`E_CONFIG_FORBIDDEN` 写鉴权分支；函数侧不做任何持久化。所有写操作由前端 Storage Fabric 完成。
- **后果**：函数变成纯粹的只读数据供给层，攻击面最小；代价是多设备配置不一致（由 D30 的 JSON 导入导出弥补）。
- **注**：`OPTIONS` 预检仍保留（CORS `*`），但 `Allow` 头收窄为 `GET,OPTIONS`。

### ADR-011 静态资源缓存交给 Netlify，不引 Service Worker
- **决定**：去掉 Cache API 适配器后，静态资源与 HTTP 响应缓存由 Netlify CDN + `_headers` 的 `Cache-Control` / `immutable` + 浏览器原生 HTTP 缓存承担；**不部署 Service Worker、不做前端离线缓存**。
- **后果**：契合「无构建、原生 ESM」；离线可用性下降，但本阶段不要求离线。

### ADR-012 「缓存」语义收敛与文件浏览器
- **背景**：用户原话「搜索引擎选择缓存」歧义较大；第 7 轮首轮超时后按默认收敛，用户要求重问，第 7/8 轮已获明确回答。
- **决定**：
  1. 搜索侧缓存只保留**记住上次引擎**与**引擎列表缓存**（`/shared/search/engine.json`、`/cache/search/engines.json` 带 TTL）；**不缓存搜索结果**（跳转外部引擎，前端拿不到）、**不缓存建议**、**不做搜索历史持久化**（与 ADR-007 一致）。
  2. 「缓存系统 = 文件系统管理」= **统一一套 VFS**（非两件独立事），管理面板提供**可视化文件浏览器**。
  3. 一致性 = 写穿透 + 失效广播；持久化 = **纯本地**（ADR-010，推翻早前的「本地优先+可选同步」）。
- **状态**：以第 7/8 轮实际回答为准，非超时默认。

### ADR-013 §14 剩余待确认项自主定案（用户授权「全部自主完成」）

| 项 | 定案 | 理由 |
|---|---|---|
| **A. 「搜索引擎选择缓存」语义** | 维持 D33：**记住上次所选引擎 + 缓存自定义引擎列表**（`/shared/search/engine.json`、`/cache/search/engines.json` 带 TTL）；**不缓存结果 / 建议 / 历史** | 搜索提交后跳转外部引擎（ADR-007），前端拿不到结果；建议缓存需第三方 API 或服务端代理，与「纯本地 / 零 Key / 不设 /api/search」冲突。这是唯一自洽解 |
| **C. 搜索框「下面接多应用、底下接音乐」** | 采用**双重覆盖**：① 默认布局模块给出「顶栏 → 搜索区 → 应用网格 → 底部音乐条」的分层观感；② 但按 D12 **这不是框架约束**，模块自决挂载点；③ 搜索模块自身同时提供**应用过滤 + 音乐匹配 + `!` 指令**，即「一个框内聚合本地结果」，主提交仍跳外部引擎 | 两种解读都成立且互不冲突；既满足用户原话的分层，又保留聚合能力，且不破坏 mixin 架构 |
| 应用分组 taxonomy | 采用 `simulation / game / tool / media / ai / social / other` 七组（在 §8 `registry.json` 的 `groups` 中落地） | 覆盖旧仓全部 36 个子站类型，且为未来迁移留余量 |
| 第三套「青柠标签页」视觉参考 | 不阻塞实现：按 §7.3 描述（标签页式卡片 + 毛玻璃 + 自定义背景图 / 模糊 / 色调 / 圆角）落地 token 与 CSS 变量；视觉细节后续可整包替换主题模块 | 主题即模块，替换不动核心 |
| 未来云端持久化 | 保持 D23 / ADR-010 **永不写远端**。若未来推翻，须重新设计鉴权、冲突策略与函数写端点，作为独立 ADR，不在本阶段预留实现 | 避免留半成品代码 |
| `GITHUB_TOKEN` 权限 | 采用 **fine-grained PAT，仅 `Contents: Read`、限定 `yingo` 单仓**；文档写明最小权限，创建仓库用的账号级 PAT 用后即弃 | 最小权限原则 |

- **后果**：§14 不再有阻塞项；实现按 §12 全量交付。

---

## 3. 目录结构（完整）

```
yingo/
├── README.md                       # 项目说明、本地启动、部署步骤
├── SPEC.md                         # 本文档
├── .gitignore
├── netlify.toml                    # publish / functions / redirects / headers
├── docs/
│   └── adr/                        # 逐条 ADR（可选拆分）
├── scripts/
│   ├── gen-manifest.mjs            # 构建期扫描 → public/registry.json
│   ├── gen-music-manifest.mjs      # 扫描 assets/audio → public/music.json
│   └── check-spec.mjs              # 校验命名规范、app.json、清单一致性
├── public/                         # ★ Netlify publish 根（公网可读，禁止放凭据）
│   ├── index.html                  # 唯一 HTML 外壳
│   ├── _headers                    # 逐路径响应头（含禁目录列表）
│   ├── _redirects                  # SPA / API 映射
│   ├── registry.json               # 构建产物：应用清单
│   ├── music.json                  # 构建产物：音乐清单
│   ├── core/                       # Kernel + Bus + 基础设施（内置模块）
│   │   ├── kernel.js
│   │   ├── boot.js
│   │   ├── stages.js
│   │   ├── bus.js
│   │   ├── bus-schema.js
│   │   ├── service-registry.js
│   │   ├── module-api.js
│   │   ├── notification.js
│   │   ├── diagnostics.js
│   │   ├── config-loader.js
│   │   ├── storage/                   # ★ Storage Fabric（一级子系统）
│   │   │   ├── vfs.js
│   │   │   ├── storage-service.js
│   │   │   ├── storage-schema.js
│   │   │   ├── storage-policy.js
│   │   │   ├── storage-gc.js
│   │   │   ├── storage-audit.js
│   │   │   └── adapters/
│   │   │       ├── memory.js
│   │   │       ├── localstorage.js
│   │   │       └── indexeddb.js
│   │   ├── permissions.js
│   │   └── errors.js
│   ├── modules/                    # 内置功能模块（每个自带 module.json）
│   │   ├── clock/                  # 右上角时间
│   │   ├── search/                 # 搜索框（多引擎 + 应用过滤 + !指令）
│   │   ├── apps-grid/              # 应用网格（读 registry.json）
│   │   ├── music-player/           # 底部音乐条
│   │   ├── theme-manager/          # 主题服务 + 切换
│   │   └── admin/                  # 管理面板壳
│   ├── themes/                     # 三套主题即模块
│   │   ├── material-3/             # 严格 MD3
│   │   ├── neumorphism/            # 新拟物
│   │   └── lime-tabs/              # 自制"青柠标签页"风（支持背景图）
│   ├── plugins/                    # 外挂（清单声明、动态 import）
│   │   └── .gitkeep
│   ├── layouts/                    # 布局模块（可替换），默认一套
│   │   └── default/
│   ├── assets/
│   │   ├── audio/                  # *.mp3 / *.flac（kebab-case）
│   │   ├── images/                 # *.webp（含用户上传背景图，走函数）
│   │   ├── fonts/                  # *.woff2
│   │   └── icons/                  # *.svg
│   ├── apps/                       # 未来逐个迁移的子应用（本阶段为空）
│   │   └── .gitkeep
│   ├── styles/
│   │   ├── tokens.css              # 主题无关的基础变量
│   │   └── base.css
│   └── vendor/                     # 若必须，第三方库固定版本，不引 CDN 运行时依赖
├── config.json                     # ★ 非敏感公开配置的源（由脚本/函数读取，不进 public）
├── config.local.json               # 本地开发凭据（gitignore，禁止提交）
└── netlify/
    └── functions/
        ├── _lib/
        │   ├── config.js           # 读 config.json + process.env
        │   ├── response.js         # 统一 CORS / 头 / 错误封装
        │   ├── auth.js             # 写操作鉴权
        │   └── github.js           # 可选：用 GITHUB_TOKEN 只读访问仓库
        ├── config.json             # 函数侧可读的非敏感配置副本（打包进 bundle）
        ├── apps.mjs                # GET /api/apps
        ├── music.mjs               # GET /api/music
        └── config.mjs              # GET /api/config（公开部分，纯只读）
```

**命名规范（D6，强制）**
- 目录 / 文件名：`^[a-z0-9]+(-[a-z0-9]+)*(\.[a-z0-9]+)?$`，全小写 kebab-case。
- 禁止：中文、空格、大写混用、`.bak`、`.tmp`、随机哈希名。
- 每个应用目录必须含 `app.json`（见 §8）。
- 资源分类固定：`assets/audio|images|fonts|icons`。
- 迁移旧资源时执行 D7 深度清洗（脚本 `scripts/check-spec.mjs` 会强制校验）。

---

## 4. 启动序列（Kernel / Linux initcall 风格）

### 4.1 阶段表（严格顺序，不拓扑排序；共 0→8 九阶段）

| Level | 名称 | 职责 | 失败策略 |
|---|---|---|---|
| 0 | `bootloader` | 解析 URL 参数、加载 `config.json` 公开部分、建立最小错误通道 | 致命，显示静态降级页 |
| 1 | `core` | 初始化 Bus、ServiceRegistry、ErrorCodes、Permissions（**不含存储**） | 致命 |
| 2 | `storage` | **Storage Fabric 初始化**：适配器注册、schema 注册、索引恢复、待迁移执行、GC 定时器 | `E_VFS_INIT` → 降级 L1-only 内存模式 + 通知，**不阻断** |
| 3 | `diagnostics` | 通知中心、诊断面板、事件日志与重放、Storage 指标接入 | 降级为 console |
| 4 | `theme` | 加载主题服务、从 `/shared/theme/current.json` 读取持久化主题、应用 tokens | 回退 `material-3` |
| 5 | `services` | 配置服务、应用索引服务、音乐服务、模块 API（清单映镜像写入 `/system/*`） | 单服务失败 → 通知 + 继续 |
| 6 | `modules` | 按 level 注册内置模块，执行各自的 `init()` | 单模块失败 → 隔离 + 通知，不阻断 |
| 7 | `plugins` | 读 `registry.json` 中 plugins，按权限动态 `import`，注入受限 VFS 句柄 | 单插件失败 → 隔离 + 通知 |
| 8 | `userland` | 触发布局模块 `mount()`，清理 `/tmp/*`，标记 `ready`，发出 `system:ready` | 通知 |

### 4.2 钩子

每个阶段暴露 `before:<stage>` / `after:<stage>` / `error:<stage>` 钩子；模块在 `module.json` 里声明 `hooks` 数组。钩子本身走 Bus 命令，可被中间件拦截与记录。

### 4.3 可观测性

- 每阶段写入 `boot.timeline[]`：`{ stage, level, t0, t1, status, modules[] }`。
- 诊断面板可展开查看时间线、错误码、模块清单、阶段耗时。
- 提供 `window.__YINGO_BOOT__` 只读快照，供 devtools 与外部诊断。

### 4.4 关键接口签名（JSDoc 形式，无编译）

```js
// core/kernel.js
/** @typedef {'bootloader'|'core'|'diagnostics'|'theme'|'services'|'modules'|'plugins'|'userland'} StageName */
/** @returns {Promise<BootReport>} */
export async function boot(/* options */);
export function registerStageHook(stage, when, fn);
export function getBootTimeline();

// core/bus.js —— 强类型命令
export function defineCommand(namespace, name, schema);
export function on(command, handler, opts);
export function emit(command, payload);       // 走 schema 校验 + 中间件
export function use(middleware);              // 日志/权限/重放
export function mixin(target, capabilities);  // ★ 总线只做 mixin
export function notify(level, message, detail);

// core/module-api.js —— 框架提供给模块，模块自决位置
export function mount(target, node);          // target 为命名插槽或模块自取容器
export function slot(name);                   // 取插槽容器，可不用
export function defineModule(manifest);
export function definePlugin(manifest);
export function getService(name);
export function requirePermission(perm);
```

---

## 5. 总线命令表（强类型，命名空间）

| 命令 | Payload schema | 方向 | 说明 |
|---|---|---|---|
| `system:boot` | `{ options }` | Kernel → all | 启动开始 |
| `system:ready` | `{ timeline }` | Kernel → all | 启动完成 |
| `system:error` | `{ code, stage, module, detail }` | any → Notification | 统一异常入口（D13） |
| `config:get` / `config:set` | `{ key, value? }` | module → ConfigService | 持久化用户配置 |
| `theme:list` / `theme:apply` | `{ id }` | module → ThemeService | 三套主题 |
| `theme:bg-set` | `{ url, blur, tint }` | admin → ThemeService | 第三套自定义背景 |
| `apps:list` / `apps:reload` | `{ filter? }` | module → AppsService | 读 `registry.json` |
| `search:submit` | `{ engine, query }` | SearchModule → 外部跳转 | D14，不经过函数 |
| `search:filter` | `{ query }` | SearchModule → AppsGrid | 本地模糊匹配 |
| `music:list` / `music:play` / `music:state` | `{ id?, state }` | MusicModule ↔ MusicService | |
| `module:list` / `module:toggle` / `module:diag` | `{ id, enabled? }` | Admin ↔ ModuleService | 外挂启停与诊断 |
| `notify:push` | `{ level, message, detail }` | any → Notification | 通知中心 |
| `storage:clear` / `data:export` / `data:import` | `{ scope, payload? }` | Admin → StorageService | 清理与导入导出 |

所有命令经 `bus-schema.js` 运行时校验；失败发 `system:error` 并携带 `E_SCHEMA`。中间件链：日志 → 权限 → 校验 → handler → 记录（供重放）。

---

## 6. Storage Fabric · 统一虚拟文件系统（一级子系统）

> **地位**：与 Kernel / Bus 同级的一级子系统，有**独立启动阶段**、独立权限模型、独立诊断视图。
> **原则**：全站只有这一套存储 API。任何模块 / 插件 / 主题**禁止**直接调用 `localStorage` / `indexedDB` / `caches` / `fetch` 缓存原生接口，也禁止各自发明键名。`scripts/check-spec.mjs` 会静态扫描并拒绝违规代码。
> **目标**：不出现旧仓那种「散落 `localStorage.setItem` + 随意键名 + `.bak`/`.tmp` 满天飞 + 无版本无失效」的屎山。

### 6.1 设计原则

| 原则 | 说明 |
|---|---|
| 单一入口 | 所有读写经强类型总线命令 `storage:*` |
| 路径语义 | 一切数据都是 VFS 路径，不是裸 key；支持目录列举、前缀查询、递归删除 |
| 分层介质 | 内存 L1 → localStorage → IndexedDB（**仅三层**），按策略自动选层 |
| 元数据强制 | 每个条目带 `version / schema / ttl / size / origin / updatedAt / contentType` |
| 隔离 + 共享 | 三区命名空间，默认私有，`/shared` 需显式授权；不设配额 |
| 可观测 | 命中率、各区占用、条目数、GC 次数、失效广播、迁移记录、审计日志全部进诊断面板 |
| 可迁移 | `schemaVersion` + `migrate()` 钩子，配置结构升级不丢用户数据 |
| 纯本地 | **永不写远端**；备份靠管理面板 JSON 导入导出（D30） |

### 6.2 VFS 路径命名空间

```
/system/                     # 框架保留，模块只读
  config.json                #   公开配置镜像（来自 /api/config）
  registry.json              #   应用清单镜像
  music.json                 #   音乐清单镜像
  boot/timeline.json         #   启动时间线
  themes/<id>/tokens.css     #   主题 token 缓存
/shared/                     # 显式授权后跨模块共享
  apps/order.json            #   应用排序（apps-grid 与 admin 共用）
  theme/current.json         #   当前主题（theme-manager 与 admin 共用）
  music/state.json           #   播放状态
  search/engines.json        #   引擎列表（缓存，见 ADR-007 补充）
/module/<module-id>/         # 内置模块私有区，其他模块默认无权访问
/plugin/<plugin-id>/         # 外挂私有区，同上
/cache/                      # 通用缓存区，带 TTL 与 GC
  images/<slug>.webp         #   背景图 / 封面（IndexedDB Blob）
  audio-meta/<id>.json       #   ID3 元数据
  search/engines.json        #   引擎列表缓存（若启用）
/tmp/                        # 会话级临时区，userland 阶段结束即清
```

**路径规则**：
- 正则 `^/(system|shared|module|plugin|cache|tmp)(/[a-z0-9-]+)*(\.[a-z0-9]+)?$`，全小写 kebab-case，与 D6 一致。
- 禁止 `..`、绝对路径逃逸、中文、空格、随机哈希目录名。
- `/module/<id>/` 与 `/plugin/<id>/` 的 `<id>` 必须与 `module.json` / 插件清单里的 `id` 一致，由框架自动注入，模块无法伪造。
- 目录是**虚拟**的：不要求后端真有目录，列举由索引实现。

### 6.3 三层介质（纯本地）

| 层 | 后端 | 承载内容 | 特性 |
|---|---|---|---|
| L1 | `memory` (Map) | 热数据、启动期临时状态、会话态 | 最快，刷新即失；**所有读写的最前置层** |
| L2 | `localstorage` | 小体积配置与偏好（< 100KB/条） | 同步 API、跨会话持久 |
| L3 | `indexeddb` | 结构化数据、大对象、音乐元数据、上传背景图 Blob、`/cache/images/*` | 异步、大容量、事务 |

> **已移除**：`cache-api`（静态资源缓存交给 Netlify，见 ADR-011）与 `remote`（纯本地，见 ADR-010）。静态资源与 HTTP 响应的缓存由 `public/_headers` 的 `Cache-Control` / `immutable` 与浏览器原生缓存承担；**不部署 Service Worker**。

**选层策略（每个路径可覆写）**：
```
/system/*        → L1 + L2（清单/配置镜像；HTTP 层缓存由 Netlify 负责）
/shared/*        → L1 + L2
/module/*        → L1 + L2（小）/ L3（大对象，按 size 阈值自动升级）
/plugin/*        → 同 /module/*（不设配额）
/cache/images/*  → L3（Blob，带 TTL）
/cache/audio-meta/* → L2
/tmp/*           → L1 only
```
**三个**适配器统一接口：`{ get, set, del, list, stat, clear }`，全部返回 Promise。L1 是强制前置层，读命中直接返回并异步回填；写采用 **write-through**（先写持久层成功再更新 L1），避免脏读。

### 6.4 条目格式（强制包装）

```js
{
  "path": "/shared/theme/current.json",
  "value": { "id": "lime-tabs", "blur": 18, "bg": "/cache/images/my-bg.webp" },
  "meta": {
    "version": 3,                 // schemaVersion，用于 migrate()
    "schema": "theme-state@1",   // 指向 bus-schema.js 中的定义
    "ttl": null,                 // null = 永久；数字 = 秒，过期由 GC 清理
    "size": 128,                 // 字节，自动计算
    "origin": "module:admin",    // 写入者，用于审计
    "contentType": "application/json",
    "createdAt": 1730000000000,
    "updatedAt": 1730000000000,
    "backend": "localstorage"
  }
}
```
- 读接口默认返回解包后的 `value`；`storage:stat` 返回完整 `meta`。
- `schema` 未注册 → 拒绝写入并报 `E_SCHEMA`。
- `version` 与当前 schema 声明的版本不符 → 自动执行注册的 `migrate(value, from, to)`，失败则隔离 + 通知，不静默丢数据。

### 6.5 权限模型（三区 + 显式授权）

| 区 | 读 | 写 | 删除 |
|---|---|---|---|
| `/system/*` | 所有模块 | **仅 Kernel / ConfigService** | 仅 Kernel |
| `/shared/*` | 所有模块 | 需 `storage:write:shared` 权限（在 `module.json` 声明） | 需 `storage:write:shared` + 审计日志 |
| `/module/<id>/*` | 仅自身 + Kernel | 仅自身 | 仅自身 + Kernel |
| `/plugin/<id>/*` | 仅自身 + Kernel | 仅自身 | 仅自身 + Kernel |
| `/cache/*` | 所有模块 | 所有模块（写自己的子路径） | GC 或所有者 |
| `/tmp/*` | 所有模块 | 所有模块 | 阶段结束自动清 |

- 权限检查是**总线中间件**的一环，不是模块自觉。越权发 `E_VFS_PERMISSION` + `system:error`。
- 插件默认拿不到 `/shared` 写权限；要共享数据必须在插件清单声明并接受管理面板审批（第一阶段记录、第二阶段做审批 UI）。
- 插件**不设配额**（D29）：`quotaBytes` 字段仅在 `module.json` schema 中预留，第一阶段不实现超限策略；未来需要时再启用，不改动 VFS 接口。

### 6.6 总线命令表（新增，强类型）

| 命令 | Payload schema | 说明 |
|---|---|---|
| `storage:get` | `{ path, fallback? }` | 读，返回解包 value |
| `storage:set` | `{ path, value, ttl?, schema }` | 写，write-through |
| `storage:del` | `{ path }` | 单条删除 |
| `storage:list` | `{ prefix, recursive? }` | 目录列举（虚拟目录） |
| `storage:stat` | `{ path }` | 取完整 meta |
| `storage:clear` | `{ prefix, scope? }` | 递归清理（管理面板"清缓存"走这条） |
| `storage:exists` | `{ path }` | 存在性检查 |
| `storage:watch` / `storage:unwatch` | `{ prefix, handlerId }` | 变更订阅 → 失效广播 |
| `storage:migrate` | `{ path, toVersion }` | 手动触发迁移 |
| `storage:usage` | `{ prefix? }` | 各区占用与条目数查询（只读观测，不做配额） |
| `storage:gc` | `{ scope? }` | 手动 GC（清理过期 `/cache/*` 与 `/tmp/*`） |
| `storage:invalidate` | `{ prefix, reason }` | 失效广播（通知订阅者） |
| `storage:export` | `{ prefixes }` | 导出备份包（不含 `/system/*`） |
| `storage:import` | `{ payload, dryRun? }` | 导入备份；`dryRun` 返回冲突预览 |

**变更广播**：任何 `set/del/clear` 成功后自动 `storage:invalidate`，订阅者（如 apps-grid 订阅 `/shared/apps/order.json`）无需轮询即可刷新。这是"多应用联动"的基础。

### 6.7 接口签名

```js
// core/vfs/vfs.js
export function createVfs(adapters, options);
export async function read(path, opts);
export async function write(path, value, meta);
export async function remove(path);
export async function list(prefix, opts);
export async function stat(path);

// core/vfs/adapters/{memory,localstorage,indexeddb}.js
export function createAdapter(config); // 统一 { get,set,del,list,stat,clear }

// core/storage/storage-service.js
export function registerSchema(name, definition, migrateFn);
export function registerPolicy(pathPrefix, policy); // 选层/ttl
export function getMetrics(); // 命中率、占用、GC 次数
```

`bus.mixin()` 会把 `vfs` 能力注入到通过权限校验的模块上下文 —— **这正是"总线只负责 mixin"在存储层的体现**：框架不替模块决定存什么、存哪，模块自己用路径表达意图，总线只做注入、权限与校验。

### 6.8 生命周期与启动集成

- 新增启动阶段 **`storage`**（Level 2，见 §4.1）：初始化适配器、注册 schema、恢复索引、执行待迁移、启动 GC 定时器。
- `diagnostics` 阶段依赖 storage 就绪，因此顺延到 Level 3；后续阶段整体 +1（共 9 阶段 0→8，已在 §5.1 落地）。
- `userland` 结束前清理 `/tmp/*`。
- 每个阶段可 `storage:watch` 订阅前置阶段产物（例如 theme 阶段订阅 `/shared/theme/current.json`）。
- 存储初始化失败 → `E_VFS_INIT`，降级为 L1-only 只读内存模式并通知，**不阻断启动**（与单模块失败隔离策略一致）。

### 6.9 插件共享细则

1. 插件 `import` 后由总线 `mixin(pluginCtx, ['vfs'])` 注入受限 VFS 句柄，句柄内已绑定 `/plugin/<id>/` 根路径（**不设配额**）。
2. 插件无法构造绝对路径访问他人私有区（路径自动前缀化 + 中间件二次校验）。
3. 需要跨插件协作时：写入方申请 `storage:write:shared`，数据落在 `/shared/<namespace>/`，读出方只需普通读权限。
4. 插件卸载时：私有区**保留**（可配置 `purgeOnUninstall`），但句柄立即失效；广播 `storage:invalidate` 让订阅者清理。
6. 插件不可访问 `/system/*` 写、不可伪造路径前缀；越权一律 `E_VFS_PERMISSION` + 审计记录。
5. 所有插件读写进审计日志（origin / path / op / t），诊断面板可筛选，管理面板可导出。

### 6.10 纯本地策略与备份（v1.2 改写）

- **永不写远端**（D23 / ADR-010）：三个函数全部只读 GET，不存在 PUT/POST 写端点，不存在 `CONFIG_ADMIN_TOKEN`，Storage Fabric 没有 `remote` 适配器、`storage:sync` 命令或 `E_VFS_SYNC`。
- 所有配置、偏好、应用排序、主题参数、音乐状态**只存在浏览器本地**（L1/L2/L3），跨设备不一致由备份机制弥补。
- **备份 = JSON 导入导出**（D30）：
  - 导出：`storage:list` 递归遍历指定区 → 打包 `{ format: "yingo-vfs@1", exportedAt, schemaVersions, entries: [{path, value, meta}] }` → Blob 下载为 `yingo-backup-<date>.json`。
  - 导入：先校验 `format` 与每个条目的 `schema` / `schemaVersion`；不匹配则执行已注册的 `migrate()`，仍失败则跳过并汇总报告；**冲突可预览**（列出将被覆盖的路径与新旧值）后才落盘。
  - 导入导出走 `storage:export` / `storage:import` 两条新增强类型命令，由管理面板调用。
  - 导出内容**不含** `/system/*`（可重建镜像），且 `check-spec.mjs` 校验导出文件不含任何凭据字段。
- 不引 Service Worker、不做离线缓存（ADR-011）；静态资源缓存由 Netlify 承担。

### 6.11 诊断与管理面板

- 诊断面板新增「Storage」页：分层命中率、各区占用与条目数、GC 次数、最近失效广播、迁移记录、审计日志、重放。
- 管理面板「数据与清理」升级为：按区/按模块清理、查看条目与 meta、**JSON 导入导出（含 schemaVersion 校验与冲突预览）**、一键 GC。
- **可视化文件浏览器（D29）**：树形浏览 `/system /shared /module /plugin /cache /tmp` 六区；点选条目展示 `value` 预览与完整 `meta`（version/schema/ttl/size/origin/backend）；支持删除、重命名（限私有区）、上传（写入 `/cache/images/*` 或 `/shared/*`）、按前缀搜索、按 `origin` 过滤审计；`/system/*` 只读且标注「框架保留」；写操作全部走 `storage:*` 命令，不绕开权限中间件。
- `window.__YINGO_BOOT__.storage` 暴露只读指标快照。

### 6.12 明确禁止（防屎山清单）

| 禁止 | 替代 |
|---|---|
| 模块直接 `localStorage.setItem('xxx', ...)` | `bus.emit('storage:set', { path, value, schema })` |
| 自定义裸键名 / 随机键 | 用 §6.2 命名空间路径 |
| `.bak` / `.tmp` / 哈希名文件 | schemaVersion + `migrate()` + `/tmp/` |
| 无 TTL 的缓存堆积 | 写 `/cache/*` 必须带 `ttl`，GC 兜底 |
| 各模块各自缓存同一份 `registry.json` | 统一放 `/system/registry.json`，订阅失效广播 |
| 静默 `try/catch` 吞掉存储错误 | 统一发 `system:error` 带 `E_VFS_*` |
| 插件直连 `fetch` 做响应缓存 | 静态资源交给 Netlify CDN；业务数据写 `/cache/*` + IndexedDB |
| 配置结构升级直接覆盖旧值 | `schemaVersion` + `migrate()` |

### 6.13 新增错误码（并入 §10 错误码表）

| Code | 含义 |
|---|---|
| `E_VFS_INIT` | 存储层初始化失败（降级内存模式） |
| `E_VFS_PERMISSION` | 越权访问路径 |
| `E_VFS_PATH` | 路径不符合命名空间/正则 |
| `E_VFS_SCHEMA` | schema 未注册或校验失败 |
| `E_VFS_MIGRATE` | 版本迁移失败 |
| `E_VFS_BACKEND` | 后端适配器失败（自动降级下一层） |
| `E_VFS_EXPORT` | 备份导出/导入校验失败（含 schemaVersion 不匹配） |

### 6.14 决策来源登记表（第 7/8 轮已回答）

| 轮次 | 问题 | 最终值 | 依据 |
|---|---|---|---|
| 第 7 轮 Q1 | 子系统定位 | 统一 VFS | 用户回答 |
| 第 7 轮 Q2 | 存储后端 | 内存 L1 / localStorage / IndexedDB（**三层**） | 用户回答 |
| 第 7 轮 Q3 | 云端持久化 | **纯本地，永不写远端** | 用户回答 |
| 第 7 轮 Q4 | 插件隔离 | 三区 + 权限（**不设配额**） | 用户回答 |
| 第 8 轮 Q1 | config 端点 | **全部移除 PUT / 鉴权**，三函数纯 GET | 用户回答 |
| 第 8 轮 Q2 | 静态资源缓存 | 交给 Netlify CDN + `_headers`，不引 SW | 用户回答 |
| 第 8 轮 Q3 | 插件配额 | 不设配额（字段仅预留） | 用户回答 |
| 第 8 轮 Q4 | 备份 | JSON 导入导出，校验 schemaVersion，冲突可预览 | 用户回答 |

> 第 7 轮首轮曾超时并按默认定案，用户要求重问；**本表 8 项均为重问后的实际回答**，其中「介质四层」「本地优先+可选同步」两处默认已被推翻。早前的「超时默认登记表」已作废。
---

## 7. 模块 / 外挂契约

### 7.1 `module.json`（内置模块与主题共用）

```json
{
  "id": "search",
  "level": 5,
  "entry": "./index.js",
  "permissions": ["config:read", "apps:read"],
  "hooks": ["after:theme", "error:services"],
  "layout": "self-decided",
  "optional": false
}
```

- `layout: "self-decided"` 是**强制值**（D12）：模块内部调用 `mount()` 决定落到哪，框架不指定。
- `optional: true` 的模块失败只隔离、不阻断启动。

### 7.2 外挂（Plugin）

在 `registry.json` 的 `plugins[]` 声明：`{ id, entry, permissions, level, signature? }`。
运行时 `await import(entry)`；权限未声明则 `requirePermission()` 拒绝。
提供三种隔离级别：`same-context`（默认）/ `iframe`（postMessage 走同一 Bus 通道）/ `disabled`。
第一阶段只实现 `same-context` 与权限校验，`iframe` 预留接口。

### 7.3 主题即模块（D15）

三套主题各自是 `themes/<id>/` 下的模块，向 ThemeService 注册：
- `material-3`：严格 MD3 token（color roles、elevation、state layers、typography scale、motion），不自定义视觉。
- `neumorphism`：同底色双阴影、低对比、柔和凸起/凹陷。
- `lime-tabs`（自制）：标签页式卡片、毛玻璃（`backdrop-filter`）、**支持用户自定义背景图 + 模糊半径 + 色调 + 圆角**，参数持久化。

主题切换只换 token 集合与主题模块 CSS，不改动布局模块。主题本身也可被外挂替换/新增。

---

## 8. 数据结构

### 8.1 `app.json`（每个应用必须）

```json
{
  "id": "three-body",
  "name": "三体",
  "description": "3D 三体运动模拟",
  "icon": "orbit",
  "entry": "/apps/three-body/",
  "group": "simulation",
  "tags": ["physics", "webgl"],
  "order": 10,
  "hidden": false,
  "external": false
}
```

### 8.2 `registry.json`（构建产物，`/api/apps` 数据源）

```json
{
  "version": 1,
  "generatedAt": "2026-11-07T00:00:00Z",
  "apps": [ /* app.json 内容 + "path" */ ],
  "plugins": [ /* 见 6.2 */ ],
  "themes": ["material-3", "neumorphism", "lime-tabs"],
  "groups": ["simulation", "game", "tool", "media", "other"]
}
```

### 8.3 `music.json`

```json
{ "version": 1, "tracks": [ { "id": "fontaine", "title": "枫丹", "file": "/assets/audio/fontaine.mp3", "cover": null, "duration": null } ] }
```

### 8.4 用户配置（全部经 Storage Fabric，禁止裸键）

**不得使用 `localStorage` 裸键或 `yingo:*` 前缀**（见 §6.12 禁止清单）。所有用户配置都是 VFS 路径，由 `storage:set` 写入并经 schema 校验：

| 原裸键 | VFS 路径 | 区 |
|---|---|---|
| `yingo:theme` | `/shared/theme/current.json` | shared |
| `yingo:theme-bg` | `/shared/theme/background.json` | shared |
| `yingo:engine` | `/shared/search/engine.json` | shared |
| `yingo:apps-order` | `/shared/apps/order.json` | shared |
| `yingo:modules-enabled` | `/module/admin/enabled.json` | module 私有 |
| `yingo:music-state` | `/shared/music/state.json` | shared |
| 引擎列表缓存 | `/cache/search/engines.json` | cache（带 TTL） |

`config.json` 里的 `api.cacheTtlSeconds` 由 StorageService 统一消费，任何模块不得自行实现过期逻辑。

### 8.5 `config.json`（非敏感公开配置）

```json
{
  "site": { "title": "Yingo", "description": "..." },
  "search": { "engines": [ { "id":"google", "url":"https://www.google.com/search?q={q}" }, { "id":"bing", "url":"https://www.bing.com/search?q={q}" }, { "id":"duckduckgo", "url":"https://duckduckgo.com/?q={q}" }, { "id":"baidu", "url":"https://www.baidu.com/s?wd={q}" } ], "defaultEngine": "duckduckgo" },
  "themes": { "default": "material-3" },
  "api": { "base": "/api", "cacheTtlSeconds": 300 }
}
```

**禁止字段**：任何 `token` / `key` / `secret` / `password`。校验脚本会扫描并拒绝。

### 8.6 环境变量（Netlify，D4）

| 变量 | 用途 |
|---|---|
| `GITHUB_TOKEN` | 提供的 PAT，函数侧只读访问私有仓库（未来迁移/元数据补全），**绝不落盘** |
| `ALLOWED_ORIGINS` | 可选，默认 `*` |

> **无写操作凭据**：三个函数均为只读 GET，不需要任何鉴权 token。

---

## 9. Netlify 部署与"函数仍可访问配置"的保证

### 9.1 `netlify.toml`（要点）

```toml
[build]
  publish = "public"
  functions = "netlify/functions"
  command = "node scripts/gen-manifest.mjs && node scripts/gen-music-manifest.mjs"

[[redirects]]
  from = "/api/*"
  to = "/.netlify/functions/:splat"
  status = 200

[[redirects]]
  from = "/*"
  to = "/index.html"
  status = 200
```

**回答用户第 5 轮反问**：函数源码在 `netlify/functions/`，由 Netlify 构建系统打包成**独立于 publish 的 serverless bundle**；`[[redirects]]` 只是把 `/api/*` 请求转发到该 bundle，不影响函数文件存在。因此 `netlify/functions/config.json` 会随 bundle 打包，函数可用 `fs.readFile` / `import` 读取；同时它**不在 `public/` 里，任何 URL 都取不到**。这就是"被规则路由之后函数还能访问到"的机制。

### 9.2 域名

`344977.xyz` 设为主域、`www.344977.xyz` 作域名别名（Netlify 自动 301 到主域）。旧域不再指向旧仓（部署阶段在 DNS/Netlify 侧切换）。**API 不另设域名**。

### 9.3 CORS 与"不开目录列表"（D18，逐路径矩阵）

| 路径类别 | 示例 | `Access-Control-Allow-Origin` | 目录列表 | 其它 |
|---|---|---|---|---|
| API | `/api/*` | `*` + `OPTIONS` 预检 + `Allow: GET,OPTIONS` | 不适用 | `Cache-Control`、无凭据 Cookie |
| 静态 HTML/JS/CSS | `/index.html`、`/core/*`、`/modules/*` | `*` | **禁止** | `X-Content-Type-Options: nosniff` |
| 资源文件 | `/assets/*` | `*` | **禁止** | `Cache-Control: public, max-age=31536000, immutable`（Netlify CDN + 浏览器原生缓存承担静态资源缓存，见 ADR-011） |
| `config.json` / 凭据 | 不在 publish 内 | 不可达 | 不可达 | 由函数侧读取 |

- 目录列表关闭由 `_headers`（`X-Content-Type-Options`、`Content-Security-Policy`）与 Netlify 默认行为（无目录索引文件即 404）共同保证；**不部署任何自动生成目录页**。
- `OPTIONS` 预检由 `_lib/response.js` 统一处理；**无写操作**，因此不需要鉴权中间件。
- 前端同源调用其实不需要 CORS，`*` 是为将来外挂/跨站调用预留（符合用户"CORS 头为所有"）。

---

## 10. 函数 API 契约（D17）

| 端点 | 方法 | 请求 | 响应 | 鉴权 |
|---|---|---|---|---|
| `/api/apps` | GET | `?group=&q=` | `200 { version, apps[], groups[] }` | 无 |
| `/api/music` | GET | — | `200 { version, tracks[] }` | 无 |
| `/api/config` | GET | — | `200` 公开配置（`config.json` 过滤后） | 无 |
| 任意 | OPTIONS | — | `204` + CORS 头（`Allow: GET,OPTIONS`） | 无 |
| `/api/*` | PUT/POST/DELETE | — | `405 { error: { code: "E_READONLY" } }` | — |

统一错误体：`{ "error": { "code": "E_XXX", "message": "...", "detail": {...} } }`。

### 错误码表

| Code | 含义 |
|---|---|
| `E_SCHEMA` | 总线命令 / 请求体 schema 校验失败 |
| `E_BOOT_STAGE` | 启动阶段失败 |
| `E_MODULE_INIT` | 模块初始化失败（隔离） |
| `E_PLUGIN_PERMISSION` | 外挂权限不足 |
| `E_PLUGIN_LOAD` | 动态 import 失败 |
| `E_CONFIG_FORBIDDEN` | 配置含被禁止字段 |
| `E_READONLY` | 对只读 API 发起写方法 |
| `E_MANIFEST_STALE` | `registry.json` 缺失或版本不符 |
| `E_NOT_FOUND` | 应用 / 音乐条目不存在 |
| `E_UPSTREAM` | 函数侧 GitHub API 失败（仅未来迁移路径） |
| `E_INTERNAL` | 未分类内部错误 |

---

## 11. 管理与 UI 范围（D16）

| 面板 | 能力 |
|---|---|
| 应用管理 | 增删改、分组、`order`、隐藏、图标、自定义链接；改动写回用户配置层（不直接改仓库 `app.json`） |
| 主题与外观 | 三套切换；第三套背景图上传/URL、模糊、色调、圆角；持久化 |
| 模块管理 | 外挂启停、权限授予、启动阶段/优先级查看、诊断日志与重放 |
| 数据与清理 | 配置导入导出（JSON）、缓存清理、重置、`registry.json` 重载、版本/更新日志 |

默认观感（由 `layouts/default/` 模块决定，非框架强制）：顶栏右上角时间（D3 Clock 模块自决挂载点）、毛玻璃背景、搜索区、应用网格、底部常驻音乐条。**注意：这只是默认布局模块的效果，框架不限定位置。**

---

## 12. 第一阶段交付清单（D20，批准后执行）

1. 建本地目录 `/var/minis/workspace/yingo`（含 §4 完整目录树，空文件带 `.gitkeep`）。
2. `git init`；用 PAT 调 GitHub API 创建**私有仓库** `yingo` 并配置 remote；不 push 任何东西。
3. 将 PAT 写入 Netlify 环境变量的**操作说明**（不落盘、不入仓库）。
4. `netlify.toml`、`_headers`、`_redirects`、`config.json` 样例、`config.local.json` 的 gitignore 规则。
5. `core/`：kernel + stages + 强类型 bus + schema + service-registry + module-api + notification/diagnostics + permissions/errors，含 `boot.timeline` 与 `__YINGO_BOOT__`。
5b. **`core/storage/`（Storage Fabric，与 Kernel/Bus 同级）**：`vfs.js` + `storage-service.js` + `storage-schema.js` + `storage-policy.js` + `storage-gc.js` + `storage-audit.js` + **三个**适配器（memory / localstorage / indexeddb）；实现 §6.2 命名空间、§6.4 条目包装、§6.5 权限中间件、§6.6 全部 `storage:*` 命令、写穿透 + 失效广播、TTL GC、schemaVersion 迁移、`__YINGO_BOOT__.storage` 指标。
6. `modules/`：六个模块的**空壳**（`module.json` + `index.js` 仅注册与占位 `mount()`），不填业务逻辑。
7. `themes/`：三套主题的 token CSS 空壳与注册。
8. `modules/admin/`：管理面板壳（四个分区占位）+ **Storage 文件浏览器壳**（树形六区浏览、条目 meta 展示、删除、JSON 导入导出占位，见 §6.11）。
9. `netlify/functions/`：**三个纯 GET 只读函数** + `_lib/`（config / response / errors），实现读 `config.json`、CORS `*`、`OPTIONS` 预检、非 GET 返回 `405 E_READONLY`、统一错误封装；`apps`/`music` 可读空 manifest 并返回空数组；**无鉴权中间件、无写端点、无持久化**。
10. `scripts/`：两个 manifest 生成器 + `check-spec.mjs` 规范校验（含 §6.12 禁止清单静态扫描）。
11. `README.md`：本地运行、manifest 生成、部署、环境变量、域名。

**明确不做**（第一阶段）：旧项目迁移、资源实际清洗、搜索业务逻辑、音乐播放逻辑、应用 CRUD 业务逻辑、`iframe` 沙箱实现、主题市场、搜索代理/历史、**任何远端持久化或同步**（已确定永不实现）、Service Worker / 离线缓存、插件配额策略。

---

## 13. 验收清单

- [ ] `public/` 内不存在任何 token/key/secret/password 字面量（`check-spec.mjs` 扫描通过）
- [ ] 浏览器直接打开 `index.html`（本地静态服务器）能完成 0→8 全部阶段并发出 `system:ready`
- [ ] 人为让某模块 `init()` 抛错 → 启动不中断，通知中心出现条目，诊断面板可见阶段/模块/错误码
- [ ] 三套主题均可切换，`lime-tabs` 可设背景图与模糊并持久化
- [ ] `registry.json` 与 `music.json` 由脚本生成且通过 schema 校验
- [ ] `/api/apps`、`/api/music`、`GET /api/config` 返回含 `Access-Control-Allow-Origin: *`；`OPTIONS` 返回 204
- [ ] `PUT/POST/DELETE /api/*` 返回 `405 E_READONLY`；`OPTIONS` 返回 204 且 `Allow: GET,OPTIONS`
- [ ] 请求 `/config.json`、`/netlify/functions/config.json`、`/assets/` 目录均不可达（404/403，无目录列表）
- [ ] 所有目录/文件名匹配 kebab-case 正则，无 `.bak`/`.tmp`/中文名
- [ ] `git status` 干净，PAT 不在任何被追踪文件里
- [ ] `check-spec.mjs` 扫描通过：全仓无原生 `localStorage` / `indexedDB` / `caches` 直接调用（除 `adapters/` 中的三个适配器）
- [ ] 存储适配器恰好三个；无 `cache-api.js` / `remote.js`，全仓无 Service Worker 注册
- [ ] 导出备份包不含 `/system/*` 且不含任何凭据字段；导入 `dryRun` 能给出冲突预览，schemaVersion 不匹配触发 `migrate()`
- [ ] 插件句柄无配额、不可越权；`/cache/*` TTL 过期由 GC 清理
- [ ] Storage Fabric 完成 Level 2 初始化，**三个**适配器可注册，诊断面板可见命中率/占用/GC
- [ ] 插件越权访问 `/module/<other>/` 返回 `E_VFS_PERMISSION`，私有区写入正常
- [ ] `/cache/*` 条目带 TTL，GC 可清理；`storage:invalidate` 订阅者能收到失效广播
- [ ] schemaVersion 升级触发 `migrate()`，旧配置不丢失
- [ ] `config.json` 中 `api.cacheTtlSeconds` 由 StorageService 统一消费，无模块各自实现过期

---

## 14. 后续阶段（已无阻塞项）

§14 原有待确认项已由 **ADR-013 自主定案**（用户授权「全部自主完成」）。以下为实现之后可推进的长期事项，不阻塞第一阶段：

- 旧子项目逐个迁移（按 §4 命名规范与 `app.json` 改造），是否保留原 URL 路径会影响 `netlify.toml` 重定向表。
- 主题市场、第三方主题包、插件 `iframe` 沙箱。
- 插件配额策略（D29 当前不设，`quotaBytes` 字段已预留）。
- 若未来推翻 D23 引入云端持久化，需独立 ADR 设计鉴权与冲突策略。
- 应用分组 taxonomy 如随迁移膨胀，可调整 `registry.json` 的 `groups`。


---

**✅ 已批准并按 §12 完成实现。本文档为实现契约；后续变更需新增 ADR。**

> **v1.3 变更**：用户授权「全部自主完成」→ 文档批准、§14 剩余项由 ADR-013 自主定案（A/C 语义、分组 taxonomy、主题视觉、token 最小权限），并按 §12 落地实现。
> **v1.2 变更（第 7/8 轮共 8 问均已回答）**：介质改为三层（去 Cache API）、云端改为纯本地（去 PUT / remote / `CONFIG_ADMIN_TOKEN`）、插件不设配额、静态资源缓存交给 Netlify（新增 ADR-011）、备份改为 JSON 导入导出、「缓存」语义收敛 + 文件浏览器（ADR-012）；三个函数全部只读；同步更新目录树、命令表、错误码、CORS 矩阵、交付与验收清单；清理此前「超时默认」残留（重复 D28~D31、重复 ADR-011、旧登记表）。

---

## ADR-014 项目转型：开源框架 + 内容仓库生态（v2.0 · 2026-11-07）

**决策**：YingoTab 转向 Apache-2.0 开源框架，架构全面重塑：

1. **框架与内容分离**
   - 主仓 `yingo`：纯框架，不含任何应用/音乐数据
   - 内容仓库（`yingo-template` 模板 / `yingo-base` 基础应用 / `yingome` 音乐 / 用户自建）：根目录 `yingotab.yml` 清单，CI（workflow_dispatch）扫描 `apps/*/app.json`（JSON 优先，目录名兜底）与 `music/` 生成
   - 设置支持多仓库 URL 按顺序合并，id 去重先到先得

2. **三种拉取模式**：`jsdelivr`（公开仓 CDN）/ `pages`（任意静态站点：GitHub Pages / Netlify / Vercel，吃平台 CDN）/ `ghproxy`（raw 前缀代理）

3. **UI 转清风风**：全屏壁纸 + 大时钟 + 搜索胶囊 + 底部 Dock + 右侧设置抽屉；「壁纸即主题」，三套固定主题机制移除，壁纸框架预留动态渲染器接口（视频/three.js）

4. **内置模块重整**：clock / search / wallpaper / weather（Open-Meteo + ipwho.is，可固定区域）/ dock / music-player / settings；apps-grid、theme-manager、admin 移除（功能并入 dock 与 settings）

5. **函数收敛**：删除私有 apps/music/config 三函数，仅保留公有 `generate-config`（合并清单只读接口）；CI 不主动触发

6. **应用加载**：jsDeliv/raw 的 text/plain HTML 经 fetch+`<base>`+`iframe.srcdoc` 渲染；pages 模式直连

**后果**：主仓 38MB→0.4MB（音频迁往 yingome）；私有信息（域名/Site ID/部署文档）全部移除；生态可社区共建。
