# 铺货工作台 Phase 0 — 竞品拆解 + 冻结契约

> 本期切片：跨境电商 ERP 的「AI 一键铺货」工作台（apps/studio）。
> 主路径：选品/导入货源 → AI 生成并补全主稿 → 预览各平台差异与能否发布 → 一键铺到多个已授权店铺 → 任务中看每店成败、失败可补字段重试。
> 状态：已内部评定，按此文档实现；不再等确认。

---

## 1. 竞品拆解表

### 妙手 ERP（国内，用户截图 + 帮助文档）

- 铺货主路径：采集箱（公用采集箱）→ 认领到店 → 平台采集箱 → 编辑刊登 → 发布 → 发布记录，约 6-7 步，跨 3 个菜单
- 商品主数据：标题、类目（来源类目+平台类目）、属性、SKU 变体（规格名/值/图/价/库存）、描述图、翻译状态
- AI 能力：标题生成/翻译、图片翻译、描述改写（独立功能页；未证实可逐字段重生成）
- 多店对照：分页面——每个平台一套平行菜单（Shopee 采集箱/TikTok 采集箱…），无并排对照
- 任务/错误队列：「发布记录」列表，失败有原因列但需逐条点开
- 值得抄：① 采集箱作为货源缓冲层 ② 认领到店的显式动作 ③ 发布记录可回溯每条刊登
- 绝不能抄：① 青绿顶栏 + Mega Menu 全功能墙 ② 每平台一套平行后台 ③ 右侧运营广告位/插件下载入口

### 店小秘（国内，帮助文档）

- 铺货主路径：产品 → 采集箱/数据搬家 → 认领 → 编辑（批量编辑可跨店）→ 刊登 → 在线产品
- 商品主数据：SKU 主档独立成模块，刊登是 SKU 在某店的投影（配对关系）
- AI 能力：AI 标题/描述生成、图片翻译（未证实逐字段粒度）
- 多店对照：不支持并排——"数据搬家"是跨店复制的独立流程
- 任务/错误队列：刊登状态分组 Tab（草稿/发布中/在线/失败），失败按店分列原因
- 值得抄：① 刊登状态分组 Tab ② 批量编辑 ③ SKU 主档与刊登分离的模型
- 绝不能抄：① 功能密集导航（40+ 一级入口）② 表单铺满长页 ③ 状态散落各平台子菜单

### Sellbrite（国外）

- 铺货主路径：Products > All Products → 选中 → "List Product on Channel" → 引导式分步（模板自动保存）→ draft → Publish
- 商品主数据：一份主 catalog + 每渠道一个 listing（SKU 关联）
- AI 能力：无（未证实）
- 多店对照：不支持并排，但同一 SKU 的各渠道 listing 在详情里聚合一屏
- 任务/错误队列：发布是异步 job，listing 上标 error 状态 + 原因
- 值得抄：① "主数据→渠道 listing"的模型 ② 引导式发布模板自动存 ③ 失败状态挂在 listing 上就地可见
- 绝不能抄：① 每渠道一次只能发一间店的限制（bulk ≤100）② 设置页分散

### Listing Mirror（国外）

- 铺货主路径：Manage Listings → 每渠道 "+" → Quick Match（已有货）或 Create New Listings（新建，Amazon/Walmart）
- 商品主数据：catalog 主档 + 渠道 listing 副本，支持独立改渠道字段
- AI 能力：无（未证实）
- 多店对照：Manage Listings 一个表格按行列出所有渠道状态——最接近期望形态
- 任务/错误队列：错误直接写在 Manage Listings 行内；表格导出最后 6 列即错误信息
- 值得抄：① 单表格多渠道对照 ② 错误在行内就地可见 ③ Quick Match / Create 双入口
- 绝不能抄：① 界面老旧密度低 ② 每渠道 "+" 分散操作

### Shopify Marketplace Connect / Linnworks（国外）

- Marketplace Connect：channel 以 app 内嵌形式挂在 Shopify admin，listing=Shopify product 的映射，字段差异在映射表里
- Linnworks：库存中心 + 渠道 listing 批量工具，功能全但 UI 重度表单化（未证实细节）
- 值得抄：listing 与主档分离、字段映射显式可见
- 绝不能抄：平台后台深度嵌套、长表单当首页

### Shopee Seller Centre（平台官方）

