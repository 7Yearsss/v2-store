# V2Store（caiji-saas）

跨境铺货 SaaS：插件采集货源 → 采集箱 → 认领到店铺 → 编辑/（AI 优化）→ 发布到平台 → 托管在线商品。

产品方向与路线图见 [docs/product-plan.md](docs/product-plan.md)；在本仓库工作的约定与踩坑记录见 [AGENTS.md](AGENTS.md)。

```
apps/extension   Chrome MV3 插件：1688 详情页/整店/搜索页采集，提交原始页面给服务端解析
apps/server      Hono + Drizzle(Postgres) API：账号/团队、采集箱、店铺授权、刊登、任务队列
apps/web         React + Ant Design 工作台
packages/shared  插件 / 服务端 / 工作台共享类型与 1688 解析
```

## 开发

```bash
npm install
npm run dev:server    # http://localhost:3000（未配置 DATABASE_URL 时用内嵌 PGlite，数据在 apps/server/data/）
npm run dev:web       # http://localhost:5173（/api 代理到 3000）
npm run build:ext     # 产出 apps/extension/dist，chrome://extensions 加载已解压的扩展
npm test              # 服务端集成测试（内存 PGlite + 假 Shopify）
npm run typecheck
```

首次使用：打开 http://localhost:5173 注册 → 右上角「授权插件」→ 在 1688 商品页点「采集此商品」→ 采集箱里勾选「认领到店铺」→ 刊登管理里编辑并发布。

- 环境变量见 [apps/server/.env.example](apps/server/.env.example)；生产必须配 `DATABASE_URL` 和 `ENCRYPTION_KEY`
- 本地要连真 Postgres：`docker compose up -d`
- 改了 `apps/server/src/db/schema.ts` 后：`npm run db:generate -w @caiji/server` 生成迁移。迁移只在服务启动时执行，`tsx watch` 不会因为新迁移文件重启，**生成后要手动重启 dev:server**
- 插件信任的工作台域名在构建时指定：`EXT_APP_ORIGINS=https://app.example.com npm run build:ext`

## 核心流程与数据模型

| 步骤 | 表 | 说明 |
|---|---|---|
| 采集 | `source_items` | 按团队隔离；同一 offerId 重复采集会更新原记录 |
| 认领 | `listings` | 一个采集条目 × 一个店铺 = 一条刊登草稿；按店铺定价规则（汇率 × 加价 × 尾数）生成变体价格 |
| 发布 | `jobs` | 发布进 Postgres 任务队列（SKIP LOCKED），失败重试，最终失败原因写回刊登 |
| 店铺 | `stores` | 凭据 AES-256-GCM 加密存储；Shopify 支持 OAuth 安装 / Dev Dashboard client credentials / 旧版 Admin 令牌 |

Shopify 刊登用 `productSet`（API 2026-07），重复发布会同步更新同一个远端商品。

## 路线图

1. ✅ 地基：账号/团队、Postgres、采集箱、认领、Shopify 发布、任务队列
2. 托管：在线商品同步回拉、库存/价格同步、货源价格监控
3. AI 管线：翻译、标题/描述重写、属性补全、图片处理（接在认领后、发布前）
4. 更多渠道：Shopee / TikTok / Ozon / Amazon（实现 `ChannelAdapter`）
5. 计费：团队套餐（`workspaces.plan`）+ 用量限制

> 合规提示：采集刊登请优先对接授权货源（1688 跨境专供、一件代发供应链），直接搬运他人店铺商品在多数平台属违规行为。
