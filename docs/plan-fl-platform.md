# 全链路实施方案（平台完整派）

> 2026-09-26。立场：**按调研文档的完整蓝图落地六大域，把架构做对做全，不为省事砍结构**。
> 输入规格：`docs/research-full-link-architecture.md`（六大域拆解）；上游：`docs/product-plan.md`（路线图）、`docs/managed-lifecycle.md`（字段所有权与托管状态裁决）。
> 本文只给实施规格（表字段级 / job 与链路编排 / REST 路由 / 页面 / 测试 / 分波），不写实现代码。
> 遵守调研文档自己的缓建标记：**仓储 L3/L4、自动发盘（AI 询盘自动发送）不建**，但表结构与抽象位预留。

---

## 0. 总览

### 0.1 分波顺序（与调研文档 Phase 对齐，重排后）

| 波次 | 域 | 新表 | 理由 |
|---|---|---|---|
| W1 | 商品优化工作流（stage 管线） | listing_workflows、listing_workflow_runs | 它是一键上品链路里 AI 段的载体，也是商品列表「重跑 AI」的后端——先做它，后面两个域都踩在它的注册表上 |
| W2a | 一键上品（链路编排） | pipeline_policies、pipeline_runs | 复用 W1 的 stage 管线作为中间段 |
| W2b | 商品列表（监控规则引擎） | source_changes、monitor_rules、inventory_push_rules（仓储 L1）、labels、listing_labels、saved_views | 与 W2a 并行；`source_changes` 事件流是仓储 L1 库存推送的唯一触发源 |
| W3 | 订单管理 + 仓储 L2 | orders、order_items、purchase_orders、purchase_order_items、shipments、order_events、freight_forwarders | 调研建议的 Phase 3.5：闭环价值 > 渠道广度 |
| W4 | AI 选品 | selection_plans、discovery_items、suppliers | 最上游，依赖插件采集链路已稳定 |
| 缓建 | 仓储 L3/L4 | product_skus、warehouses、stock_levels、stock_movements | 触发条件：周活用户中出现稳定「采购单补货」行为再启动（调研 §8.5） |

### 0.2 关键决策点速答（正文有完整论证）

| 决策点 | 答案 |
|---|---|
| 订单同步 webhook vs 轮询 | **webhook 为主、轮询兜底**。注册方式：店铺连接成功后由 adapter 调 `webhookSubscriptionCreate` 声明 `orders/create`+`orders/updated`+`orders/cancelled`+`refunds/create`，指向 `/api/shopify/webhooks`（已有 HMAC 校验端点，按 topic 分发）；`order.sync` job 每 15min 增量轮询（`updated_at` 游标）补 webhook 丢单 |
| 链路编排：jobs 链式 vs pipeline runner | **双层**：jobs 保持链式传输（每种 job 独立重试/幂等），新增 `pipeline_runs` 表作为链路状态机——进度徽标、卡点暂停、失败恢复都从它读，不从瞬时 job 行推导 |
| stage 管线与 listing_suggestions 兼容 | `listing_suggestions` 加 `stage`+`run_id` 两列，仍是唯一审核面；每 stage 产出同字段 pending 建议（重跑幂等覆盖）；接受/学习 term_mappings 链路不变 |
| discovery_items 数据源 | **插件侧采集**（跨境热卖榜单页 + 搜索/以图搜款页，浏览器内已验证可行）；1688 官方 ISV API 并行申请，接入后作为第二 `source` 值复用同表同评分器 |
| inventory_push_rules 触发时机 | **事件驱动**：`source_changes(stock)` → `monitor.apply` 内评估规则 → `inventory.push` job；另加每日 reconcile 兜底 + 手动「立即推送」 |

---

## 1. 商品优化工作流（stage 管线）— W1

**立场**：调研 §4.3 的 11 个 stage 一个不少地进注册表；aiEnhance 单体 handler 重构为有序 stage 编排。
**为什么值得建全**：stage 注册表是三个域的共用后端（AI 产线、链路编排的 AI 段、商品列表「重跑 AI」按钮）。若只做"给现有 handler 加几个开关"，第 6 个 stage 加入时就要返工成注册表，届时还要迁移存量 suggestion 归属。

### 1.1 表

```sql
listing_workflows（妙手「我的工作流」对应物）
  id uuid pk, workspace_id, name text, is_default bool default false,
  stages jsonb  -- [{stage: "clean"|"translate"|"title"|"description"|"category"|
                --   "attributes"|"options"|"images"|"pricing"|"compliance"|"seo",
                --   params: {...}, on: true}]
  created_at, updated_at
  uq(workspace_id, name)

listing_workflow_runs（一次工作流执行；一条 listing 任一时刻至多一条 running）
  id uuid pk, workspace_id, listing_id fk, workflow_id fk null(临时跑),
  status: "queued|running|succeeded|failed|partial|cancelled",
  current_stage text,
  stage_states jsonb  -- [{stage, status, suggestion_ids[], error, duration_ms}]
  job_id fk->jobs, started_at, finished_at, created_at, updated_at
  idx(workspace_id, status), idx(listing_id, created_at)

-- stores 加列
workflow_id uuid null fk->listing_workflows.id  -- 店铺绑定工作流；null=workspace 默认

-- listing_suggestions 加列
stage text null            -- 产出它的 stage key；null 兼容存量
run_id uuid null fk->listing_workflow_runs.id
```

