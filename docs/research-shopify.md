# Shopify 调研：Admin API 刊登 + 订单回流

> 调研时间 2026-09-24。结论：Shopify 是最适合 MVP 打通闭环的目标平台——API 友好、无市场规则限制、`productSet` 就是为"外部系统同步商品"设计的。

## 1. API 选型

- **GraphQL Admin API**（官方主推，REST 逐步冻结）：`https://{shop}.myshopify.com/admin/api/{version}/graphql.json`，版本季度更新（如 2025-10）
- 关键 mutation：**`productSet`** —— 官方明确定位为"以外部系统（ERP/PIM）为权威源同步完整商品状态"，一次调用搞定 options + variants + images，支持同步/异步两种模式。比 `productCreate` + `productVariantsBulk*` 的增量组合简单得多
- Scope：`write_products`（刊登）、`read_orders`/`write_orders`（回流）

## 2. 产品模型映射（我们的 SKU ↔ Shopify）

| 1688/内部模型 | Shopify |
|---|---|
| OfferSku 规格组合 | `product.options`（最多 3 个 option）→ `variants` 组合 |
| sku.priceCny | `variant.price`（需要汇率+加价策略） |
| sku.stock | `variant.inventoryQuantities`（需绑 location） |
| images[] | `product.media`（传公网 URL，Shopify 自己拉取——图床用我们自己的 CDN/OSS） |
| title/description | `product.title` / `descriptionHtml`（AI 重写后的文案） |

## 3. 授权

- **Custom app**（MVP 推荐）：客户在自己店铺装，直接拿 `X-Shopify-Access-Token`（offline token 语义，不过期）
- **Public app**（SaaS 正式形态）：OAuth 流程 → `offline access token`（服务端任务用）或 `online token`（带用户身份），需要 Shopify Partner 审核上架
- 请求头：`X-Shopify-Access-Token: {token}`

## 4. 订单回流

- Webhook：`orders/create`、`orders/paid`、`orders/fulfilled` → 我们的 server
- 配 webhook 走 Admin API `webhookSubscriptionCreate`（GraphQL）声明式注册，或 app 配置文件声明
- 反向（代采回填）：采购到运单号后 `fulfillmentCreate` + tracking 回填到 Shopify 订单

## 5. 限流

- GraphQL 按 query cost 计点（standard 店 50 点/秒恢复速率）；批量刊登控制并发
- REST 2 req/s（standard）漏桶——直接用 GraphQL 就好

## 6. MVP 接入清单

1. 店铺绑定页：用户填 myshopify domain + custom app access token
2. `ChannelAdapter.shopify.publish(product)`：映射 SKU/options → `productSet`
3. Webhook endpoint `/api/webhooks/shopify`：`orders/create` → OrderBridge
4. （二期）`fulfillmentCreate` 回填运单号

## 7. 参考

- shopify.dev/docs/api/admin-graphql（productSet / sync-data 指南）
- shopify.dev/docs/apps/build（OAuth、webhooks）
