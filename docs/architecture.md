# v2-store 系统架构（基于调研的 MVP 决策）

> 2026-09-24。对应调研文档：research-1688.md / research-shopify.md / research-marketplaces.md

## 模块边界

```
┌─────────────┐   POST /api/collect   ┌──────────────────────────┐
│ extension   │ ────────────────────► │ server (Hono)            │
│ 采集 1688   │                       │  ├─ 商品库 store          │
└─────────────┘                       │  ├─ OfferSource 抽象      │
       ▲                              │  │   （页面JSON/官方API）  │
       │ 用户已登录 session           │  ├─ AI 管线 jobs          │
┌─────────────┐   /api/products       │  ├─ ChannelAdapter 抽象   │
│ web 工作台  │ ◄───────────────────  │  │   （shopify/shopee…）  │
│ 审阅/刊登   │                       │  └─ OrderBridge 订单回流  │
└─────────────┘                       └──────────────────────────┘
```

## 关键抽象（类型先行，packages/shared）

**多采集源 × 多目标平台是核心约束**，两个轴都做成可插拔：

- `OfferSource`：采集来源矩阵 —— 每个源平台一个实现（1688 / 淘宝 / PDD / Temu / Amazon / Ozon / 货源站群），每个实现内部采集手段三级递进：**站点内部 API 直调（最准）> 页内 JSON（默认）> DOM 兜底**，统一输出 `CollectedOffer`；形态含详情页采集、整店采集、关键词采集（dxm 拆解）
- `ChannelAdapter`：刊登通道矩阵 —— 每个目标平台一个实现（Shopify / Shopee / TikTok / WooCommerce / Ozon），统一接口 `prepareListing / prepareMedia / publish / mapOrder`；平台差异（类目映射、图片先传、属性必填）收敛在 adapter 内
- `SourcingInquiry`（询货）：反向链路，下游商品 → 货源侧以图搜款/关键词搜/售前询盘 → 供应商候选评分，详见 research-sourcing-inquiry.md
- `CollectedOffer` → `Product`：采集载荷→入库草稿（已实现）
- 状态机：`draft → processed（AI 完成）→ listed → error`

## 数据模型（2026-09-25 重建后，Postgres + Drizzle，见 apps/server/src/db/schema.ts）

- 租户：`users` / `workspaces`（计费挂这里，`plan`）/ `memberships`（owner/admin/member）/ `sessions`（网页 cookie 与插件 Bearer 共用，只存 token 的 SHA-256）
- `source_items`：采集箱（货源原料），按 workspace 隔离，offerId 去重
- `stores`：店铺授权，凭据 AES-256-GCM 加密（统一 token vault）+ 店铺级定价规则
- `listings`：认领结果 = 采集条目 × 店铺的平台侧草稿/在线商品，状态 `draft → publishing → published | failed`，`remoteId` 保证重复发布幂等
- `jobs`：Postgres 任务队列（FOR UPDATE SKIP LOCKED），发布走队列；后续 AI 管线、库存同步同样挂这里
- 待建：`orders`（外部订单 + 关联货源 SKU + 采购/运单状态）

技术栈选择：TypeScript 全栈（插件/服务端/工作台共享类型）；Hono（轻、可跑 Node/边缘）；Drizzle + Postgres（开发/测试用 PGlite 内嵌同方言，零安装）；zod 校验；工作台 React + Ant Design + React Query。

## 已验证的技术事实（调研结论）

1. **1688 采集必须走插件**：数据中心裸 curl 被风控到登录页（实测）；插件用用户 session 无此问题。页内 JSON 比 DOM 稳（iDetailData/skuModel），DOM 只做兜底
2. **Shopify `productSet` 一次搞定全量同步**：专为"外部系统权威源"场景设计，MVP 刊登只调它
3. **Shopee/TikTok 共性**：叶子类目 + mandatory attributes + 图片先传拿 image_id → `ChannelAdapter` 需类目映射表 + `prepareMedia()`
4. **类目映射是最大数据工程**：LLM 推断 + 人工校正，不是纯代码问题
5. **订单回流最后一棒**：平台 webhook（Shopify `orders/create`）→ 采购（1688 trade API 或货代）→ 回填运单（`fulfillmentCreate`）

## MVP 执行顺序

1. ✅ 骨架（采集→商品库→列表）
2. ✅ 地基重建：账号/团队多租户、Postgres、采集箱 → 认领 → 刊登草稿、任务队列
3. ✅ Shopify adapter：OAuth 安装 / Dev Dashboard client credentials / 旧版 token 三种授权 → productSet 刊登
4. 插件真实 1688 页验证提取 + SKU/图/属性完整度
5. 托管：在线商品回拉同步、库存/价格同步、Webhook（products/update、orders/create）
6. AI 管线 job：翻译 + 标题重写 + 详情生成（LLM，先文案后图片）
7. 之后：Shopee/TikTok/Ozon 开发者申请、订单履约、计费

注：Shopify 自 2026-01-01 起不能在店铺后台新建旧版自定义应用，新接入走 Dev Dashboard（client credentials，令牌 24h）或公开 App OAuth。

## 合规定位

对接**授权货源**（1688 跨境专供/一件代发池，供应商主动开放采集）+ AI 本地化刊登 = 正规 SaaS；无差别搬他人店 + 洗图 = 灰色。产品默认只对授权货源池开放采集白名单时风险最低。
