# 全链路功能调研：AI选品 / 一键上品 / 商品列表 / 商品优化工作流 / 订单管理 / 仓储

> 2026-09-26。基于：本仓库现状（schema / 模块 / 页面）、docs/product-plan.md 路线图、妙手 ERP / 店小秘 / AutoDS / DSers / CJ Dropshipping / 1688 开放平台官方帮助文档与实测记录。
> 读者：接手开发的人或 AI。先读 product-plan.md，本文是它的下游展开——把六大功能域逐一拆成「竞品怎么做 → 我们现状 → 差距 → 怎么建」。

---

## 0. 结论先行

### 六个功能其实是三个面

```
上游供给面          铺货中台(已有骨架)            履约面(全缺)
─────────          ──────────────────          ─────────────
 AI选品       ──►   采集箱 source_items
 (发现+评分)        ↓ 认领
 询货(已有调研)     listings 草稿
                   ↓ 一键上品 = 自动化链路
                   商品优化工作流(AI产线)   ──►   订单管理
                   ↓ 发布                        (同步→采购→发货→回传)
                   商品列表(在线商品托管)         仓储
                   (回拉/drift/监控)             (虚拟库存→货代→自营仓→托管备货)
```

- **「一键上品」不是一个功能，是一条策略链**：采集→预处理→认领→AI→门禁→发布，每一步已有或已有设计，缺的是「链式触发 + 可配置审核卡点 + 定时/频率控制」。
- **「商品优化工作流」我们已经比竞品有半成品优势**：`listing_suggestions` 字段级建议 + diff 审核是正确形态，缺的是把它升级成**可编排的 stage 管线**（妙手「我的工作流」的我们的版本）。
- **「商品列表」= 在线商品托管**，schema 里 `remoteSnapshot`/`remoteDrift`/`syncPolicy` 已铺好路，Phase 2 本来就是它，这里补全竞品规格。
- **「订单管理」是全链路最重的缺口**：当前 0 代码。Shopify 侧同步不难（webhook + API），难在**采购履约**（1688 下单、货代、运单回传）。妙手的分层（调用库存/代发采购/一键下单/货代同步）是可直接继承的成熟设计。
- **「仓储」对铺货 SaaS 是分层概念**：L1 虚拟库存推送（现在就要）→ L2 货代中转（跟订单一起）→ L3 自营仓 SKU 主档（出单稳定后）→ L4 平台托管备货（上 Temu/全托管类渠道才需要）。别一上来做真仓库。
- **「AI选品」对我们是「发现层」**：妙手的形态 = 选品计划每日产出候选 → 一键采集入箱 → 走已有链路。我们没有 1688 官方交易数据权限之前，评分要诚实——用供应保障/毛利/趋势信号 + LLM 重排，不伪造销量预测。

### 与现有路线图的关系（建议重排）

| 现有 Phase | 内容 | 本文对应 |
|---|---|---|
| 0 收尾加固 | 部署/CI/筛选 | 不变 |
| 1 AI 产线+类目 | aiEnhance + suggestions + 类目 | **商品优化工作流**（扩展为 stage 管线）|
| 2 托管 | 回拉/货源监控/webhooks | **商品列表** + **仓储 L1**（库存推送）|
| 3 效率交互 | 任务中心/批量/视图/自动链 | **一键上品**（自动链+门禁+定时）|
| 4 第二渠道 | TikTok/Ozon | **建议在其前插入 Phase 3.5：订单基础**——订单同步→SKU 映射→手动/插件辅助采购→运单回传。理由：只有刊登没有订单闭环，产品仍是"上货工具"不是"经营工具"；Shopify 侧工程量可控（见 §5） |
| 5 SaaS 化 | 计费/团队/审计 | + 仓储 L3、AI 选品完整版 |

---

## 1. AI 选品

### 1.1 竞品形态