**为什么值得建全**：`listing_workflow_runs` 而非只放 jobs 表——jobs 是传输队列（执行完即历史），run 是业务记录（stage 级断点、每 stage 产出的 suggestion 集合、耗时分布），「自动接受率」埋点也落在它上面。stage 归属列让「重跑 pricing stage」精确覆盖旧建议而不误伤人工已接受的。

### 1.2 stage 注册表与链路编排

```ts
// apps/server/src/ai/stages/registry.ts
interface StageDef {
  key: StageKey;                       // 11 个固定枚举
  kind: "deterministic" | "llm" | "image";
  outputFields: SuggestionField[];     // 写入 listing_suggestions.field
  run(ctx: StageCtx): Promise<StageResult>;  // ctx 含 listing/store/sourceItem/已有建议
}
const REGISTRY: Record<StageKey, StageDef>
```

- `listing.workflowRun` job（取代 `listing.aiEnhance` 成为编排入口）：取 run → 按 workflow.stages 顺序执行 → 每 stage 幂等写 suggestion（同 (listing_id, field, stage) 先删 pending 再插）→ stage 失败记 `stage_states` 并续跑下一个（LLM 类失败不阻塞确定性类）→ 完成按 `pipeline_runs` 卡点决定是否推进。
- `clean` stage 迁入：现有认领预处理（stores.rules 前缀/替换/价格过滤/图数）改为同时被 `clean` stage 消费——认领时跑一次确定性版本（保证草稿立即可读），workflow 里的 `clean` 是同一函数在 stage 上下文的重放，不双写逻辑。
- `pricing` stage 与监控复用：`source_changes(price)` 的自动重算走同一个 `pricing` stage 函数，区别只是调用方（workflow run vs monitor.apply）。
- `listing.aiEnhance` 保留为薄包装（enqueue 一个使用店铺绑定 workflow 的 run），老接口 `POST /listings/:id/ai-enhance` 语义不变。

### 1.3 REST

```
GET/POST/PATCH/DELETE /api/workflows            CRUD + isDefault
POST /api/workflows/:id/bind {storeId[]}        店铺绑定
POST /api/listings/:id/workflow-runs {workflowId?, stages?}  手动重跑（可只跑指定 stage）
GET  /api/listings/:id/workflow-runs            该刊登的 run 历史（含 stage_states）
```

### 1.4 页面

- 设置页新增「工作流」tab：工作流列表 + stage 开关/排序编辑器（params 内联表单，如 description 的 HTML 模板、title 的关键词偏好）。
- 刊登编辑页建议卡片头部显示 stage 徽标（clean/translate/title…），「重跑此 stage」按钮。
- 店铺设置里「AI 产线」开关升级为「工作流选择器 + 开关」。

### 1.5 测试

- registry：每个 stage 单测（deterministic 全量、LLM 用 fake adapter）；stage 幂等（同输入重跑覆盖 pending，不动 accepted）。
- run 编排：stage 顺序、单 stage 失败续跑、run 状态机、并发 run 对同 listing 的互斥。
- 兼容：存量无 stage 的 suggestion 审核链路不回归；accept→term_mappings 学习链路不回归。
- 跨 workspace 隔离测试（按 AGENTS 约定）。

---

## 2. 一键上品（链路编排）— W2a

**立场**：PipelinePolicy 独立建表（不塞 stores.rules），链路状态机独立成 `pipeline_runs`。
**为什么值得建全**：policy 是要被编辑/模板化/审计的产品对象（妙手把它做成发布设置页的完整表单），塞进 `stores.rules` 会让 `listing_templates.payload` 的类型（`StoreSettingsPayload`）被迫扩成混合容器，且无法表达「同一店多套链路策略」。pipeline_runs 是链路进度徽标与熔断恢复的数据源——没有它，「这条刊登卡在 AI 还是门禁」要靠扫 jobs 表反推。

### 2.1 表

