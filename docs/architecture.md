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

- `CollectedOffer` → `Product`：采集载荷→入库草稿（已实现）
- `OfferSource`：采集来源抽象。默认实现 = 插件解析 offer 页内嵌 JSON（iDetailData/globalData/skuModel）；可选实现 = `alibaba.product.get`（需企业 appKey，可补 channelPrice 分销价）
- `ChannelAdapter`：刊登通道抽象，方法 `prepareListing(product)`、`prepareMedia()`、`publish()`、`mapOrder()`。MVP 实现 `shopify`（productSet），之后 `shopee`
- 状态机：`draft → processed（AI 完成）→ listed → error`

## 数据模型（下一步落 DB，当前 JSONL）

- `products`：Product + 各通道刊登记录 `listings[]`（channel, remoteId, status, syncedAt）
- `stores`：店铺绑定 `{channel, shopDomain/shopId, accessToken, refreshToken?, meta}`——统一 token vault
- `orders`：外部订单 + 关联货源 SKU + 采购/运单状态

## 已验证的技术事实（调研结论）

1. **1688 采集必须走插件**：数据中心裸 curl 被风控到登录页（实测）；插件用用户 session 无此问题。页内 JSON 比 DOM 稳（iDetailData/skuModel），DOM 只做兜底
2. **Shopify `productSet` 一次搞定全量同步**：专为"外部系统权威源"场景设计，MVP 刊登只调它
3. **Shopee/TikTok 共性**：叶子类目 + mandatory attributes + 图片先传拿 image_id → `ChannelAdapter` 需类目映射表 + `prepareMedia()`
4. **类目映射是最大数据工程**：LLM 推断 + 人工校正，不是纯代码问题
5. **订单回流最后一棒**：平台 webhook（Shopify `orders/create`）→ 采购（1688 trade API 或货代）→ 回填运单（`fulfillmentCreate`）

## MVP 执行顺序

1. ✅ 骨架（采集→商品库→列表）
2. 插件真实 1688 页验证提取 + SKU/图/属性完整度
3. AI 管线 job：翻译 + 标题重写 + 详情生成（LLM，先文案后图片）
4. Shopify adapter：店铺绑定（custom app token）→ productSet 刊登 → listed 状态
5. Webhook：orders/create → OrderBridge 占位
6. 之后：DB 换 Postgres、Shopee/TikTok 开发者申请、订单履约

## 合规定位

对接**授权货源**（1688 跨境专供/一件代发池，供应商主动开放采集）+ AI 本地化刊登 = 正规 SaaS；无差别搬他人店 + 洗图 = 灰色。产品默认只对授权货源池开放采集白名单时风险最低。