| 竞品 | 形态 | 数据源 | 关键细节 |
|---|---|---|---|
| 妙手 **AI选品**（1688） | 「选品计划」：设类目/价格/关键词 → 每日凌晨跑 → AI 甄选 top100 1688 精品 → 勾选「开始采集」/「一键铺货」→ 进采集箱 → 认领 → 发布 | 1688 | 选品结果是**采集箱的原料**，不是独立列表；和主链路无缝衔接 |
| 妙手 **AI选品专家** | 对话式助理，聚合 TikTok Shop + Temu 选品数据：按国家/类目/时间查热销、飙升、榜单；按销量动能/评分/评论量/广告标记/预售筛"蓝海"；输出图表+结论+HTML报告 | TikTok/Temu 聚合数据 | 重数据分析报告，轻落地；适合"我们以后接了 TikTok 数据"的形态参考 |
| 1688 **跨境热卖**（妙手内嵌入口） | 五种选品方式：**榜单**（按站点/类目，热销/飙升/趋势新品/微创新四种推荐模式，带月销量/环比/机会分）、**货盘**（设销售平台+偏好类目→AI 推整组品）、**找品**（文字/图片/链接搜同款）、**找商**、**AI询盘**（自动向多供应商发询盘汇总价格/交期/MOQ/寄样） | 1688 过亿货盘 + 跨境交易数据 | 这是官方给的选品数据集——我们接 API 或用插件采集它，比自己做趋势估算靠谱 |
| AutoDS **Product Finding Hub** | 付费 add-on，四件套：Trending（按真实表现每日更新）、Hand-Picked（专家精选+受众/竞品/利润分析+现成标题描述图）、Ads Spy（TikTok/FB/IG 投流品）、TikTok Analytics；**一键进 drafts** | 自家供应商网络+广告库 | "选品即草稿"闭环；Hand-Picked 靠人工运营，前期不可复制，但「现成内容包」思路好 |
| Sell The Trend **Nexus** | 11M+ 商品预测评分，聚合 Shopify/Amazon/FB/TikTok/AliExpress/CJ | 多平台 | 预测分是卖点但我们没有同等数据 |
| Dropship.io | Shopify 店铺销售额估算 + 周榜 + 竞品追踪 | 店铺侧数据 | 信号是回溯性定量："已经在卖的品" |
| Minea | 广告情报：FB/TikTok/Pinterest 创意+投放时长 | 广告库 | 抓"还在起量"的品，适合跟卖打法 |
| 店雷达等三方 | 1688 跨境选品库：代发价/批发价/复购率/上架时间/总件数/销售额筛选 | 爬 1688 | 证明 1688 侧筛选维度公开可采 |

**共性结论**：选品的交付物永远是「候选列表 → 一键进采集/刊登管线」。数据源分四层：①货源平台侧（1688 榜单/跨境热卖/代发池）②下游平台侧（TikTok/Temu/Shopify 热销）③广告侧（投流品）④专家精选。我们现阶段只有 ① 可自控，②③ 以后接数据服务，④ 可后期做"精选包"运营位。

### 1.2 我们的设计：选品计划 → 候选池 → 采集箱

```
selection_plans（选品计划）
  workspace_id, name, source:"1688_rank|1688_hot|keyword|image_reverse",
  filters: {category, priceBandCny, country?, keywords[], minRepurchase?, 
            requireDaiFa(一件代发), require48h, minChengxinYears},
  schedule: "daily" cron, status, lastRunAt
        │ 每日 job: selection.run
        ▼
discovery_items（候选池，不进采集箱）
  plan_id, source_platform, source_item_id, title, priceText, thumb,
  signals: {repurchaseRate, sellerYears, daiFa, shipTime48h, trendScore, 
            sourceRank, estMargin},
  score, scoreDetail(AI 重排理由), status: new→collected|dismissed|expired
        │ 用户勾选 → 走插件/服务端采集详情
        ▼
source_items（现有采集箱，加列 collected_via: "manual|plan|inquiry"）
```

**为什么加 `discovery_items` 而不是直接进 source_items**：候选池是"看过的便宜数据"（每天每计划上百条，命率 <10%），进采集箱会稀释它。采集箱保持"用户确认要用的货"。妙手也是如此：AI选品结果页勾选后才「开始采集」。

**评分信号（v1，全部可从 1688 页面/跨境热卖拿到，不伪造销量）**：