```sql
pipeline_policies
  id uuid pk, workspace_id, store_id uuid null fk->stores.id,  -- null=workspace 默认
  name text,
  auto_claim bool default false,            -- 采集即认领
  auto_accept_fields jsonb default '[]',    -- 可自动接受的字段白名单
  hold_point: "after_ai"|"after_precheck"|"auto" default 'after_ai',
  auto_publish bool default false,
  publish_mode: "now"|"scheduled"|"paced" default 'now',
  publish_at timestamptz null, pace_minutes int null,
  hold_on_warning bool default true,
  breaker jsonb  -- {enabled, maxFailPct, windowHours, scope:"workspace"}
  created_at, updated_at
  uq(workspace_id, store_id, name)

pipeline_runs
  id uuid pk, workspace_id, listing_id uuid fk unique, source_item_id fk,
  store_id fk, policy_id fk, policy_snapshot jsonb,     -- 策略快照，改 policy 不回溯在途 run
  stage: "claimed|ai_running|hold_ai|precheck|hold_precheck|queued|publishing|published|failed|cancelled",
  hold_reason text null, last_error text null,
  next_publish_at timestamptz null,                     -- paced 模式算出的发布时间
  created_at, updated_at
  idx(workspace_id, stage)

-- stores.rules 不动；source_items 加列 collected_via text default 'manual'（manual|plan|inquiry|auto）
```

### 2.2 链路编排（决策点：链式 + 状态机双层）

```
POST /collect（采集）
  → ingestOffer 成功后若命中 auto_claim policy → 建 listing + pipeline_runs(stage=claimed)
  → enqueue listing.workflowRun
workflowRun 完成
  → auto_accept_fields 命中 → 自动接受 → stage=hold_ai(默认停) / 否则推进
precheck（确定性：bannedWords + adapter.check()）
  → hold_on_warning && warn → stage=hold_precheck；block → failed
  → 通过 → auto_publish ? enqueue listing.publish(run_at=publish_at/pace 顺延) : stage=hold_precheck
publish job 成功 → stage=published；失败 → failed + 熔断器计数
```

- **jobs 链式为传输**：每步仍是独立 job（沿用 SKIP LOCKED + attempts + runAt），步骤间通过 `pipeline_runs.stage` 推进——任何一步崩溃后 `recoverStale` + 重投即可从 stage 恢复，不需要 job DAG 框架。
- **熔断**：publish 失败率超 `breaker.maxFailPct`（按 workspace、windowHours 窗口统计 publish_attempts）→ workspace 内 auto_publish 链路全部置 `hold_precheck` + audit_logs 记录 + 页面顶条提示。恢复需人工确认（防半死不活的授权一直烧发布额度）。
- **发布节奏**：`publish_at` 列在 listing 级（run 上快照），paced 模式由 publish job 取任务时按 `stores` 维度查 `max(published_at of last hour)`+pace_minutes 顺延 `runAt` 重排——调研 §2.2 的方案，不用延迟队列。
- **审核卡点**：`hold_ai`/`hold_precheck` 的推进 = `POST /listings/:id/pipeline/advance`（或批量 `POST /listings/pipeline/advance`），就地操作不跳页。

### 2.3 REST

```
GET/POST/PATCH/DELETE /api/pipeline-policies           CRUD
POST /api/pipeline-policies/:id/apply-to {storeId[]}   绑店
POST /api/source-items/:id/claim-publish {storeIds[]}  认领并发布快捷方式
GET  /api/pipeline-runs?stage=                          链路队列（任务页/铺货页徽标数据源）
POST /api/listings/:id/pipeline/advance | pause | cancel
POST /api/listings/pipeline/advance {ids[]}           批量推进
```

### 2.4 页面

- 铺货页左栏行操作：「认领」「认领并发布」并存；中栏 listing 顶部链路进度条（认领→AI→审核→门禁→排队→发布），卡点就地「推进/暂停」。
- 设置页「链路策略」tab + 店铺设置内联入口；listing_template 可选择包含一份 policy（payload 扩展 `pipelinePolicy` 可选字段，模板套用即复制 policy 行而非引用——店铺各自持有副本，改模板不影响已套用店铺）。
- 任务页新增「链路」过滤（pipeline_runs 与 jobs 分开展示：前者是业务链路，后者是执行队列）。

### 2.5 测试

- 状态机：全 hold_point 三档×publish_mode 三档组合路径；auto_accept 白名单越界字段不被接受。
- 熔断：构造失败率越界 → 链路暂停 + 审计；人工恢复。
- paced：同店两条 listing 的 publish job runAt 间隔 = pace_minutes。
- 幂等：重复触发 claim-publish 不产生重复 listing（沿用 listings_store_source_uq）。

---

## 3. 商品列表（监控规则引擎）— W2b

**立场**：按调研 §3.3 完整建——`source_changes` 事件流 + per-scope 监控规则 + 批量编辑 + 保存视图 + 标签，不含糊成"加几个筛选"。
**为什么值得建全**：`source_changes` 是 append-only 事件流，商品列表的黄色感叹号、断货天数、库存推送、自动改价、审计全都从它取数。最小切口做法（diff 完直接动作不落事件）会让"变化历史/断货 N 天/监控覆盖率"无从回答，之后每加一个监控语义都要重扫 source_items 补历史。

### 3.1 表

