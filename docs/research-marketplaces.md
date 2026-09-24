# 目标刊登平台调研：Shopee / TikTok Shop / Amazon / WooCommerce

> 调研时间 2026-09-24。接入顺序建议：Shopify → Shopee → TikTok Shop →（远期 Amazon）。

## 对比总览

| 平台 | 开发者门槛 | 刊登接口 | 授权方式 | 备注 |
|---|---|---|---|---|
| Shopify | 零门槛（custom app 即建即用） | `productSet` (GraphQL) | custom app token / OAuth | MVP 首选 |
| WooCommerce | 零门槛（店自建） | REST `/wp-json/wc/v3/products` | consumer key/secret | 独立站客户顺手支持 |
| Shopee | partner 申请，有 sandbox | `v2.product.add_item` | OAuth link → code → access_token + shop_id | 东南亚主战场 |
| TikTok Shop | Partner Center + 需 TTS 卖家账号才能建 private app | `POST /product/202309/products` | OAuth → access_token + shop_cipher | 风口平台但审核周期长 |
| Amazon SP-API | Developer Central 审核最严 | Listings Items API `PUT /listings/2021-08-01/items/{sellerId}/{sku}` | LWA OAuth | 远期 |

## Shopee（open.shopee.com）要点

- 签名：`partner_id` + `partner_key` HMAC-SHA256
- 授权三步：生成授权链接（partner_id + auth_type=seller + redirect_uri）→ 卖家授权拿 code → 换/续 access_token；shop_id 与 token 绑定
- 刊登注意：
  - `category_id` 必须是**叶子类目**（get_category 树）
  - 必填属性由 `v2.product.get_attribute_tree` 返回的 `mandatory:true` 决定——**类目映射+属性映射是最大工程量**
  - 图片需先经媒体上传接口拿 `image_id` 再引用（不是直接传 URL）
- App 类型：Open App（上架分发需审核）vs Seller in-house app（自家店用）

## TikTok Shop 要点

- 入口：partner.tiktokshop.com；建 private app 的前提是**自己已有任一市场 TTS 卖家账号**
- 授权：OAuth → `access_token` + `shop_cipher`
- 刊登：`/product/202309/products`，同样有类目/属性/品牌映射问题
- 平台规则：明确禁止无货源铺货/店群——**TikTok 方向只适合授权货源模式**，且店群关联检测严（IP/收款/发货轨迹）

## 共性结论（影响架构）

1. **类目/属性映射是最重数据工程**：每家 leaf category + mandatory attributes 都不同，需要映射表 + LLM 兜底推断 + 人工校正 UI
2. **图片流转不同**：Shopify 吃 URL，Shopee/TikTok 要先上传拿内部 image_id——`ChannelAdapter` 接口要抽象 `prepareMedia()`
3. **授权都要 OAuth 中转页 + token 存储/刷新**：server 侧需要统一的 `stores` 表 + token vault
4. **API 都不难，难在审核周期**：Shopee/TikTok 应用审核数周到数月，商业上先 Shopify 跑通再申请