| 信号 | 来源 | 权重思路 |
|---|---|---|
| 一件代发包邮 / 48h 发货 / 7天包退 | 服务保障标签 | 硬过滤（做代发必筛）|
| 复购率 / 回头率 | 店铺字段 | 高权重 |
| 诚信通年限 / 工厂档案 | 供应商详情 | 中权重 |
| 代发价 vs 目标市场同类价 | 代发价 + 店铺定价规则试算毛利 | 高权重（毛利<阈值直接降权）|
| 榜单名次/环比 | 跨境热卖榜单 | 中权重 |
| 同款密度（搜索结果数） | 以图搜款 | 负权重（红海预警）|
| LLM 重排 | 标题+属性+类目 → 目标市场契合度/侵权词风险 | 最后一轮排序+生成推荐理由 |

**反向选品（询货，已有调研 research-sourcing-inquiry.md）**：粘贴下游爆品链接/图 → 1688 以图搜款 → 候选评分 → 采集。与计划式选品共用 `discovery_items` 和评分器。

**合规边界**：「AI询盘」（自动给供应商发消息）做成**待发送队列+人工确认**，频率限制——妙手官方也提示自动询盘有风控。MVP 不做自动发盘。

### 1.3 页面

新增一级导航「选品」：计划列表 → 计划详情（候选卡片墙：图/价/信号徽章/评分/AI理由 → 勾选采集/忽略）。候选卡片上的「同款找商」「AI理由」是差异点。冷门期默认推荐 3 个预设计划（家居/宠物/3C配件等低风险类目）。

---

## 2. 一键上品

### 2.1 竞品形态

| 竞品 | 做法 |
|---|---|
| 妙手 | 「采集并自动认领 / 自动发布」三合一开关；发布弹窗可设**定时发布**（立即/定时/周期）和**发布频率控制**（每件间隔 N 分钟——防平台判铺货）；批量链接格式 `链接$$新标题` 支持粘贴改题；店铺采集箱→批量发布 |
| DSers | Import List → Push to Store（单推/批量/只推选中变体）；可选"同时上架到 Online Store 及各 sales channel" |
| AutoDS | Marketplace/选品一键 import 到 drafts → 规则自动定价 → publish；抓取→草稿→发布全程可无人值守 |
| 店小秘/芒果 | 采集箱→认领到多平台店铺（一对多），多店铺群发 |

**共性**：所谓一键 = 每一步默认值都由「店铺刊登设置」兜住（定价规则/语言/类目映射/禁售词/图片规则），用户只在想改时介入。**频率控制和定时发布是真实需求**——防铺货风控 + 运营节奏。

### 2.2 我们的设计：链路策略 + 审核卡点

链路已有所有零件，缺的是「默认自动往下走」的编排：

```
collect ─► preprocess(stores.rules: 前缀/替换/价格过滤/图数) 
        ─► claim(store × N, 定价规则) 
        ─► ai.enhance(listing_suggestions)
        ─► auto-accept?（建议置信度/字段白名单 per store）
        ─► precheck(bannedWords + 平台校验 adapter.check())
        ─► publish.enqueue（可挂 publish_at / 店铺级频率间隔）
```

**核心抽象：`PipelinePolicy`（挂在 store 上，listing_template 可整体套用）**

```ts
interface PipelinePolicy {
  autoClaim: boolean;            // 采集即认领
  autoAcceptFields: FieldName[]; // 可自动接受的 AI 字段（默认 [] = 全要人工点）
  autoPublish: boolean;          // 门禁通过即发布
  publishMode: "now" | "scheduled" | "paced";
  publishAt?: string;            // scheduled
  paceMinutes?: number;          // paced：同一店每 N 分钟发 1 件
  holdOnWarning: boolean;        // 有 warn 级问题也按住
}
```

- **审核卡点三档**（对应妙手「三合一」的更稳版本）：
  - `hold_after_ai`（默认）：AI 跑完停，列表显示"待审核 N 条建议"——用户 diff 后一键全收
  - `hold_after_precheck`：门禁检查完停——只拦问题品
  - `auto`：全程无人，失败进异常队列
- **幂等与熔断**：链路复用现有 jobs（每种 job 已有去重）；加 workspace 级「当日自动发布失败率 > X% 自动暂停链路并通知」。
- **发布节奏**：`publish_at`（listing 级，列表可批量设）+ 店铺级 `paceMinutes`（发布 job 调度时按店铺 last_published_at 顺延）。这不是延迟队列能做的，发布 worker 取任务时检查即可。
- **多店铺群发**：认领弹窗已支持多选店；一键上品 = 认领时对勾选的每个店都套各自 PipelinePolicy。