```sql
source_changes（货源变化事件流；唯一"供应商动了什么"的事实源）
  id uuid pk, workspace_id, source_item_id fk,
  change_type: "price"|"stock"|"title"|"images"|"attributes"|"delisted"|"republished",
  sku_id text null,            -- 变体级变化；null=商品级
  old_value jsonb, new_value jsonb,
  detected_at timestamptz,     -- 探测时间（rescan 执行时刻）
  applied_at timestamptz null, -- 被 monitor.apply 消费时间（幂等游标）
  applied_action jsonb         -- {listing_id, action:"repriced"|"pushed_stock"|"marked"|"delisted"}[]
  idx(workspace_id, source_item_id, detected_at), idx(applied_at) where null

monitor_rules（per-store / per-source_item 覆盖；默认值在 workspace 设置）
  id uuid pk, workspace_id,
  scope: "workspace"|"store"|"source_item", scope_id uuid null,
  enabled bool default false,               -- AutoDS 坑：默认关，存量要显式批量开启
  interval_hours int default 12,            -- 6~24
  min_stock int null,                       -- 低于阈值记 warn（不断货）
  max_dispatch_days int null,               -- 货源发货时效超阈值告警
  price_auto bool default false,            -- 价变自动重算（仍受 syncPolicy.price 约束）
  oos_action: "zero"|"unpublish"|"notify" default 'notify',
  created_at, updated_at
  uq(workspace_id, scope, scope_id)

labels + listing_labels（分组/标签；不揉进 listings.tags——那是发往平台的商品标签）
  labels: id, workspace_id, name, color, uq(workspace_id,name)
  listing_labels: (listing_id fk, label_id fk) pk

saved_views（AutoDS Match All/Any 的可保存筛选）
  id, workspace_id, page: "products"|"collect_box"|"orders",
  name, match: "all"|"any", filters jsonb, sort jsonb null, columns jsonb null,
  uq(workspace_id, page, name)
```

### 3.2 job 与链路

```
插件 4h alarm 已有 → POST /collect/rescan-queue 改造：
  返回项按 monitor_rules.interval_hours + lastScannedAt 过滤（source_items 加列 last_scanned_at）
  → 重采 ingestOffer 时 diff 写 source_changes（价格/库存/标题/图/属性/下架）
monitor.apply（调度 job，每 15min 扫 applied_at is null 的 source_changes）
  → 按变化类型 × monitor_rule × listing.syncPolicy 应用到关联 listing：
     price  → pricing stage 重算 → price_auto&&policy=auto ? 入 publish/patch price : drift 标记
     stock  → 命中 inventory_push_rules → enqueue inventory.push（见 §6-L1）
     title/images/attributes → 永远只标 drift（内容权在用户侧，managed-lifecycle 裁决）
     delisted → 高优告警 + oos_action=unpublish 时 enqueue listing.delist
  → 写 applied_at + applied_action + audit_logs(actor=system:monitor)
```

### 3.3 REST

```
GET  /api/source-changes?sourceItemId=&type=&unapplied=   事件流（关注 tab 数据源）
GET/POST/PATCH/DELETE /api/monitor-rules
POST /api/source-items/monitor/bulk-enable {ids[], rule}  存量显式开启（AutoDS 坑）
GET/POST/PATCH/DELETE /api/labels；POST /api/listings/:id/labels {labelIds[]}
GET/POST/PATCH/DELETE /api/saved-views?page=
POST /api/listings/bulk-edit {ids[], op:"price_set"|"price_adjust_pct"|"price_adjust_abs"|"tags"|"syncPolicy"|"trackStock"|"republish"|"rerun_ai", ...}
```

### 3.4 页面

- 商品页三 tab：草稿 / 在线 / **关注**（drift ∪ 未消费 source_changes ∪ remote_deleted）。行内：标题双行（本地 vs 远端 drift 黄标）、售价/货源价（有变高亮）、断货天数（从最早未消费 delisted/stock=0 事件算）、远端状态、健康就地展开。
- 批量工具条 + 保存视图选择器；抽屉编辑（不跳页）+ 编辑历史（diff vs remoteSnapshot + suggestion 决策记录）。
- 关注 tab 每条 source_change 可「应用/忽略」（人工消费未 auto 的事件）。

### 3.5 测试

- diff 检测：六种 change_type 的 old/new 落库，重复扫描不产生重复事件（指纹去重）。
- monitor.apply：策略矩阵（syncPolicy×rule.enabled×change_type）；delisted→unpublish 链路；applied_at 幂等。
- bulk-edit 各 op 的边界（price_adjust_pct 对多变体）；labels/saved_views 跨 workspace 隔离。

---

## 4. 订单管理 — W3

**立场**：订单域全套 7 表 + `ProcurementDriver` 抽象，一次建到位。
**为什么值得建全**：订单是状态机最密的域——`order_items` 的 SKU 配对、`purchase_orders` 的拆单/合并、`shipments` 的多段回传、`order_events` 的审计，每一项都是履约链路的真实结构（妙手/店小秘/CJ 都长成这样）。把它们压扁进一两个 jsonb 字段，拆单、部分发货、采购失败重下第一天就返工。

