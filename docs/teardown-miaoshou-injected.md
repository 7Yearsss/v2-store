# 妙手注入包拆解：index-B9ozK0Pv.js（2026-09 实测抓取）

来源：不需安装插件即可完整复现的下发链路——

```
POST https://kuajing-plw.happyporsche.com/open/v3/getTs
  headers: x-tg: earth(常量)  x-vs: 5.0.9  x-mv: 3  x-rc: msErp
  body:    {url: "<当前页面URL>"}
  → {ac:"normal", isurPath:"/app/views/static/json/rules/isur.json?ts=..."}

GET isur.json → {rules:480条URL正则, evalRules, blobRules, innerRules,
                 iframeRules, documentStartRules, inlineRules}

GET https://kuajing-plv3.happyporsche.com/.vite/manifest.json
  → entry "index" → main-assets/index-*.js（1.5MB）+ style-*.css
```

注入方式按站点分通道：eval（TikTok 系）、blob <script>（Ozon/美客多/速卖通/eBay/Temu）、
inner（seller.kuajingmaihuo、temu 卖家后台、1688 favorites）、iframe（myconnections.alibaba
妙手授权、jinritemai 抖音组件、air.1688 图搜）、document_start（TikTok）。
**下发的是一个统一的 1.5MB Vite 应用包，所有站点逻辑都在里面**——不是每站一个文件。

## 一、采集器的真实形态：页面侧只是"收割器"

77 个货源站点模块，统一契约（每站一份 config+content+utils 三元组）：

```ts
{
  matches, source: "1688"|"571xz"|"aliexpress"|...,
  matchSourceInfoPattern: "<URL正则，提取itemId/site>",
  matchDetailPage(url), matchListPage(url),
  validatorCollectDetail(): 检查滑块/登录态 → {antiCode, loginPageUrl}
  getCollectDetailSourceInfo(): {itemUrl,itemId,site,source}
  getCollectDetailPageDataSourceInfo(): {
    pageContent: document.documentElement.innerHTML,  // ← 整页原始 HTML
    itemId, source, site, afterUrl, productExtInfo/itemInfo
  }
  getCollectProductList(): [{node, sourceInfo}]       // 列表页商品锚点，用于已采集标记
}
```

详情页采集 = **把整页 HTML + itemId POST 给 `kuajing-plw.../open/fetch/pfti`，
字段解析、SKU 归一化全部在服务端完成**。页面侧 JS 基本不做结构化提取——
这就是为什么 zip 里看不到任何字段映射逻辑。

已采集去重徽标：`POST /open/niu/batch_check_item_has_fetch`（列表页 sourceInfo 批量查询）。
提交进采集箱：`POST /open/niu/push_collect_box`。
其他服务端采集入口：`/open/common/format_item_urls`（URL 归一化）、
`/open/common/download_item_urls`（服务端按 URL 批量采，即"链接采集"的实现）。

## 二、三条采集深度（由浅到深）

1. **HTML 收割**（默认）：pageContent → pfti。适用于绝大多数站。
2. **站点内部 API 直调**：例 571xz 调 `api.youpizhijia.com/goods/detail-get-new`
   （token 存 storage）返回结构化 itemInfo，随 pageContent 一起上报。
3. **mtop 签名直调**：包内含完整 mtop H5 签名实现
   `md5(token&t&appKey=12574478&data)`，从 `_m_h5_tk` cookie 取 token，
   经 background `commonFetch credentials:"include"` 调
   `h5api.m.1688.com/h5/{api}/1.0/`。用到的 API：
   - `mtop.aliexpress.itemdetail.pc.asyncpcdetail` / `pdp.pc.query` /
     `fc.gateway.campaign.data` —— **速卖通商品采集直接走阿里内部接口**
   - `mtop.1688.mtoporderservice.queryorder`、`deliveryorderservice.querydeliveryorderpacklist`、`trading.dataline.service` —— 采购订单/发货单回流
   - `mtop.1688.trade.receiveaddress.add(receiveaddress)`、`mtop.taobao.mbis.insert/deleteDeliverAddress`、`mtop.cainiao.address.*` —— 拍单时自动建收货地址
   - `mtop.1688.image*` —— 以图搜款（询货）
   - `mtop.order.querydetail`、`mtop.relationrecommend.*`

## 三、采购 Agent（订单回流的另一半）

