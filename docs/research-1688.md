# 1688 调研：开放平台 API + 商品页数据结构

> 调研时间 2026-09-24。结论：采集走插件（用户已登录 session），官方 API 需要企业资质申请，两条路径并行设计。

## 1. 官方开放平台（open.1688.com）

### 接入门槛
- 需要**企业开发者账号**（个人开发者权限受限），跨境/代采类应用需单独提交场景说明审核
- 认证：AppKey + AppSecret + OAuth2.0 `access_token` + MD5 签名（`appSecret + 排序参数 + appSecret` → MD5 大写）
- 基础接口免费；高频调用买资源包
- 官方明确提供"**铺货分销**"解决方案包：一键铺货、订单回流、批量支付、自动发货——即我们产品的官方版路径，ISV 可申请

### 核心 API（网关 `https://gw.open.1688.com/openapi/param2/1/...`，v=2.0）

| 接口 | 功能 | 备注 |
|---|---|---|
| `com.alibaba.product/alibaba.product.get` | 商品详情（标题、阶梯价 priceRanges、起订量、SKU、主图、类目、店铺类型） | 他人商品可查，选品/比价基础接口 |
| `com.alibaba.product/alibaba.cpsMedia.productInfo` | 分销视角商品信息：`channelPrice`（一件代发包邮价）、`promotionPrice`、`consignPrice` | 无货源模式最关注 `channelPrice` |
| `com.alibaba.cps/alibaba.cps.queryOfferDetailActivity` | 商品营销活动（满减、包邮条件） | 补充实际成交价 |
| `com.alibaba.wholesale/alibaba.wholesale.goods.search` | 寻源通：关键词搜索 + 供应商资质筛选 | 批量选品 |
| `alibaba.wholesale.supplier.get` | 供应商详情 | |
| `alibaba.trade.orderList.get` / `alibaba.trade.get` | 采购订单列表/详情（回流后查自己订单） | 需 OAuth 授权数据层 |
| `item_search_img` | 以图搜款 | 跨境选品利器 |

### 关键业务字段
- `priceRanges`：阶梯价（按起订量分档，B2B 特征，采集刊登时选哪一档要决策）
- `channelPrice` / `consignPrice` / `promotionPrice`：分销价格体系
- 代发保障：48h 发货、7 天包退、一件代发包邮（跨境专供货源池特征）

## 2. 商品页内嵌数据结构（插件采集目标）

`https://detail.1688.com/offer/{offerId}.html` 页面内嵌 JSON：

| 数据块 | 内容 |
|---|---|
| `iDetailData` / `globalData` | 商品主信息（offerId、标题、类目、价格、图片 offerImageList） |
| `skuModel` / `skuInfoMap` | SKU 矩阵：specId、属性组合、价、canBookCount 库存 |
| `offer_details` / `desc_text` | 详情 HTML（详情图 URL 在 alicdn 图床上） |
| `shareModel` | 店铺/公司信息 |

页面本身是公开可看的（浏览器无需登录），但**数据中心 IP 裸 curl 会被风控重定向到登录页**（已实测验证：4KB 登录引导页）。这正是同类工具全部走浏览器插件的原因——插件跑在用户自己的已登录 session 里。

## 3. 采集策略决策

| 路径 | 优点 | 缺点 |
|---|---|---|
| **插件解析页内 JSON**（当前实现） | 无需资质、实时、用户自己的 session | 结构会随改版漂移，需容错 |
| 官方 API `alibaba.product.get` | 稳定字段、可批量、含分销价 | 企业资质审核，个人/小团队门槛高 |
| 第三方数据服务（onebound 等） | 免维护 | 付费、延迟、合规存疑 |

**设计**：采集端抽象出 `OfferSource` 接口，插件页解析为默认实现；官方 API 作为可选增强（拿到 appKey 后接 channelPrice）。

## 4. 参考

- open.1688.com 官方"铺货分销/跨境"方案页
- 阿里云开发者社区《1688商品详情全解析》《跨境电商 API 实战指南》
