# 全链路实施规格 —— 最终版（裁决稿）

> 2026-09-26。输入：docs/research-full-link-architecture.md（调研）、两份对立方案（devin/fl-plan-minimal、devin/fl-plan-platform）及互评。
> 仲裁原则：政策/配置类入 `stores.rules` jsonb（listing_templates 免费模板化）；**状态与事件类**不塞进 audit 混用——需要在 UI 查询/推进的建窄表或列；不给无第二实现的抽象建接口；调研缓建项（L3/L4 仓储、自动发盘、suppliers 主档、saved_views 服务端、官方 trade API）不建。

## 0. 裁决结果（相对两派的取舍）

| 争点 | 裁决 | 理由 |
|---|---|---|
| PipelinePolicy 存哪 | `stores.rules.pipeline`（最小派） | 策略=店铺刊登设置的延伸；模板克隆即复制。平台派的"一店多策略"是伪需求 |
| 链路状态 | **listings 加列** `pipeline_stage`/`pipeline_hold_reason`/`policy_snapshot jsonb`（新裁决） | 双方各对一半：平台派要"可写状态行"对（链路徽标/卡点恢复必须有落点），最小派"不要平行台账"对——状态直接长在 listing 行上，单写者，无对账问题。不建 pipeline_runs 表 |
| stage 管线 | 代码注册表 + `listing_suggestions.stage` 幂等列（最小派）；不建 listing_workflows/runs | clean/pricing/compliance 是确定性不变量不可编排；v1 只有 2 个 LLM stage |
| 货源变化事件 | **建 `source_changes` 表**（平台派），但 `monitor_rules`/`monitor.apply` 不建——diff 检测与消费判定都在 propagateToListings 内联 | "关注"tab 和"应用/忽略"语义需要可查询的未消费游标，audit payload 查询吃力且混入高频扫描噪音 |
| order_events | 并入 `audit_logs`（entityType='order'/'purchase_order'） | 机制逐字重合，平台派已认 |
| suppliers | 不建主档 | 信号快照 denormalize 进 discovery_items.signals；PO 按 source_seller 文本分组 |
| labels | `listings.internal_tags text[]`（最小派补救） | listings.tags 会发往 Shopify，复用是 bug；一列数组不要 M:N |
| monitor_rules.interval_hours | 不建 | 回扫节奏由插件 alarm 决定，服务端旋钮不会被执行 |
| ProcurementDriver | 不建接口 | 两臂无实现=死代码；`purchase_orders.kind` + dispatch switch，第二驱动落地时再抽 |
| 采购自动填表 | 不做 | 改做「采购信息卡」：插件开 1688 详情页浮层给规格/数量/地址一键复制+「标记已下单」回填 |
| shipments.status | `pending|pushed|failed` | in_transit/delivered 无数据供给，枚举不写死值 |
| reconcile | 建：每日 `inventory.reconcile` cron | 事件可漏（propagate 半截失败），最小派已认值得拿 |
| remote_variant_map | 建：`listings.remote_variant_map jsonb`，发布回填 | 订单映射主键级稳定度，平台派已吸收 |
| saved_views | defer（localStorage） | 双方一致 |
| 货代 | 仅 `freight_forwarders` 地址簿 + PO.forwarder_id | API 直连 defer |

## 1. Schema 变更（最终）

### 1.1 现有表加列
```
listings:        publish_at timestamptz null
                 remote_variant_map jsonb null   -- {variantSku:{variantId,inventoryItemId}}
                 source_changed_at timestamptz null
                 internal_tags text[] null
                 pipeline_stage text null         -- claimed|ai_running|hold_ai|precheck|hold_precheck|queued|publishing|published|failed|null(非链路)
                 pipeline_hold_reason text null
                 policy_snapshot jsonb null       -- advance 时生效策略快照（审计可答"为什么自动发了"）
listing_suggestions: stage text not null default 'ai'
source_items:    collected_via text null         -- manual|plan|inquiry
                 availability text not null default 'ok'  -- ok|delisted
stores:          orders_cursor text null         -- order.sync 轮询游标
```

