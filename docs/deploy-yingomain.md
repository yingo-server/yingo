# 部署到 Netlify 站点 yingomain

## 站点信息

| 项 | 值 |
|---|---|
| 站点名 | `yingomain` |
| Site ID | `9c5d1dab-8dce-4674-8fe3-7c73265ccd38` |
| 默认域名 | `https://yingomain.netlify.app` |
| 主自定义域 | `https://344977.xyz` |
| 别名 | `www.344977.xyz` |
| 仓库 | `https://github.com/yingo-server/yingo`（private，分支 `main`） |

旧站点 `yingo`（`yingo.netlify.app`）已改绑 `k.344977.xyz`，不再持有主域。

## Git 连接（需在 Netlify UI 完成 OAuth，API 无法代替）

1. 打开 <https://app.netlify.com/projects/yingomain/configuration/build>
2. **Build & deploy → Repository → Link to repository**
3. 选 **GitHub** → 完成 GitHub OAuth 授权（如果提示安装 Netlify GitHub App，选择仅授权 `yingo-server/yingo` 单仓）
4. 选仓库 `yingo-server/yingo`，分支 `main`
5. 构建设置应自动从 `netlify.toml` 读取，**不要**在 UI 里覆盖；确认：
   - Base directory: （留空）
   - Build command: `node scripts/gen-manifest.mjs && node scripts/gen-music-manifest.mjs`
   - Publish directory: `public`
   - Functions directory: `netlify/functions`
6. 点 **Deploy site**。之后每次 `git push origin main` 自动构建。

## 环境变量（Site configuration → Environment variables）

| 变量 | 必需 | 说明 |
|---|---|---|
| `GITHUB_TOKEN` | 否 | 未来选择性迁移旧项目时只读访问私有仓库；建议 fine-grained PAT，仅 `Contents: Read`、限定单仓 |
| `ALLOWED_ORIGINS` | 否 | 默认 `*` |

当前三个函数**纯只读**，不依赖任何环境变量即可运行。**不要**把 token 写进仓库或 `public/`。

## 部署后自检

```bash
# 主页
curl -I https://344977.xyz/
# API 只读 + CORS
curl -I https://344977.xyz/api/config
curl -I -X OPTIONS https://344977.xyz/api/apps
# 非 GET 应 405 E_READONLY
curl -X POST https://344977.xyz/api/config
# 敏感路径应 404（不回退首页）
curl -I https://344977.xyz/config.json
curl -I https://344977.xyz/netlify/functions/config.json
# 目录不应列出
curl -I https://344977.xyz/assets/
# 音乐可 Range 请求
curl -I -H 'Range: bytes=0-1023' https://344977.xyz/assets/audio/fontaine.mp3
```

## 备注

- `public/_redirects` 与 `netlify.toml` 的 `[[redirects]]` 保持同序同义；若两者冲突，Netlify 以 `_redirects` 优先。
- 静态资源缓存、CORS、目录列表禁止规则见 `public/_headers` 与 `README.md`。
- 本文件不含任何凭据。Netlify Personal Access Token 仅用于一次性站点/域名管理操作，用后建议撤销。