### 4.1 表（字段级）

```sql
orders
  id uuid pk, workspace_id, store_id fk,
  remote_id text not null,                 -- Shopify order gid
  order_number text, name text,            -- #1001
  financial_status text, fulfillment_status text,
  order_status text,                       -- 派生主状态：new|awaiting_procure|procuring|
                                           --   awaiting_ship|shipped|done|cancelled|refunding|exception
  customer jsonb,                          -- {name,email,phone} —— 加密存储(见下)
  shipping_address_enc text,               -- AES-GCM 密文，同 stores.credentials 机制；展示脱敏
  currency text, subtotal numeric, total numeric, items_count int,
  placed_at timestamptz, synced_at timestamptz, raw jsonb,  -- 原报文留档
  created_at, updated_at
  uq(store_id, remote_id), idx(workspace_id, order_status), idx(workspace_id, placed_at)

order_items
  id uuid pk, workspace_id, order_id fk,
  remote_line_item_id text, title text, sku text, qty int, unit_price numeric,
  listing_id uuid null fk, variant_sku text null,
  source_item_id uuid null fk, source_sku_id text null,     -- 认领时建立的确定性映射
  mapping: "matched|unmatched|partial" default 'unmatched',
  procure_status: "none|queued|placed|shipped|done|failed" default 'none',
  created_at, updated_at
  uq(order_id, remote_line_item_id), idx(workspace_id, mapping), idx(order_id)

purchase_orders
  id uuid pk, workspace_id,
  kind: "source_order|forwarder|manual",   -- manual=线下自采录单
  source_platform text null, source_seller text null, supplier_id uuid null fk,
  status: "draft|placed|paid|domestically_shipped|forwarder_received|intl_shipped|done|exception",
  source_order_id text null,               -- 1688 订单号
  domestic_tracking jsonb default '[]',    -- [{carrier,no,status}]
  forwarder_id uuid null fk->freight_forwarders,
  intl_tracking jsonb default '[]',
  cost_total_cny numeric, note text,
  created_at, updated_at
  idx(workspace_id, status), idx(source_platform, source_order_id)

purchase_order_items
  id uuid pk, po_id fk, order_item_id fk, qty int, unit_price_cny numeric,
  uq(po_id, order_item_id)                  -- 一个 order_item 可拆进多 PO（部分缺货）

shipments
  id uuid pk, workspace_id, order_id fk, po_id uuid null fk,
  carrier text, tracking_no text, tracking_url text,
  remote_fulfillment_id text null,          -- Shopify fulfillment gid
  status: "pending|pushed|accepted|in_transit|delivered|failed",
  payload jsonb,                            -- fulfillmentCreate 请求/响应留档
  created_at, updated_at
  idx(order_id), idx(workspace_id, status)

order_events（审计/debug，只增不改）
  id uuid pk, workspace_id, order_id fk,
  type text,                                -- synced|mapped|procure_queued|po_placed|fulfill_pushed|exception…
  payload jsonb, actor text, created_at
  idx(order_id, created_at)

freight_forwarders（仓储 L2 共用，见 §6）
  id uuid pk, workspace_id, name text,
  system_type: "manual|huoxiaoyi|api",      -- manual=仅地址簿+手动回传
  addresses jsonb,                          -- 收件地址簿[{label,country,province,city,addr,zip,phone}]
  credentials_enc text null,                -- 授权凭据密文
  status: "active|disabled", note text,
  created_at, updated_at
  uq(workspace_id, name)
```

**为什么值得建全**：`purchase_order_items` 是多对多纽带——一单拆多供应商采购、一个供应商 PO 合并多单，没有它「采购」页按供应商分组和批量下单导出不成立。`order_events` 只增不改：履约跨度以天计，客服式追问「这单什么时候下的采购」是常态。

### 4.2 ProcurementDriver 抽象

```ts
// apps/server/src/procurement/driver.ts
interface ProcurementDriver {
  kind: "extension_assisted"|"forwarder_api"|"official_trade"|"manual";
  // 把 po draft 变成"已下单"或返回待人工步骤
  submit(deps, po): Promise<{poPatch; nextPollAt?; instructions?}>;
  poll(deps, po): Promise<{status; tracking?} | null>;   // 状态回传
}
```

- `extension_assisted`（近期主力）：`procure.submit` job 产出"下单任务"→ 插件面板显示待下单队列 → 插件打开 1688 下单页自动填 SKU/数量/地址 → 用户确认支付 → 插件回传 1688 订单号。
- `forwarder_api`：订单直推货代系统（收货地址=货代仓地址），`procure.poll` 拉处理进度。
- `official_trade`：1688 开放平台铺货分销方案包——接口位预留，ISV 资质申请完再接。
- `manual`：手工录入快递单号/采购信息。

### 4.3 订单同步（决策点：webhook 主 + 轮询兜底）