### 1.2 `stores.rules` 新键（jsonb，无 DDL）
```ts
pipeline?: { autoClaim, autoAcceptFields: SuggestionField[], holdPoint: "after_ai"|"after_precheck"|"auto",
             autoPublish, publishMode: "now"|"scheduled"|"paced", publishAt?, paceMinutes?, holdOnWarning,
             disabledStages?: string[] }
inventory?: { strategy:"mirror"|"fixed"|"percent"|"cap", fixedQty?, percent?, cap?, buffer?,
              oosAction:"zero"|"unpublish"|"notify" }
monitor?:   { enabled:boolean /*默认关，批量开启入口*/, minStock?, priceAuto:boolean }
```

### 1.3 新表（9 张）
```
orders / order_items / purchase_orders / purchase_order_items / shipments / freight_forwarders
  —— 字段按 minimal 方案 §2.3（status 枚举 trimmed：order=new|to_procure|procuring|to_ship|shipped|done|cancelled|exception）
source_changes
  id, workspace_id, source_item_id fk, change_type(price|stock|title|images|attributes|delisted),
  sku_id text null, old_value jsonb, new_value jsonb,
  detected_at, applied_at null, applied_action jsonb null   -- {listingId,action}[]
  idx(workspace_id, source_item_id, detected_at), partial idx applied_at is null
selection_plans / discovery_items —— 按 minimal 方案 §2.3（schedule: manual|daily）
```

## 2. Job 清单（新 8 个）

`listing.claim` / `pipeline.advance` / `listing.pushPrice` / `order.sync` / `order.map` / `fulfill.push` / `inventory.reconcile`（每日）/ `selection.score`

## 3. 链路编排（无 runner）

```
POST /collect 成功 → 命中 autoClaim 店 → enqueue listing.claim
listing.claim → claimItems() 复用 → listing.pipeline_stage='claimed' → enqueue aiEnhance(改 stage 注册表入口)
aiEnhance 完成 → pipeline.advance：
  ① autoAcceptFields 白名单 → 复用 applySuggestion+学习钩子  ② holdPoint=after_ai → stage=hold_ai 停
  ③ precheck=adapter.validate+findBannedWords（同发布门禁）④ warn&&holdOnWarning → hold_precheck
  ⑤ autoPublish → enqueue listing.publish runAt=max(now,publish_at|publishAt,店 last published+paceMinutes)
发布成功 → stage=published；失败 → failed + 熔断判定（当日 publish_attempts 失败率>50% 且样本>5 → audit+停止排新发布）
```

## 4. 订单域

- 同步：webhook（oauth 店连接时 `webhookSubscriptionCreate` 注册 orders/create|updated|cancelled；toml 声明自有应用）+ 每店 `order.sync` 增量轮询兜底（stores.orders_cursor，webhook 只入队不处理报文——worker 拉最新单，payload 过期免疫）。手动 token 店只走轮询（验签盲区已在互评确认）。
- scope 追加：`read_orders,write_merchant_managed_fulfillment_orders`（env 默认值更新）。
- `order.map`：remote_variant_id ∈ remoteVariantMap → sku==variant.sku → unmatched（人工 bind 端点）。
- 状态派生纯函数：item.procure_status + shipments + financial_status → orders.status 写回。
- 采购：`POST /orders/:id/procure` → 返回 {offerId,specText,qty,address} → site-bridge PROCURE_1688 → 插件详情页浮层采购卡（复制+标记已下单回填 source_order_id）。
- 履约：`fulfill.push` → fulfillmentOrders→fulfillmentCreate（不用 legacy API）→ 写回 remote_fulfillment_id。
- 地址：shipping_address_enc 走 SecretBox；列表脱敏；「复制地址」单独端点。
- 审计：order/purchase_order 事件写 audit_logs。

## 5. 选品域