- 发布字段：封面图必传、图 ≤8 张、标题上限 255 实际建议 ≤60、类目必填属性标 *、变体 ≤2 层、价格按站点币种、库存
- Mass Upload：Excel/CSV 批量上传，错误行级返回
- 值得抄：① 改字段即时预览效果 ② 必填属性标星就地校验 ③ 批量上传行级错误
- 绝不能抄：长表单一屏到底

### TikTok Shop Seller Center（平台官方）

- 发布字段：标题 ≤80 字符为优、图 ≥5 建议 ≥600px ≤9、自动类目建议、品牌证书必填（按类目）、变体 ≤300、视频 ≤5MB、批量 ≤1000
- 审核：发布后常态"审核中"再转在线
- 值得抄：① 自动类目建议 ② 审核中作为一等状态 ③ 字段级限制即时提示
- 绝不能抄：5 段式长表单

### Amazon 多渠道 / AI listing（平台官方）

- AI 能力：输入关键词或一张图 → 生成标题/卖点/描述 → **人确认后才发布**
- 值得抄：AI 是生成-确认流不是聊天；生成结果落在字段上
- 不能抄：Seller Central 整体劝退密度

### 导航问题结论
真常用：商品库、采集/导入、刊登列表、发布记录、店铺授权。堆出来的：营销/广告/采购/仓配/客服/达人/分销/数据报表/发票/插件市场——本期全部不做，也不留占位导航。

---

## 2. 行业通用能力清单（A/B/C）

**A. 本期必须做（服务主路径，成功标准逐条回溯到这里）**
- 店铺：列表、平台（Shopee+TikTok）、站点、授权状态（authorized/expired）、连接/吊销/重授权
- 商品：手工创建、CSV 粘贴导入、货源链接生成草稿（mock 解析）
- 主稿：图/标题/卖点/描述/类目/属性/价格/库存/UPC 全字段可编辑
- 字段级 AI：标题（生成/更短/更转化）、描述（生成/按渠道改写）、属性（按类目补齐）、价格（费率倒推）；单字段重生成；生成后需用户确认主稿
- 渠道对照：选中商品即时出每店校验结果（能发/缺字段/超长/类目未映射/违禁/授权过期）
- 一键铺货：勾选店 → 单个主按钮 → 异步 PublishJob，每店一条 PublishAttempt
- 任务：job/attempt 状态机（queued/running/review/succeeded/failed + partial_success）、失败原因行内可见、单店重试、外部 ID/链接回写
- 操作日志：谁、何时、对哪些店、哪版文案（PublishJob.fieldsSnapshot + audit_logs）
- 示例数据：启动即 seed（3 店含 1 过期授权 + 6 商品 + 主稿），四态可演示
- 壳：5 项一级导航、顶栏店铺范围切换、切页不重载壳、深色一套

**B. 架构预留、UI 不做**
- 平台 adapter 抽象（新平台=一个文件+一行注册）
- workspace 多租户隔离（表留扩展位，本期单租户不加列）
- 真实 OAuth/平台 API client（adapter.publish 内留注入点）
- AI 真实 LLM 调用（env 配了走真，没配走确定性 mock）
- AuditLog 查询 UI（数据落库，设置页给只读列表即可）

**C. 明确不做**
订单、仓配、扫描发货、组包预报、FBA/FBT、广告、利润报表、客服工单、达人建联、分销、发票、插件市场、多平台平行菜单、30+ 平台 logo 墙、真实爬取货源页、真实平台 API 调用、订单回流。

## 3. 可勾选成功标准（全部回溯 A 列）

