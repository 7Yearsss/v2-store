# 妙手「跨境ERP助手」插件拆解（v5.0.9，2026-09 实测）

来源：妙手后台「插件下载」弹窗直发 zip（`kuajing-erp-plugin-v3-5x.zip`，~200KB），不是 Chrome Web Store 分发。
描述原文："支持采集 100+ 货源平台商品，批量发布至数十家跨境电商平台店铺，支持一键代发采购，自动关联并同步采购单至货代系统"。

## 架构：插件是壳，采集器在服务端

这是与芝麦/店小秘最大的不同，也是最值得学的一招：

- `manifest.json`：content_scripts 注入 `<all_urls>` + `all_frames: true`，两条：document_start 的 `start.js` 和 document_end 的 `content.js`。两者都是 ~7 行 minified loader。
- 运行时：background 调 `/open/plugin/getInjectRecordWebRequestHistoryRules` 拿当前 URL 该注入什么；`injected.js` 把服务端返回的脚本用 `eval(res)` 或 `<script>` blob 注入页面主世界。
- 后端 API 域名：`*.happyporsche.com`（kuajing-plv3 / kuajing-plw）、`*.chengji-inc.com`、`*.91miaoshou.com`；另有 `/open/v3/getTs` 授时端点（多半用于请求签名）。

**含义**：100+ 货源站的采集逻辑不写死在插件里，而是服务端按站点下发、热更新。新加货源站 = 服务端写个采集脚本，用户插件零更新。这也是他们能宣称"采集 100+ 平台"的工程基础。

> 对我们的启示：采集器做成「本地通用解析器（__INIT_DATA/DOM）+ 服务端下发的站点专用补丁」双层结构——页面结构变了我们在后台改下发脚本就能修，不用发版等商店审核。长期值得做，MVP 先不复杂化。

## 权限与能力提升

| 权限/机制 | 用途 |
| --- | --- |
| `cookies` | 直接读站点登录态（session riding），采集时带用户 cookie 绕过风控 |
| `webRequest` + `declarativeNetRequest` | 见下方 rules.json——改写请求头 |
| `unlimitedStorage` | 采集数据/监控数据本地大量缓存 |
| `management` | 探测用户装了哪些扩展（可能用于检测冲突插件） |
| `all_frames` | iframe 里也注入（采集嵌入页/后台弹层） |
| `externally_connectable` → `*.91miaoshou.com` + `localhost` | web 工作台与插件直接双向通信（同芝麦 bridge，且 localhost 说明他们也考虑本地客户端/调试） |

## rules.json：Origin 伪装，直调平台内部接口

```json
// *.kuajingmaihuo.com (Temu卖家中心) 的 main_frame+xmlhttprequest → Origin 改写成 https://seller.kuajingmaihuo.com
// queryTrace.do?dimension=TRADE_ID (淘宝订单回流) → Origin 改写成 https://trade.taobao.com
```

即插件直接以"合法 Origin"调 Temu/淘宝卖家后台内部 API——**这就是"订单回流/后台数据回流"不依赖官方开放平台的实现**：用户登录卖家后台后，插件借 cookie + 伪 Origin 直接调内部接口。店小秘的 platformBackDataCrawl 走类似路线。

## 其他观察

- 打包框架是 **WXT**（出现 `wxt/storage` 引用），内置 pako（zlib）——采集数据压缩后上报。
- 安装方式：官网下载 zip 拖进 `chrome://extensions` 开发者模式安装（商店外分发，审核自由、可随时发版，代价是每次更新要用户手动换包——所以他们才把采集器做成热更新）。
- 明确支持指纹浏览器：紫鸟/站斧/飞跨——多店防关联卖家的主战场，我们的插件兼容矩阵要覆盖它们。
- 品牌细节：内部图标文件名是 `maixiaozhu-*`（疑似旧名"卖小助"），产品对外叫"跨境ERP助手"。

## 与我们的差距清单（按价值排序）

1. **服务端下发采集器**（热更新）——目前我们采集器写死在包内，页面改版就要发版
2. **`cookies` + Origin 伪装调内部接口**——订单回流、后台数据回流的钥匙，我们还没接
3. **货源变化监控**——插件侧轮询价格/库存（他们当卖点宣传），我们的监控还没做
4. **指纹浏览器适配**——需要在紫鸟/站斧里实测
5. **all_frames 注入**——1688 详情有部分模块在 iframe 里（SKU 选择器浮层等），我们目前是顶层帧 only