- **webhook**：店铺 connect/授权更新时 adapter 调 `webhookSubscriptionCreate` 注册 `orders/create`、`orders/updated`、`orders/cancelled`、`refunds/create` → 指向现有 `/api/shopify/webhooks`（HMAC 校验已建），按 `x-shopify-topic` 分发到 `order.sync` job（payload 即报文，upsert orders + order_items + order_events，幂等键 `(store_id, remote_id)`+`updated_at` 新鲜度）。
- **轮询兜底**：`order.sync` 每 15min 对每店跑 `orders(query: updated_at>cursor)` 增量——webhook 丢单/注册失败/本地处理失败都靠它自愈；store 上存 `ordersCursor`。
- **履约回传**：`fulfill.push` job → adapter `pushFulfillment(order, tracking)`：查 fulfillmentOrders → `fulfillmentCreate(trackingInfo)`；**不用 legacy Fulfillment API**（已废）。部分发货对应多 fulfillmentOrder，逐条建 shipments。

### 4.4 jobs

`order.sync`（webhook 入口+轮询兜底，幂等 upsert）、`order.map`（SKU→listing→source_sku 解析，未匹配入配对队列）、`procure.submit`、`procure.poll`（货代/1688 进度）、`fulfill.push`、（`inventory.push` 归仓储 L1）。失败重试沿用 maxAttempts；`order.map` 对 unmatched 永久不失败——留在配对队列等人绑。

### 4.5 REST

```
GET /api/orders?tab=all|review|pending|shipping|shipped|exception|aftersale
GET /api/orders/:id                        行内展开：items+映射标+地址+PO链+利润估算
POST /api/orders/:id/review                审核通过→待采购
POST /api/order-items/:id/map {sourceItemId,sourceSkuId}   配对队列操作
POST /api/order-items/procure {ids[], driver, forwarderId?}  生成 PO + procure.submit
POST /api/orders/:id/fulfill {trackingNo,carrier,poId?}      手动发货回传
GET /api/orders/:id/events
GET/POST/PATCH/DELETE /api/purchase-orders?status=&supplier=  采购页
GET/POST/PATCH/DELETE /api/freight-forwarders
POST /api/orders/sync-now {storeId}        手动补拉
```

### 4.6 页面

- 一级导航加「订单」「采购」（五导航变七）。订单页妙手式状态 tab（清爽版），行内展开：商品行（mapping 状态标）、收货地址（脱敏+一键复制到货代格式）、采购状态链（1688 单号→国内段→货代→国际段）、利润估算（售价-采购-运费）。
- 采购页：purchase_orders 按供应商分组、批量下单导出（CSV）、货代进度手动回传录入。
- 插件面板加「待下单」队列卡（extension_assisted driver 的前端）。

### 4.7 测试

- webhook：伪造 HMAC 拒绝、三 topic upsert 幂等、乱序（updated 先于 create）靠 raw+updated_at 归并。
- 映射：matched/partial/unmatched 三分支；order.map 不产生失败态。
- PO：一单拆两供应商、一 PO 合并多单、purchase_order_items 数量校验。
- fulfill.push：fakeShopify 侧 fulfillmentOrders→fulfillmentCreate 全链路；多 fulfillmentOrder 部分发货。
- 地址加密：库中无明文，列表接口脱敏，复制接口走单独授权字段。

---

## 5. AI 选品 — W4

**立场**：`selection_plans`/`discovery_items`/`suppliers` 三表 + 评分器完整结构；诚实评分（不伪造销量预测）。
**为什么值得建全**：`discovery_items` 独立候选池是调研明说的理由（每天每计划上百条、命中率<10%，进采集箱会稀释它）。`suppliers` 主档是评分器复购率/诚信通/代发信号的落点，也是采购页「按供应商分组」和询货的数据底座——选品域不建它，订单域也要建。

### 5.1 表

```sql
selection_plans
  id uuid pk, workspace_id, name text,
  source: "1688_rank|1688_hot|keyword|image_reverse",
  filters jsonb,   -- {category, priceBandCny, country?, keywords[],
                   --  minRepurchase?, requireDaiFa, require48h, minChengxinYears}
  schedule text default 'daily', cron text,
  status: "active|paused", last_run_at, created_at, updated_at
  uq(workspace_id, name)

discovery_items（候选池，不进采集箱）
  id uuid pk, workspace_id, plan_id uuid null fk,      -- null=反向选品/手动找品
  source_platform text, source_item_id text, source_url text,
  title text, price_text text, thumb text,
  signals jsonb,   -- {repurchaseRate, sellerYears, daiFa, shipTime48h,
                   --  trendScore, sourceRank, estMargin, density}
  score real, score_detail jsonb,                      -- AI 重排理由+分项分
  supplier_id uuid null fk,
  status: "new|collected|dismissed|expired" default 'new',
  collected_source_item_id uuid null fk->source_items,
  created_at, updated_at
  uq(workspace_id, source_platform, source_item_id, plan_id)

suppliers（1688 供应商主档；采集/选品/采购三处沉淀）
  id uuid pk, workspace_id, source_platform, seller_id text,
  name, chengxin_years int, repurchase_rate real, daifa bool,
  ship_48h bool, extra jsonb, last_seen_at
  uq(workspace_id, source_platform, seller_id)
```