**交互**：采集箱行操作从「认领到店铺」升级为「认领」+「认领并发布」（后者 = policy 全开快捷方式）；列表上每个 listing 显示链路进度徽标（已认领→AI完成→待审核→排队发布→已发布），就地可推进/暂停——符合第 4 节「异步任务就地可见」原则。

---

## 3. 商品列表（在线商品管理）

### 3.1 竞品形态

| 竞品 | 功能面 |
|---|---|
| 妙手「产品管理/在线产品」 | 已发布产品批量编辑标题/描述/库存；「源数据 vs 站点数据」双层：源数据一改同步各站点，站点数据可单独覆盖；单产品编辑+批量编辑 |
| AutoDS「Products」 | 每行显示供应商变化警告（货源标题/价变了 = 黄色感叹号）；可保存筛选视图（Match All/Any）；草稿/定时/周期上架三标签；断货天数、On Hold 原因解释 |
| 店小秘 | 商品 SKU 主档（仓库商品）↔ 平台产品配对；库存推送规则把仓库库存同步多店 |
| 芒果 | 编辑页按平台 schema 展开字段+平台规则提示 |

### 3.2 现状与差距

已有：`listings.remoteSnapshot/remoteDrift/syncPolicy/lastPulledAt/lastAutoAction`（快照、字段级 drift、同步策略三档 notify/auto）、状态三轴（本地执行/远端状态/关联健康）、Products 页基础列表。
缺：内容级回拉（现只同步状态）、监控规则引擎、批量编辑、保存视图、分组/标签、断货解释。

### 3.3 怎么建

**监控规则引擎（Phase 2 核心，对接货源监控）**：

```
source.rescan job（调度：每 listing 每 6-24h，插件用户在线时浏览器内重采最稳，
                服务端裸抓 1688 会风控——这是已验证约束）
  → 对比 source_items 旧值 → source_changes（新表：change_type, old, new, detected_at）
  → 应用到每条关联 listing：
     price  变 → 按 pricing 规则重算 → syncPolicy.price == auto ? 直接改价+写 lastAutoAction : 打 drift 标记
     stock  变 → trackStock=on ? 推 Shopify 库存 : 标记；库存归 0 → 可选"自动下架/置0"
     title/图 变 → 永远只标记（内容权在用户侧）
     货源下架 → 高优告警 + 可选自动下架
```

**AutoDS 踩过的坑要吸收**：监控设置变更只影响之后上传的品，存量品要显式批量开启（否则用户以为老品已监控实际没有）；扫描周期、最低库存阈值、最大发货天数都是 per-supplier/per-store 可配。

**列表规格**（对齐竞品+自身原则）：
- 三 tab：草稿（draft/失败）/ 在线（published）/ 关注（drift+货源变化+远端删除的并集）
- 列：图、标题（双行：本地标题 vs 远端标题有 drift 时黄标）、SKU数、售价/货源价（有变高亮）、库存、远端状态、健康（错误原因就地展开）、发布渠道
- 批量操作：改价（设为/调 ±%/±额、变体级覆盖）、改标签、重跑 AI、重新发布、同步策略批量设置、库存推送开关
- 筛选可保存为视图（AutoDS Match All/Any）；列可配置；分组/标签/备注字段
- 抽屉编辑（不跳页）+ 编辑历史（diff vs 远端快照）

**数据模型补充**：`source_changes`（货源变化事件流，也是"黄色感叹号"的数据源）；listings 加 `groupIds/tagIds` 复用 label 机制或新 `listing_labels` 关联表。

---

## 4. 商品优化工作流

### 4.1 竞品形态

| 竞品 | 形态 | 问题 |
|---|---|---|
| 妙手 AI工作台 | 工具箱（文生图/抠图/裂变/素材贴合/换场景/高清放大/图生标题/一键发品）+ **我的工作流**：自定义工具顺序 → 导图批量套 | 独立工具页，和刊登主流程断开；结果直接覆盖无 diff；按积分计费打断流程 |
| DSers AI Optimize | 编辑页标题/描述旁 ✨ 按钮：关键词+要求+目标语言(14种) → 重写；另接 AI 翻译/图片优化 | 单字段手动触发，不是管线 |
| AutoDS | "Optimize with AI" 按钮 | 同上 |