- 数据全走插件回流：被动（list.ts 卡片扫描命中 plan filters 顺手 POST /discovery/feed）+ 主动（plan.schedule=daily → GET /discovery/tasks 由插件 alarm 顺带拉取 → SW fetch 搜索/榜单页 → DOMParser 提卡 → feed）。服务端不裸抓。
- 评分：确定性信号（daiFa/48h/回头率/价带/毛利试算）→ score；LLM 只给 top-20 写 ai_note。信号拿不到就留空，不伪造。
- 采集：勾选 → /discovery/collect → 插件 STAGE→详情页重采 → collected_via='plan'。
- 新 workspace 预置 3 个 plan。

## 6. 商品列表/监控/仓储 L1

- propagateToListings 内 diff → 写 source_changes + listings.source_changed_at + audit(action='source.change') + 应用判定：
  price→priceAuto&&syncPolicy=auto ? 重算+pushPrice : drift；stock→inventory 规则→pushStock；title/images/attrs→只标 drift；delisted→oosAction。
- `POST /collect/report {offerId, availability}` 插件上报下架。
- 商品页三 tab（草稿/在线/关注=drift∪未消费 changes∪remote_deleted∪delisted）+ 批量（price_set/mul/add、tag、syncPolicy、publish_at、batchEnableMonitor）。
- L1 库存：stores.rules.inventory 策略 f(sourceStock)-buffer → inventorySetQuantities；UI 明示非实时（~4h 回扫）；每日 inventory.reconcile 兜底。
- L2：freight_forwarders 地址簿 + PO.forwarder_id + 采购卡地址切换。

## 7. stage 注册表

- `src/ai/stages/`：`interface Stage{key;kind;run(ctx)}`，STAGES 有序注册表（v1= enhance、categorySuggest 两个 LLM stage 迁入；clean/pricing/compliance 保持原位不编排）。disabledStages 可关。
- `listing_suggestions` 幂等粒度：(listing_id, field, stage) 删 pending 再插。decide/学习钩子零改动。

## 8. REST 与页面

REST/页面按 minimal §5/§6 + pipeline 徽标读 listings.pipeline_stage（列表接口带 stage 字段，无聚合查询）。新增一级导航：订单、采购、选品。店铺抽屉加「自动化链路」「库存规则」「监控」设置组；设置页货代地址簿。

## 9. 分波实施（子 Agent 边界）

| 分支 | 范围 | 交付 |
|---|---|---|
| devin/fl-pipeline | stores.rules.pipeline + listing.claim + pipeline.advance + stage 注册表 + suggestions.stage + 链路徽标字段 + 店铺自动化设置 UI + 熔断 | 后端+UI+测试 |
| devin/fl-monitor | source_changes + propagate diff + pushPrice + internal_tags + 批量端点 + 商品三 tab + inventory 规则 + reconcile + collect/report + 货代地址簿 CRUD | 后端+UI+测试 |
| devin/fl-orders | 订单 6 表 + order.sync/map + webhook topics + fulfill.push + 订单/采购页 + 插件采购卡 | 后端+UI+插件+测试 |
| devin/fl-selection | selection_plans + discovery_items + feed/tasks/collect + score + 选品页 + 插件回流 | 后端+UI+插件+测试 |

边界纪律：schema.ts/migrations 各分支只加自己的表与列（冲突列名已划分如上：pipeline_* / remote_variant_map / source_changed_at / internal_tags / publish_at 归 fl-pipeline 与 fl-monitor 按 §1.1 归属——remote_variant_map 归 fl-orders 回填逻辑但列定义放 fl-monitor 一并加？→ 裁决：所有 listings 新列统一由 fl-pipeline 建（它最先合），fl-monitor 只建 source_changes+source_items 列，fl-orders 建订单 6 表+stores.orders_cursor，fl-selection 建选品 2 表+source_items.collected_via 若 fl-monitor 未建则加）。集成交给统筹者。

## 10. 硬性约束（所有实现者遵守）

- AGENTS.md 全条照旧；每个新路由写跨 workspace 测试。
- 慢操作走 jobs；listing 远端字段权属遵守 managed-lifecycle（远端字段不覆盖用户草稿态）。
- 不做：表单自动填、suppliers 表、monitor_rules 表、pipeline_runs 表、listing_workflows 表、order_events 表、ProcurementDriver 接口、L3/L4、自动发盘、服务端裸抓 1688。