### 5.2 job 与评分器

```
selection.run（每日 per plan cron）
  → 插件侧：向已登录用户浏览器派「榜单/搜索采集」任务（页面在插件上下文打开，
    结构化提取卡片：图/价/服务保障标签/店铺字段/名次）——服务端裸抓 1688 会风控（已验证约束）
  → upsert discovery_items + suppliers
selection.score（批量评分 job）
  → 硬过滤（daiFa/48h/价带）→ 信号加权（复购率>诚信通>毛利试算>榜单名次>同款密度负权）
  → LLM 重排（标题+属性+类目→目标市场契合度/侵权词风险）→ score + scoreDetail
用户勾选 → 走既有采集链路（详情页插件采集/服务端兜底）→ status=collected +
  collected_source_item_id + source_items.collected_via='plan'
```

- **数据源决策（决策点）**：插件采集为主（跨境热卖五种选品方式的页面数据公开可见），1688 官方 ISV API 并行申请——接入后 `selection_plans.source` 加枚举值即可，表结构与评分器不动。
- **反向选品**：`plan_id=null` 的 discovery_items，`source=image_reverse`；以图搜款结果共用评分器。询货链路（research-sourcing-inquiry.md）产出也落这里，`collected_via='inquiry'`。
- **AI 询盘**：只做「待发送队列+人工确认+频率上限」；**自动发盘不建**（调研合规边界）。

### 5.3 REST

```
GET/POST/PATCH/DELETE /api/selection-plans；POST /api/selection-plans/:id/run-now
GET /api/discovery-items?planId=&status=&minScore=
POST /api/discovery-items/collect {ids[]}     → 入采集链路
POST /api/discovery-items/dismiss {ids[]}
GET /api/suppliers?platform=                  供采购页/选品详情复用
```

### 5.4 页面

一级导航「选品」：计划列表（含 3 个预设计划模板）→ 计划详情候选卡片墙（图/价/信号徽章/评分/AI理由 → 勾选采集/忽略/同款找商）。冷门期空状态推预设计划。

### 5.5 测试

- 评分器：硬过滤边界、权重矩阵、LLM 重排 fake、scoreDetail 可解释性字段齐全。
- upsert 幂等（同计划同 item 重复跑更新不插重）；collect/dismiss 状态机；suppliers upsert by seller_id。

---

## 6. 仓储 — 分层（L1 建 / L2 随订单 / L3、L4 缓建）

**立场**：L1 现在建（订单之前就存在的需求），L2 与订单同波（freight_forwarders 已在 §4.1），L3/L4 遵守调研缓建标记——表结构在本文存档，触发条件到了再立项。
**为什么值得建全**：`inventory_push_rules` 独立建表而非塞 stores.rules——它的 scope 是三态（listing|source_item|store），且要挂触发日志；塞 rules 就退化成"每店一种策略"，店小秘「SKU→多店铺推送规则」的多对多表达不出来。

### 6.1 L1（W2b，与商品列表同波）

```sql
inventory_push_rules
  id uuid pk, workspace_id,
  scope: "listing|source_item|store", scope_id uuid null,
  strategy: "mirror|fixed|percent|cap",    -- mirror=源库存直通
  fixed_n int null, percent real null, cap_n int null,
  buffer int default 2,                    -- 安全库存扣减
  oos_action: "zero|unpublish|notify" default 'notify',
  enabled bool default false, created_at, updated_at
  uq(workspace_id, scope, scope_id)
```

**触发时机（决策点）**：事件驱动——`source_changes(stock)` 被 `monitor.apply` 消费时评估命中规则 → enqueue `inventory.push`（payload：listingId+ruleId+目标库存数）。每日 `inventory.reconcile` job 兜底（对启用 trackStock 的 listing 全量核一遍，防事件流漏消费）。手动 `POST /listings/:id/inventory-push` 立即推。Shopify 侧沿用 `inventorySetQuantities`（trackStock 机制扩展），UI 明示"非实时（重采间隔）"语义。

### 6.2 L2（W3，随订单）

`freight_forwarders`（§4.1 已列）：地址簿 + system_type + 凭据密文；订单收货地址选「货代仓」；PO `kind=forwarder` 时货代进度回传写 PO 状态机。API 直连看接入成本，先「地址簿+手动回传」。

### 6.3 L3（缓建——存档结构，不建）

```sql
product_skus: workspace_id, sku, title, barcode, dims/weight, default_source_item_id
warehouses: type "self|third_party|platform", address
stock_levels: (warehouse_id, sku_id) pk, on_hand, locked, in_transit
stock_movements: in|out|adjust|lock, ref_type, ref_id, qty  -- 只增台账
```