### 4.2 现状（已是正确形态）

`ai.enhance` job → `listing_suggestions`（字段级：title/descriptionHtml/productType/tags/options/category/attributes，pending→accepted/rejected）；`term_mappings` 术语学习（接受的建议沉淀为词对）；`category_mappings`/`attribute_mappings`（确认一次自动套用）；`ai_usage` 计量；`AI_IMAGE`（白底图）已上。

### 4.3 升级方向：stage 管线

把 aiEnhance 重构为**有序 stage 注册表**——每 stage 产出仍是 `listing_suggestions`（接受前不动本体，这个机制不变），但获得编排能力：

| stage | 类型 | 输入 | 输出建议字段 | 备注 |
|---|---|---|---|---|
| clean | 确定性 | 原始字段+stores.rules | title/desc/attrs | 去供应商话术、违规词替换、前后缀——已部分实现为认领预处理，迁入 stage 统一编排 |
| translate | LLM+term_mappings | title/options/attrs | 同上 | 术语表先查，未知词走 LLM，接受后回写 term_mappings（已在）|
| title | LLM | 译后标题+类目+关键词 | title | 长度/SEO 规则随渠道 |
| description | LLM | 属性+卖点 | descriptionHtml | HTML 模板按店铺风格 |
| category | LLM+缓存 | 类目路径+标题 | category | category_mappings 命中即跳过（已在）|
| attributes | LLM | 1688 attrs+类目 schema | attributes | 值归一；必填缺失 → warn 进门禁 |
| options | LLM | SKU 矩阵 | options | 变体名/选项值翻译 |
| images | 图像服务 | images/descImages | images | 白底图已上线；去水印/图片翻译（OCR+重绘）v2 接第三方 |
| pricing | 确定性 | source 价 + pricing | variants.price | 重算+尾数；监控重算也复用此 stage |
| compliance | 确定性+词库 | 全字段 | （产出 issue 不是建议）| 品牌词/敏感词/类目禁售 → block/warn |
| seo | LLM | 标题+描述 | seoTitle/seoDescription | Shopify meta；v2 |

**`listing_workflows`（妙手"我的工作流"的对应物）**：`{workspace_id, name, stages: [{stage, params, on}], isDefault}`。店铺绑定一个工作流；认领即跑。stage 结果是幂等的（同输入重跑覆盖同字段 pending 建议）。

**与妙手的差异**（我们成立的原因）：①工作流在主链路默认跑，产物是"待审核成品"不是原料；②逐条 diff 接受/回退，批量接受按字段类型；③合规检查内嵌为发布门禁而非另售工具；④接受行为反哺 term/category/attribute mappings，用得越久自动化率越高——这是可量化的产品指标「自动接受率」，值得埋点。

---

## 5. 订单管理

### 5.1 竞品形态

**妙手订单处理流**（跨境 ERP 标准范式）：授权货代/物流商 → 店铺订单同步汇总 → 审核订单 → 待处理（**调用库存**[自营/三方仓] 或 **代发采购**[线上拿货] → 申请运单号 → 移入待打单）→ 打单发货 → 交运平台 → 已发货。另有：
- **一键下单**：插件装好后，店铺订单→选货源链接+规格+收货地址（买家地址或货代地址）→ 跳货源平台自动填单下单
- **代发采购**：订单信息直接同步货代系统（货小易体系的货代可授权打通，实时回传处理进度）；余额不足拦在录单环节
- **提交代打包**：自采/自备货时手工录入快递单号或采购信息同步货代

**AutoDS 三档**：Fulfilled-by-AutoDS（他们用自己买家账号全托管下单+退换）、Auto-Order 全自动（用你的买家账号自动下单）、半自动（你手动下单、它管运单回传）。

**CJ API 流**（自建履约网络范式）：查库存 → createOrder → addCart → confirm → 生成父单+支付 → 传面单/物流 → 轨迹查询。证明"订单→采购→面单→轨迹"全程 API 化可行，但要求对方是有 API 的履约商（CJ/货代），1688 散货不行。