- [ ] 从「已有一个商品」到「任务开始跑」≤3 次有效确认（选品点行 → 勾店 → 点「铺到 N 家店」）
- [ ] 铺货页三栏：左=商品池+导入+链接生成草稿；中=主稿字段编辑+字段级 AI 按钮；右=店铺对照卡+唯一主按钮
- [ ] 任何时刻可回答：在跑什么（顶栏/任务页有 running 状态）、哪家挂了（attempt 行内原因）、缺哪个字段（issues 落到字段名）
- [ ] Shopee + TikTok 两条链路的校验规则差异化（标题长度/图数/类目/违禁词/授权）
- [ ] 发布异步：job=queued→running→succeeded|partial_success|failed；attempt 每店独立状态含 review
- [ ] 部分成功是正常结果：3 店发布 1 挂 → job=partial_success，失败店可单独重试
- [ ] 重试语义：仅 failed 可重试，生成新 attempt(retryOf)，旧记录保留
- [ ] AI 是字段上的动作（无独立聊天页）；每个字段可只重生成这一项；生成写主稿但发布前冻结快照，禁止静默改线上
- [ ] 授权过期店：对照卡提示+发布被拒（auth_expired），就地 reauth
- [ ] 一级导航恰好 5 项（铺货/商品/店铺/任务/设置），默认落铺货；无平台平行菜单
- [ ] 深色：近黑底、一种强调色（主按钮+进行中）；8px 外/4px 内；状态=点+短文案；空状态用人话
- [ ] 数据模型含 Shop/Product/ListingDraft/PublishJob/PublishAttempt/AuditLog
- [ ] 审计可查：POST 铺货后 audit_logs 有 publish.create 且 payload 含冻结文案
- [ ] 本地一键起（dev:studio:server + dev:studio:web），seed 数据四态齐全
- [ ] npm test（studio server 套件）+ typecheck 全绿

## 4. 路由 / IA（冻结）

一级导航 ≤5：`/publish`（默认）、`/products`、`/shops`、`/tasks`、`/tasks/:id`、`/settings`。
店铺范围 = 顶栏下拉（全部店铺/单店过滤右侧对照与任务列表）。
禁止新增一级路由承载平台功能；无 /orders /warehouse /ads。

## 5. 冻结数据模型（apps/studio/server/src/db/schema.ts）

shops(id, platform∈shopee|tiktok, site, name, authStatus∈authorized|expired, externalId, createdAt)
products(id, source∈manual|import|link, sourceUrl, title, images[], variants[{sku,options,price,stock,upc}], sourceCategory, createdAt)
listing_drafts(id, productId unique→products, status∈draft|ready, fields{title,bullets,description,attributes,price,compareAtPrice,category,upc}, aiFields[], updatedAt)
publish_jobs(id, productId, draftId, status∈queued|running|partial_success|succeeded|failed, fieldsSnapshot, shopIds[], createdAt, updatedAt)
publish_attempts(id, jobId, shopId, status∈queued|running|review|succeeded|failed, error, issues[], externalId, remoteUrl, retryOf, createdAt, updatedAt)
audit_logs(id, actor, action, entityType, entityId, payload, createdAt)

## 6. 冻结 API（apps/studio/server/src/routes）

- GET /api/health；GET /api/meta/platforms；GET /api/meta/audit-logs?entityType&entityId
- GET/POST /api/shops；POST /api/shops/:id/revoke|reauth；DELETE /api/shops/:id
- GET/POST /api/products（?q）；POST /api/products/import {csv}→{created,errors}；POST /api/products/from-url {url}；GET/DELETE /api/products/:id
- GET/PATCH /api/products/:id/draft；POST /api/products/:id/draft/ai {field,mode,channel?}→ListingDraft
- POST /api/publish/preview {productId,shopIds}→{checks:ChannelCheck[]}
- POST /api/publish/jobs {productId,shopIds}→PublishJobDetail；GET /api/publish/jobs?page；GET /api/publish/jobs/:id；POST /api/publish/attempts/:id/retry

## 7. 真实 vs mock（剩余风险即 mock 边界）

真实：DB 全量、状态机、校验规则、CSV 解析、审计、UI 全部、AI（配 REIZO relay env 时）。
mock：平台 OAuth（建店即授权，revoke/reauth 手动切换）、平台 API publish（adapter 内确定性模拟：Shopee→succeeded、TikTok→review；校验失败→failed）、货源链接解析（按 host 回示例商品）、外部商品 ID/链接（mock 生成）。

## 8. 非目标

订单/仓配/广告/客服/达人/分销/发票/插件市场；平台平行菜单；30+ 平台 logo；真实爬取与真实平台调用；多租户 UI；移动端。

## 9. 设计 token（web/src/theme/tokens.css 为准）

bg #0B0C0E / surface #131417 / surface-2 #1A1C20 / border #26282E；text #E7E8EA / secondary #9CA0A8 / tertiary #5F636B；accent #5E6AD2 仅主按钮+进行中；状态点 draft 灰 / ready+running accent / review+partial #D9A543 / success #3FB68B / failed #E5484D；radius 6(件)/10(卡)；fs 13/12 密/15 标题；间距 4px 网格。