启动条件（调研 §8.5）：周活用户里出现稳定用「采购单」补货的群体再启动。届时 PO `kind=self_stock` 接入库流程，订单走「调用库存」分支。**不提前建**：铺货期 listing↔source 已够，提前建主档=双写灾难（managed-lifecycle 不新增 listing_drafts 同理）。

### 6.4 测试

- 四种 strategy 计算（mirror/fixed/percent/cap×buffer）；oos_action 三分支；reconcile 幂等；scope 优先级（listing>source_item>store>workspace 默认）。

---

## 7. 汇总清单

**新表（按波次）**

| 波 | 表 |
|---|---|
| W1 | listing_workflows、listing_workflow_runs（listing_suggestions+stage/run_id；stores+workflow_id） |
| W2a | pipeline_policies、pipeline_runs（source_items+collected_via） |
| W2b | source_changes、monitor_rules、labels、listing_labels、saved_views、inventory_push_rules |
| W3 | orders、order_items、purchase_orders、purchase_order_items、shipments、order_events、freight_forwarders |
| W4 | selection_plans、discovery_items、suppliers |
| 缓建 | product_skus、warehouses、stock_levels、stock_movements |

**新 job 类型**：`listing.workflowRun`（替代 aiEnhance 编排位）、`monitor.apply`、`inventory.push`、`inventory.reconcile`、`order.sync`、`order.map`、`procure.submit`、`procure.poll`、`fulfill.push`、`selection.run`、`selection.score`。

**页面演进**：五导航 → 铺货｜选品｜商品（草稿/在线/关注）｜订单｜采购｜店铺｜任务｜设置；原则不变（按流程组织、不跳页、任务就地可见）。

**抽象**：`ProcurementDriver` 与 `ChannelAdapter` 并列；`fulfill.push` 走 adapter 新增 `pushFulfillment(order, tracking)`；SKU 解析链 `orderItem.sku → listing.variant.sku → sourceItem.sku` 在认领时落成确定性映射。

---

## 8. 关键决策点（显式作答）

1. **订单同步 webhook vs 轮询**：webhook 为主（`webhookSubscriptionCreate` 在店铺连接/授权刷新时注册 4 个 topic 到现有 HMAC 端点），`order.sync` 15min 增量轮询兜底自愈。理由：webhook 实时性好但会丢（注册失败/签收故障），轮询慢但可靠——成熟 ERP 都是双路。
2. **链路编排**：链式 jobs（传输与重试）+ `pipeline_runs` 状态机（编排与可视化）。不上独立 DAG 框架——现有 jobs 队列的 SKIP LOCKED/attempts/runAt 已够，缺的是链路级状态记录，补表不补框架。
3. **stage 管线兼容**：`listing_suggestions` 加 `stage`+`run_id`，仍是唯一审核面；`aiEnhance` 对外接口不变，内部改派生 workflow run；接受→term_mappings 学习链路原样继承。
4. **discovery_items 数据源**：插件侧浏览器内采集（跨境热卖/榜单/搜索页），服务端不裸抓；官方 ISV API 并行申请，作为第二 source 复用同表。
5. **inventory_push_rules 触发**：`source_changes(stock)` 事件驱动 → `monitor.apply` → `inventory.push`；每日 `inventory.reconcile` 兜底 + 手动立即推送。

## 9. 最小切口派会欠账返工的 3 个点

1. **不落 `source_changes` 事件流**：diff 完直接执行动作/只标 drift——「断货天数」「货源变化历史」「监控覆盖率」「库存推送依据」全部无从取数，之后每加一个监控语义都要重扫 source_items 补历史，且漂移标记与审计两条线永久割裂。
2. **PipelinePolicy 塞 stores.rules**：policy 是要编辑/审计/模板化的产品对象，塞 rules 会让 `StoreSettingsPayload` 类型混进非设置字段；`listing_templates` 套用变成「改引用还是拷贝」的语义泥潭；同一店多策略（不同类目走不同卡点）表达不了，迟早拆表+迁移存量 JSON。
3. **订单域压扁 PO 层**：把采购状态塞进 `order_items` 而不建 `purchase_orders`/`purchase_order_items`——一单拆多供应商、一供应商合并多单、采购失败重下、货代/国际段双段跟踪，这四个真实场景全都表达不了，等第一个「部分缺货拆单」需求就要重建表+迁移在线订单。

## 10. 与缓建标记的对齐确认

| 调研标记 | 本文处理 |
|---|---|
| 仓储 L3 自营仓（Phase 5+） | 结构存档 §6.3，触发条件到达前不建 |
| 仓储 L4 平台托管备货 | 不建；挂 `warehouses(type:platform)` 抽象位说明 |
| AI 询盘自动发盘 | 不建；只做待发送队列+人工确认+频率上限 |
| 1688 官方 trade API | 不建实现；`ProcurementDriver` 留 `official_trade` 接口位 |
| 平台代付（AutoDS FBA 型） | 不做（调研明判） |