### 5.2 我们的现实约束与设计分层

| 采购路径 | 可行性 | 说明 |
|---|---|---|
| A. **插件辅助一键下单** | ★ 近期主力 | 我们已有插件+用户 1688 登录态：订单行点「去采购」→ 打开 1688 下单页，插件自动填 SKU/数量/收货地址（买家地址或货代仓地址）→ 用户确认支付。半自动但零资质门槛 |
| B. **货代 API** | ★ 中期 | 授权货代后订单直推货代系统（收货=货代仓），货代回传国际运单。妙手走货小易体系；我们接 1-2 家开放 API 的货代/集运（云途/递四方类） |
| C. **1688 官方 trade API** | 需企业 ISV 资质申请 | open.1688.com 铺货分销方案包：一键铺货/订单回流/批量支付/自动发货。是终局路径，申请门槛高，做成 `ProcurementDriver` 插件点 |
| D. 平台代付（AutoDS FBA 型） | ✗ 不做 | 需要垫资+买家账号矩阵，风险和法律复杂度不配当前体量 |

**抽象：每条 order_item 绑定一个货源解析结果**（已在认领时建立 listing.variant.sku ↔ source sku 的确定性映射，下单即解析为「offerId + specId + qty + 收货地址」）：

```
orders ──► order_items ──► (SKU 映射) ──► purchase_orders ──► shipments
（店铺单）   （行项目）      未匹配进待配对      （采购单/货代单）   （运单/履约回传）
```

### 5.3 数据模型

```sql
orders:        workspace_id, store_id, remote_id, order_number, name(#1001),
               financial_status, fulfillment_status, order_status(派生主状态),
               customer{name,email,phone}, shipping_address jsonb,
               currency, subtotal, total, items_count, 
               placed_at, synced_at, raw jsonb(原报文留档)
order_items:   order_id, remote_line_item_id, title, sku, qty, unit_price,
               listing_id, variant_sku, source_item_id, source_sku_id,
               mapping: "matched|unmatched|partial", -- 未匹配进配对队列
               procure_status: "none|queued|placed|shipped|done|failed"
purchase_orders: workspace_id, kind: "source_order|forwarder|manual",
               source_platform, source_seller, status: draft→placed→paid→
                 domestically_shipped→forwarder_received→intl_shipped→done|exception,
               source_order_id(1688订单号), domestic_tracking jsonb[],
               forwarder_id, intl_tracking jsonb[], cost_total_cny, note
purchase_order_items: po_id, order_item_id, qty, unit_price_cny
shipments:     order_id, po_id nullable, carrier, tracking_no,
               remote_fulfillment_id(Shopify fulfillment gid),
               status: pending→pushed→accepted→in_transit→delivered|failed
order_events:  order_id, type, payload, created_at -- 状态变迁留痕（审计/debug）
```

**订单主状态机**（用户视图）：
`新单(待审核) → 待采购(已配对/未配对) → 采购中 → 待发货 → 已发货(已回传运单) → 已完成`；旁路：`已取消 / 退款中 / 异常(地址无效·缺货·采购失败)`。妙手式多 tab：全部/待审核/待处理/待打单/已发货/异常/售后。

### 5.4 Shopify 侧接入（技术事实）

- 同步：`orders/create` + `orders/updated` + `orders/cancelled` webhook（需公网地址，Phase 0 部署后具备）+ 手动/定时 backfill（`orders` query, `updated_at` 增量）。退款用 `refunds/create`。
- 履约回传：当前 API 走 `fulfillmentOrders` 体系——查 order 的 fulfillmentOrders → `fulfillmentCreate`（带 `trackingInfo{number,company,url}`）；改单/部分发货对应多个 fulfillmentOrder。**不要再用 legacy Fulfillment API**（2022-07 已废）。
- 库存策略：若做"调用库存"模式需要 fulfillment service 注册或把库存放 shop location；v1 代发模式只推 tracking 即可。
- 地址加密：Shopify 客户地址进我们库要加密/脱敏展示（合规），phone/email 用于采购下单。

### 5.5 页面

