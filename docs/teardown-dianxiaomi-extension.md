# 竞品拆解：店小秘助手 v2.8.81（MV3，crx 直取）

> 来源：clients2.google.com crx 通道拉取的生产包（minified，6MB）。行业头部，看它的边界才知道"采集插件"要做到多全。

## 规模感

| 维度 | 店小秘 | 芝麦 | 我们现状 |
|---|---|---|---|
| content_scripts 匹配域名 | **384 个**（货源站 + 目标站矩阵） | 3 个域（1688/ozon/自家站） | 2 个域 |
| 包体 | ~6MB，单 js 最大 2.3MB | ~1MB | <100KB |
| 平台后端数据回流 | temu/shein/虾皮 卖家后台视觉爬取 | 无 | 无 |
| 站点直连 | `externally_connectable` → dianxiaomi.com / meiyunji.net | 自家域 postMessage SDK | postMessage 桥（同思路） |

## 货源站矩阵（OfferSource 路线图直接抄）

- **国内货源/分销站**：1688、淘宝、天猫、拼多多、闲鱼(goofish)、小红书、京东、搜款网(17zwd/vvic)、网商园(k3.cn)、包牛牛(bao66.cn)、开山网(xyk3.com)、聚衣网(juyi5.cn)、幸福街、二童网、义乌购等几十个长尾货源站
- **跨境货源**：AliExpress、Alibaba.com、DHgate、Banggood、Chinavasion、优质之家(youpizhijia)等
- **目标平台也当货源**：Amazon（全站点）、eBay（20+ 站点）、Shopee（全站点）、Lazada、Walmart、Etsy、Wish、Joom、Mercado、Tokopedia——即"别人的店铺也是货源"，铺货模式的完整形态

## 采集手段（按平台分层，不止 DOM 解析）

1. **站点内部 API 直调**：大量源站直接调其内部 JSON/GraphQL 接口（`gql.tokopedia.com`、`apionline.homedepot.com/...graphql`、`api.youpizhijia.com/goods/detail-get-new`、`api.yuncloth.com`、寺库/91家纺 等）——借用户 session/cookies 打官方前端接口，比解页面 JSON 更准更全。**这是"采集不足"的主要答案：成熟工具按站点定制到接口级**
2. **页面数据解析**：`parseXxxProductId`/`getProductBaseInfo`/`parseDetailData` 等按站点模块化的解析函数（crawl.js 1.7MB 大部分是平台分支）
3. **关键词采集**：`dxm_keyword_crawl.js` 搜索结果页批量抓列表 → 逐条采（不只是"当前页一个商品"）
4. **整店采集**：同芝麦思路
5. **卖家后台回流（platformBackDataCrawl/）**：对 Temu、Shopee、SHEIN 卖家中心做**可视化页面爬取**（back_visual_crawl）——把卖家后台的订单/商品/数据抓回来，这是"店铺托管"的技术实现：不是平台给 API，是插件直接读后台页面
6. **离屏文档**：manifest 有 `offscreen.html` + `offscreen` 权限——MV3 下 DOM 解析重活搬 offscreen document 做

## 工程细节

- 权限很全：cookies / webRequest / declarativeNetRequest / offscreen / alarms / unlimitedStorage——cookies 权限意味着跨站 session 复用、webRequest 可监听请求拿数据
- `pdaPrintPluginBridge.js`：PDA 打印桥（仓库硬件对接，产品广度佐证）
- 上报：`www.dianxiaomi.com/web/productCrawl/dataAcquisition`；CDN/后端域名 meiyunji.net
- 版本策略：V2/V3 双版本并存（旧浏览器兼容），官网直发 crx 下载（绕商店审核/地域限制）

## 对我们的增量结论

1. **OfferSource 必须按源站建模**（每个源站一个 parser 模块），头部玩家覆盖 100+ 源站——但 MVP 先 1688 + 以图搜款一个就够用
2. **采集手段三件套**：站点内部 API 直调 > 页面 JSON > DOM。我们目前只有"页面 JSON + DOM 兜底"，内部 API 直调可作为第二级增强（从嗅探到的请求里反推接口参数）
3. **"店铺托管"的技术形态 = back-data-crawl**：对卖家后台做视觉爬取回流订单/商品，绕开平台 API 审核——二期订单回流可以参考这条路，比申请 SP-API 快
4. **关键词采集**是独立功能（不止详情页插件按钮）：web 端输入关键词 → 插件跑到源站搜索页抓列表
5. `externally_connectable` 比我们 postMessage 桥更简洁（web 端直接 runtime.sendMessage），但需要固定 extension key——发布版可用，开发期 postMessage 更省事
