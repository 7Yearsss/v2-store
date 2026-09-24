# 竞品拆解：芝麦 AI 采集助手 v1.1.0（MV3 插件）

> 来源：用户提供的插件 zip（生产构建，minified）。这是 Ozon↔1688 方向量产的同类产品，架构可直接借鉴。

## 定位

芝麦 AI（zhimai.shop）：Ozon（俄罗斯电商）卖家工具——1688 采集、Ozon 商品卡采集、以图搜款（Ozon 商品 → 1688 同款货源）、一键刊登/入库。我们产品与它的差别只在目标市场和 AI 管线深度。

## 架构：每个平台一个 MAIN-world 采集器 + 站点桥

```
content_scripts:
  ozon-sku-card-main.js   → world:MAIN  @document_end   Ozon 页采集
  1688-collect-main.js    → world:MAIN  @document_start 1688 页采集+请求嗅探
  main.tsx-loader         → 隔离世界    @document_idle  注入 React UI（SKU卡片/按钮）
  platform-bridge-main.js → world:MAIN  @zhimai.shop    自家站点 SDK 桥
```

关键设计：**MAIN world 直接读页面全局变量**，隔离世界只做 UI 和转发，两侧用 `CustomEvent`（`zm-1688-req`/`zm-1688-res`）通信。

## 1688 采集器的技术细节（可直接抄）

1. **数据源优先级**：`window.__INIT_DATA` → `window.context` → `__STORE__`/`g_config`/`__pageData` → script 标签正则兜底（"offerList" JSON 块）
2. **SKU 矩阵**：`globalData.skuModel.skuInfoMap`（specId → discountPrice/price/canBookCount）+ `skuProps`（规格名），另一路径 `result.data.Root.fields.dataJson.skuModel`；标题/图集取 `globalData.offerBaseInfo`/`tempModel`
3. **整店采集**：hook `window.fetch` + `XMLHttpRequest`，嗅探 `mtop.alibaba.alisite.cbu.server.moduleasyncservice` 响应里的 `offerList`，缓存在 `window.__ZHIMAI_1688_SHOP_OFFER_CACHE__`
4. **按 offerId 批量采集**：`collectProductByOfferId` 直接 `fetch(offer页HTML, {credentials:"include"})` 再正则提 `__INIT_DATA`——不用逐页打开就能整店搬；但**在列表页主动拒绝**（注释"防百夏"=防风控/防批量触发）
5. **规范化输出**：rows[{sku,title,price,old_price,cover_image,images[],variantAttr[{name,value}],stock}] + cardFields 摘要（priceMin/Max、skuCount、stockTotal）——基本就是我们的 OfferSku[] + CollectedOffer

## 上报与桥接

- 后端入库：`POST /ClientServer/productList/product/batchCreate`（另有 platformInquiry、platformProductList 两个变体端点）
- **proxyFetch 模式**：页面侧所有 HTTP 经 `chrome.runtime.sendMessage({type:"PROXY_FETCH"})` 转发给 background 执行——绕 CORS、统一挂 token、统一错误处理；还专门处理 MV3 的"extension context invalidated"（扩展更新后旧 content script 失效，弹 toast 提示刷新页）
- **站点桥 SDK**：自家 zhimai.shop 页面注入 `window.ZhiMaiAI = { startInquiry, startAiInquiry, ping }`，postMessage 与扩展通信——**web 工作台用同一招跟插件对话**（检测是否安装、触发采集、取登录态）
- 登录态：`zhimai_auth_token` 存 storage，站点与插件共享

## 对我们 extension 的升级点

| 我们现在 | 芝麦做法（建议采用） |
|---|---|
| 隔离世界读 script 标签文本 | **MAIN world 读 `window.__INIT_DATA`**，script 兜底 |
| 只采集详情页 | + fetch/XHR 嗅探做**整店采集缓存** + `collectProductByOfferId` 批量拉详情 HTML 解析 |
| content script 直连 server | **proxyFetch 经 background**（CORS、token、context-invalidated 处理） |
| web 端与插件无桥 | **自家域注入 `window.V2Store` SDK**（ping/collect/install-detect） |
| 单平台 | 采集器按平台分文件（1688/temu/ozon 各一 MAIN world 脚本） |

## 没看到的（差异空间）

- 它没有任何官方 API 调用迹象——纯页面层采集（印证我们的判断：1688 企业 API 门槛高，大家都走 session 采集）
- 未见合规授权货源白名单
- AI 处理应在他们服务端（插件只做采集+UI；商品字段形态为 productName/imageUrls/specifications）