一级导航加「订单」：tab 式状态列表（妙手布局但清爽版），行内展开：商品行（映射状态标）、收货地址（一键复制到货代）、采购状态链（1688 单号/国内段/货代/国际段）、利润估算（售价-采购-运费）。操作：审核、去采购（插件链路）、申请运单/发货（回写 Shopify）、备注。「采购」页管理 purchase_orders（按供应商分组、批量下单导出）。

---

## 6. 仓储功能

### 6.1 竞品形态分层

| 层 | 竞品证据 | 对应我们场景 |
|---|---|---|
| L1 虚拟库存/库存推送 | 店小秘「库存推送」：SKU→多店铺推送规则，实时同步防超卖；AutoDS 库存监控：源缺货自动 OOS、最低数量阈值 | **铺货模式核心**：货源即库存，规则决定往渠道推什么数 |
| L2 货代仓/中转 | 妙手货代管理：货代地址作为收货地址、代打包、订单直推货代系统、处理进度回传 | 订单履约的国内段终点 |
| L3 自营仓/三方仓 | 妙手「仓库」：商品管理(SKU 主档)→采购单→入库→库存→「调用库存」出库→出库单；采购建议（缺货建议/备货建议一键生成采购单）；店小秘对接 130+ 海外仓 | 出单稳定后卖家会备货——这是从"铺货工具"升"ERP"的分水岭 |
| L4 平台托管备货 | 妙手 Temu 全托管：备货单（普通/紧急/JIT）→自动加入发货台→创建发货单→装箱→箱唛/条码/合规标签→送平台仓；跨店合并发货 | 只有接了托管类渠道（Temu/速卖通全托管）才需要 |
| L5 三方履约网络 | CJ 3PL：货发 CJ 仓（中美欧 10+ 仓），库存/订单/面单/轨迹全 API | 远期：可整包对接一家代替自建 L3 |

### 6.2 建议的分层建设

**L1（现在，跟 Phase 2 一起）**：货源监控结果落到库存语义——
```
inventory_push_rules: workspace_id, scope(listing|source_item|store), 
  strategy: "mirror" (源库存直通) | "fixed n" | "percent" | "cap",
  buffer: 安全库存扣减, oos_action: "zero|unpublish|notify"
```
Shopify 侧经 `inventorySetQuantities`（现有 trackStock 的扩展）。多店铺同货源 → 每店一条规则。

**L2（跟订单 Phase 一起）**：`freight_forwarders`（名称/系统类型[货小易可直连/手工]/收件地址簿/授权凭据引用 secrets）；订单收货地址选「货代仓」= 该地址；采购单 kind=forwarder 时回传进度写 po 状态机。先做"地址簿+状态手动回传"，API 直连看接入成本。

**L3（Phase 5+，有真实备货需求再做）**：
```
product_skus(SKU主档): workspace_id, sku, title, barcode, dims/weight,
                       default_source_item_id, listing 绑定多对一
warehouses: self|third_party, address
stock_levels(warehouse_id, sku_id): on_hand, locked(订单锁定), in_transit
stock_movements: in(采购入库)|out(订单出库)|adjust|lock, ref_type/ref_id, qty —— 只增不改台账
```
采购单此时升级复用：po.kind=self_stock → 到货入库 → stock_levels → 订单走「调用库存」分支而非代发。妙手的「采购建议」（按缺货/备货规则一键生成采购单）在此层才有意义。

**L4（接托管渠道时才动）**：平台备货单 inbound_plans/发货台/装箱/箱唛——届时按平台 API 单独立项，架构上挂 `warehouses(type:platform)` + 新模块，不污染现有表。

### 6.3 不要做的事

- 不要在 L1 之前建 SKU 主档——铺货期 listing↔source 已够，提前建主档 = 双写灾难（managed-lifecycle.md 的"不新增 listing_drafts"同理）
- 不要混用「货源库存」与「自有库存」一个字段——stock_levels 只管自有，货源库存就是 source_items.skus[].canBookCount 的最新快照

---

## 7. 汇总：新增表 / job / 页面清单

**新表**（按启用 Phase 排序）：

| Phase | 表 |
|---|---|
| 2 | source_changes, inventory_push_rules |
| 3 | （无需新表）PipelinePolicy 入 stores.rules/listing_templates；listing_labels |
| 3.5 | orders, order_items, purchase_orders, purchase_order_items, shipments, order_events, freight_forwarders |
| 4+ | selection_plans, discovery_items, suppliers |
| 5+ | product_skus, warehouses, stock_levels, stock_movements |