`Purchase1688*`（Detail/Cart/Confirm/WaitPay/PaySuccess/SearchSameGoods）、
`PurchasePdd*`（Index/Detail/Login/OrderCheckout/Verification/AliPay×4/WechatCallback）、
`PurchaseTaoBao*`（Detail/Cart/Confirm/DeliverAddress/AddTempAddress/PaySuccess/
PayResult/AlipaySuccess/AddCartSucceed）、`PurchaseTMallPaySuccess` —
在货源站页面里注入的**全自动拍单机器人**：选 SKU（`skuModel.skuInfoMap` ×
`orderParamModel.orderParam.flow` 读用户选择）、加购、填地址（mtop 建址）、
下单、抓支付成功页回写单号。拼多多支付宝/微信支付回调页都有专门处理
（isur.json 里 isPurchase 规则就是为此做 webRequest 记录）。

1688 详情页数据提取同我们的实现：`window.__INIT_DATA.globalData`
（fallback：`window.context.result.data.Root.fields.dataJson`、
script 标签文本解析），SKU key 按 `&gt;` 分割，skuProps 带 imageUrl。

## 四、反风控与工程化

- **1688 要求授权货源账号**：`notAuthResellerAccount`——采集前先引导用户
  OAuth 授权 1688 买家/分销账号（`/auth/reseller_account/*`），
  "授权后采集更稳定"= 走授权买家身份调接口，抗风控。
- `check_login` 按站点检测登录态，未登录提示先登录再采。
- antiCode 体系：安全验证/滑块/rowDataInvalid/emptyRowData/notLogin →
  统一错误码 + 中文提示文案 + 降频重试建议。
- **前台采集开关**：采集标签页保持前台不可切换（前台页面不易被风控/挂起）。
- **采集间隔 2–5s** 可配置，批量采集显示 `采集中(n/N)` 进度。
- 配额计费：`collectNumUnpaid` → 免费额度 N 个/剩余 M 个，提示升级版本。
- `getImg`/`getImgBase64Code` 图片代理（绕外链防盗链）；
  `url_gbk_encode`（1688 搜索 GBK 参数编码）。
- 埋点三件套 `open/v3/uac|ruc|spa`（带 trackerHeaders）。

## 五、1688 覆盖面

详情：`*.1688.com/offer|ci/\d+.htm`、`caigou.1688.com/detail`、`detail.m.1688`、
`detailp4p.1688.com/buyer/offerdetail`、`sale.1688.com/factory`。
列表：s./search./p4psearch.1688.com、show/pinlei、wxb/list、page/offerlist、
channel-fe/search、pc-image-search、favorites、air.1688 kapp 搜索、
pc-home 首页、act 活动页——**凡是能出商品卡片的页面都支持勾选批量采**。

## 六、对我们的映射（差距→做法）

| 妙手 | 我们现状 | 建议 |
|---|---|---|
| 页面侧收割 HTML 交服务端解析 | 页面侧做全量字段解析 | 改契约：插件只收 pageContent+itemId+productExtInfo，解析下沉 server——站点适配不发版、字段坏了服务端热修 |
| pfti 统一入口 + sourceInfo 契约 | 已类似（COLLECT_PRODUCT） | 契约对齐：{itemUrl,itemId,site,source,postFee} |
| validatorCollectDetail antiCode | 无 | 每站加校验器：登录态/滑块→结构化错误码 |
| batch_check_item_has_fetch | 无 | server 接口按 URL/itemId 查重，列表页打"已采集"标 |
| mtop 签名直调内部 API | 只嗅探被动缓存 | 1688 采购侧必做：拍单/订单回流只能走 mtop；采集可先靠 pageContent |
| Purchase* 页面内拍单 agent | 无 | 二期订单回流的核心形态：注入货源站的下单机器人 |
| 授权货源账号（reseller auth） | 无 | 1688 OAuth 买家授权入产品流程，既是合规要求也是稳定性来源 |
| 前台采集 + 间隔节流 + 额度计费 | 无 | 批量采集三件套，照搬 |
| getImg 代理 + GBK 编码 | 无 | 图片走自家代理下载；1688 搜索参数 GBK |
| isur.json 分通道注入 | manifest 静态声明 | 规则表下发 eval/blob/iframe 通道，支持 seller 后台类页面 |
| 77 站点一包容 | 2 站点 | 模块三元组契约照搬（config/content/utils），逐站补 match+validator+productList |