**新 job 类型**：`selection.run`、`source.rescan`、`monitor.apply`（drift→自动动作）、`order.sync`（webhook 外兜底轮询）、`order.map`、`procure.submit`、`fulfill.push`、`inventory.push`、`listing.republish`。

**页面演进**（原则不变：按流程组织、不跳页、任务就地可见）：
铺货（采集→刊登链路，含链路进度）｜选品｜商品（草稿/在线/关注三 tab）｜订单（状态 tab）｜采购｜仓储（L1 库存规则 → L3 仓库）｜店铺｜任务（历史）｜设置。

**抽象补充**：`ProcurementDriver`（1688插件辅助/货代API/官方trade API 三实现）与 `ChannelAdapter` 并列；`fulfill.push` 由 adapter 提供 `pushFulfillment(order, tracking)` 方法；订单 SKU 映射规则收口到认领时生成的变体 SKU 方案（保证 `orderItem.sku → listing.variant → sourceItem.sku` 可解析）。

## 8. 关键决策点（留给产品/技术评审）

1. **订单 Phase 是否提前到第二渠道之前**——本文建议提前（闭环价值 > 渠道广度）。
2. **采购是否一开始就做「货代」分支**——如果目标用户都是发 1688 跨境代发直邮，货代 L2 可后移；先确认用户发货模式画像。
3. **AI 选品的数据源投入**：1688 官方 ISV 申请（跨境热卖/搜索 API）值得尽早启动，周期不可控，先并行做插件侧采集版。
4. **库存推送的防超卖责任边界**：镜像源库存有滞后窗口（重采间隔），要在 UI 明确"非实时"语义，buffer 默认给安全值。
5. **仓储 L3 触发条件**：当有 X% 周活用户开始用「采购单」周频补货时再启动，别提前建。

## 参考

- [妙手：订单处理基础](https://erp.91miaoshou.com/help_center/article_12293.html) / [一键下单](https://erp.91miaoshou.com/help_center/article_3231.html) / [货代同步](https://erp.91miaoshou.com/help_center/article_3067.html) / [货代授权](https://erp.91miaoshou.com/help_center/article_3109.html)
- [妙手：AI选品](https://erp.91miaoshou.com/help_center/article_12394.html) / [AI选品专家](https://erp.91miaoshou.com/help_center/article_14744.html) / [AI工作台](https://erp.91miaoshou.com/help_center/article_9306.html) / [1688跨境热卖](https://erp.91miaoshou.com/help_center/article_15104.html)
- [妙手：发布配置(定时/频率)](https://erp.91miaoshou.com/help_center/article_2886.html) / [发布频率控制](https://erp.91miaoshou.com/help_center/article_2885.html) / [Temu备货](https://erp.91miaoshou.com/help_center/article_3099.html) / [采购建议→采购单](https://erp.91miaoshou.com/help_center/article_6638.html)
- [店小秘：库存推送](https://help.dianxiaomi.com/article/inventoryManagement/2786)
- [AutoDS：FBA](https://help.autods.com/en/articles/12700443) / [Auto-Order](https://help.autods.com/en/articles/12700517) / [Price&Stock 监控](https://help.autods.com/en/articles/12699906) / [Product Finding Hub](https://help.autods.com/en/articles/12700452) / [Marketplace](https://help.autods.com/en/articles/12699962)
- [DSers：AI 优化](https://help.dsers.com/ai-product-information-optimization/) / [Push to Store](https://help.dsers.com/edit-products-push-products-to-your-store/)
- [Shopify：fulfillment orders 迁移](https://shopify.dev/docs/apps/build/orders-fulfillment/migrate-to-fulfillment-orders) / [fulfillment 方案](https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/build-fulfillment-solutions)
- [1688 开放平台（铺货分销方案包）](https://open.1688.com/)
- [CJ API：订单同步流](https://developers.cjdropshipping.com/en/api/start/Orders-Synchronization-Processing.html)
- 仓库内：product-plan.md / managed-lifecycle.md / research-sourcing-inquiry.md / research-1688.md / research-marketplaces.md
