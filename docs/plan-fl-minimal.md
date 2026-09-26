# 全链路实施计划 —— 最小切口版（plan-fl-minimal）

> 2026-09-26。输入规格：`docs/research-full-link-architecture.md`（六大域调研）。立场：**最小切口派**——能用现有原语就不新建，能合表就合表，调研文档自己标记缓建的一律 defer（L3/L4 仓储、自动询盘、L5 履约网络、以图搜款反向选品、第二渠道）。
> 每个结构性决策附一句「为什么这是最省的」。

---

## 0. 决策摘要

| # | 决策点 | 本方案 | 为什么这是最省的 |
|---|--------|--------|------------------|
| 1 | 订单同步 | **webhook 为主 + 每店增量轮询兜底**：自有应用（oauth/client_credentials）在 `shopify.app.toml` 声明 topics；webhook 与轮询落同一个 `order.sync` job | 复用现有 `/api/shopify/webhooks` 验签端点与 `shopifyGraphql`；轮询同时覆盖「手动 token 店无法验签 webhook」的盲区，不用单独建对账层 |
| 2 | 链路编排 | **jobs 链式**：每个 handler 末尾 enqueue 下一步，不建 pipeline runner | jobs 表已有 runAt/重试/SKIP LOCKED/去重助手；runner 是第二套调度器，纯重复建设 |
| 3 | stage 管线 | **stage = 代码注册表**（非表），配置落在 `stores.rules.pipeline.disabledStages`；产物仍是 `listing_suggestions` 行（加 `stage` 列做按 stage 幂等） | 零新表；suggestions 的 pending→accepted/rejected、逐条 diff、接受反哺词表/类目映射的机制一行不改 |
| 4 | discovery_items 数据 | **插件回流**：插件 SW 在用户 1688 会话里拉搜索/榜单页 → POST `/api/discovery/feed`；另提供「浏览即回流」被动通道（list.ts 卡片扫描顺手上报） | 服务端裸抓 1688 列表页 = 已验证风控；插件链路（rescan-queue 模式）现成，零新增抓取面 |
| 5 | 库存推送规则 | **不建 `inventory_push_rules` 表**：策略写进 `stores.rules.inventory`（店级）+ `listings.syncPolicy.stock`（刊登级覆盖，已存在）；**触发时机 = `source_items` 重采事件**（propagateToListings 内判定），不做独立调度器 | 货源库存的「真相刷新」本来只发生在重采时；事件驱动推送与重采天然同频，再做一个调度只会重复触发同一批计算 |

派生结论：新增表 **8 张**（调研列出 12 张候选里砍掉 order_events→audit_logs、listing_workflows→stores.rules、inventory_push_rules→stores.rules、suppliers→并入文本字段/缓建、L3 四表→defer）；新增 job 类型 **7 个**（调研 9 个里 selection.run→改拉取式、monitor.apply→并入 propagate、procure.submit→插件协助无后台 job、inventory.push→复用 pushStock）。

---

## 1. 现有原语盘点（本方案的复用清单）

| 已有原语 | 位置 | 在六大域里复用为 |
|---|---|---|
| jobs 队列（SKIP LOCKED + runAt + 退避 + 去重助手 `enqueueXxx`） | `src/jobs/` | 所有链路编排、订单同步、履约回传、选品打分 |
| `ingestOffer` + `propagateToListings`（重采→同步 SKU 库存/成本→按需推库存） | `modules/collect.ts` | 货源监控、库存推送的唯一触发点 |
| claim 认领（预处理 rules + 定价 + 术语预翻 + 类目/属性映射套用 + 排队 AI） | `modules/sourceItems.ts` | 一键上品的「自动认领」步骤直接复用 |
| `listing_suggestions` + decide（接受写本体 + 学 term/category/attr 映射） | `modules/listings.ts` `ai/enhance.ts` | stage 管线的唯一产物载体 |
| `publish_runs`/`publish_attempts`（批次 + 快照 + 重试留档） | `modules/publish.ts` | 定时/节奏发布、链路熔断统计的数据源 |
| `audit_logs`（entityType/entityId 已索引） | `lib/audit.ts` | 货源变化事件流、订单事件流、自动动作留痕——不再建平行事件表 |
| `ChannelAdapter`（verify/validate/publish/fetchRemoteSnapshots/pushStock/delistProduct…） | `channels/types.ts` | 新增 `pushPrices`/`pushFulfillment`/`fetchOrders`/`registerOrderWebhooks` 四个可选能力即可收口平台差异 |
| `stores.rules` jsonb + `listing_templates`（模板即店铺设置快照） | schema + `stores.ts` | PipelinePolicy、库存推送规则的承载体；模板自动覆盖新字段，零迁移 |
| `SecretBox`（AES-GCM 凭据加密） | `lib/crypto.ts` | 订单收件地址加密 |
| `/api/shopify/webhooks`（HMAC 验签 + topic 分发骨架） | `channels/shopify/oauth.ts` | 订单 webhook 落点 |
| 插件：`list.ts` 卡片扫描、`collectByOfferId`（SW 内 1688 会话 fetch）、4h alarm rescan、site-bridge | `apps/extension/` | discovery 回流、货源回扫、采购助手——全部复用同一通道 |
| `shopify.app.toml` `[webhooks]`（已预留 TODO） | `shopify-app/` | 订单 topics 声明式注册 |

---

## 2. Schema 变更（字段级）

### 2.1 新增列（共 6 列，全部向后兼容、无数据回填义务）

| 表 | 列 | 类型 | 用途 |
|---|---|---|---|
| `listings` | `publish_at` | timestamptz null | 单条定时发布时间（publishMode=scheduled 的 per-listing 覆盖） |
| `listings` | `remote_variant_map` | jsonb null（`{[variantSku]: {variantId, inventoryItemId}}`） | 订单 SKU 映射的第二优先键；发布成功后由 productSet 返回值回填 |
| `listings` | `source_changed_at` | timestamptz null | 「货源变了」徽标数据源（替代 source_changes 表的列表侧读面） |
| `listing_suggestions` | `stage` | text not null default `'ai'` | 建议来源 stage；按 (listing,field,stage) 幂等重跑 |
| `source_items` | `collected_via` | text null（`manual|plan|inquiry`） | 选品→采集箱归因 |
| `source_items` | `availability` | text not null default `'ok'`（`ok|delisted|unknown`） | 货源下架告警 + 可选自动下架 |

为什么最省：全部是加列，不动既有行语义；`stores.rules` 是 jsonb，新增 `pipeline`/`inventory` 两组键**连 DDL 都不需要**，且 `listing_templates.payload = StoreSettingsPayload` 天然把策略带进模板。

### 2.2 `stores.rules` 新增键（零 DDL）

```ts
interface StoreRules {  // 追加字段
  pipeline?: {
    autoClaim: boolean;              // 采集入箱即认领到此店
    autoAcceptFields: SuggestionField[];  // 白名单字段自动接受（默认 []）
    holdPoint: "after_ai" | "after_precheck" | "auto"; // 审核卡点，默认 after_ai
    autoPublish: boolean;            // 过门禁即发布
    publishMode: "now" | "scheduled" | "paced";
    publishAt?: string;              // scheduled 默认值（listing.publish_at 可覆盖）
    paceMinutes?: number;            // paced：同店相邻发布最小间隔
    holdOnWarning: boolean;          // validate 出 warn 级也按住
    disabledStages?: string[];       // stage 管线开关（§3.5）
  };
  inventory?: {                      // = 调研的 inventory_push_rules 合表版
    strategy: "mirror" | "fixed" | "percent" | "cap";
    fixedQty?: number; percent?: number; cap?: number; buffer?: number;
    oosAction: "zero" | "unpublish" | "notify";
  };
}
```

为什么最省：策略本质上是「店铺刊登设置」的延伸，`listing_templates` 已经是它的快照载体——独立建表只会让模板机制多管一张表。

### 2.3 新表（8 张）

```sql
-- === 订单域（6 张）===
orders:            id, workspace_id→w, store_id→stores,
                   remote_id text not null,            -- Shopify order gid
                   name text,                          -- #1001
                   financial_status text, fulfillment_status text,
                   status text not null default 'new', -- new|to_procure|procuring|to_ship|shipped|done|cancelled|exception
                   customer jsonb,                      -- {name,email,phone}（展示脱敏）
                   shipping_address_enc text,           -- SecretBox 密文（合规：明文不落库）
                   currency text, subtotal real, total real, items_count int,
                   placed_at timestamptz, synced_at timestamptz,
                   raw jsonb                            -- 原报文留档（debug/重放）
                   unique(store_id, remote_id); index(workspace_id, status)
order_items:       id, order_id→orders, remote_line_item_id text,
                   remote_variant_id text,              -- 映射键①
                   title text, sku text, qty int, unit_price real,
                   listing_id→listings null, source_item_id→source_items null,
                   source_sku_id text,                  -- 1688 specId（映射键②，经 variant.sourceSkuId）
                   mapping text default 'unmatched',    -- matched|partial|unmatched
                   procure_status text default 'none'   -- none|queued|placed|shipped|done|failed
                   unique(order_id, remote_line_item_id)
purchase_orders:   id, workspace_id, kind text default 'manual',  -- manual|source_order|forwarder(预留)
                   source_platform text default '1688', source_seller text,
                   status text default 'draft',         -- draft|placed|paid|domestic_shipped|intl_shipped|done|exception
                   source_order_id text,                -- 1688 订单号（手工/插件回填）
                   domestic_tracking jsonb default '[]', intl_tracking jsonb default '[]', -- [{carrier,no,url}]
                   forwarder_id→freight_forwarders null, cost_total_cny real, note text,
                   created_by→users, created_at, updated_at
purchase_order_items: purchase_order_id→pos, order_item_id→order_items, qty int, unit_price_cny real
                   pk(purchase_order_id, order_item_id)
shipments:         id, order_id→orders, purchase_order_id→pos null,
                   carrier text, tracking_no text, tracking_url text,
                   remote_fulfillment_id text,           -- Shopify fulfillment gid
                   status text default 'pending',        -- pending|pushed|failed
                   last_error text, created_at, updated_at
freight_forwarders: id, workspace_id, name text,
                   address jsonb,    -- {recipient,phone,country,province,city,detail,postcode}
                   note text, created_at, updated_at     -- 地址簿 only，无 API 字段

-- === 选品域（2 张）===
selection_plans:   id, workspace_id, name text,
                   source text,       -- 'keyword' | '1688_rank'（'image_reverse' 枚举预留，不实现）
                   filters jsonb,     -- {keywords[],category,priceMinCny,priceMaxCny,requireDaiFa,require48h,minRepurchase}
                   schedule text default 'manual',      -- manual|daily
                   enabled boolean default true, last_run_at timestamptz, created_at, updated_at
discovery_items:   id, workspace_id, plan_id→selection_plans null,
                   source_platform text default '1688', source_item_id text,  -- offerId
                   title text, price_text text, thumb text,
                   signals jsonb,     -- {daiFa,ship48h,repurchaseRate,sellerYears,rank,sourceRank,sameStyleCount}
                   score real, ai_note text,
                   status text default 'new',           -- new|collected|dismissed|expired
                   source_item_db_id→source_items null, -- 采集后回填
                   created_at, updated_at
                   unique(workspace_id, plan_id, source_item_id)
```

### 2.4 复用替代（决定不建的表）

| 调研表 | 替代 | 为什么这是最省的 |
|---|---|---|
| `order_events` | `audit_logs`（entityType='order'/'purchase_order'） | 审计表 actor/action/payload/索引全齐，事件流就是审计流 |
| `listing_workflows` | `stores.rules.pipeline.disabledStages` + `listing_templates` | 工作流差异=哪些 stage 开/关+参数；命名/复用已由模板承担 |
| `inventory_push_rules` | `stores.rules.inventory` + `listings.syncPolicy.stock` | scope=store 已由 rules 覆盖；listing 级覆盖已有 syncPolicy；source_item 级规则留作 deferred（多店不同策略时再拆表） |
| `source_changes` | `audit_logs` 事件流 + `listings.source_changed_at` 徽标列 | 变化事件本就要求落审计；列表页要的是「有变化」标志不是全历史 |
| `suppliers` | `source_items.seller_name` / `purchase_orders.source_seller` 文本 | 供应商主档的增量价值在去重统计，v1 用文本够 |
| `product_skus`/`warehouses`/`stock_levels`/`stock_movements` | defer（L3） | 调研自己定的触发条件未到；提前建 = 双写灾难（managed-lifecycle 已裁决同型问题） |

---

## 3. 逐域实施规格

### 3.1 一键上品（切片 A，零新表）

```
collect ─► claim ─► listing.aiEnhance ─► pipeline.advance ─► listing.publish
              ▲(stores.rules.pipeline.autoClaim)     │  └ runAt = paced/scheduled
              └ POST /collect 内联：命中 autoClaim 店 → enqueue listing.claim
```

- 新 job `listing.claim {sourceItemId, storeId}`：复用 `claim` 端点抽出的 `claimItems(db,ws,itemIds,storeIds)` 共享函数（端点内部逻辑平移，不改语义）。
- 新 job `pipeline.advance {listingId}`：aiEnhance/categorySuggest handler 末尾 enqueue。内部：① 按 `autoAcceptFields` 白名单调现有 decide 同款的 `applySuggestion`+学习钩子；② `holdPoint=after_ai` 停；③ 跑 `adapter.validate`+`findBannedWords`（与发布门禁同一实现）；④ `holdOnWarning && warn` → `lastError` 标注+audit 停；⑤ `autoPublish` → enqueue `listing.publish`，`runAt` = `max(now, publish_at|publishAt, 该店最新 publishedAt+paceMinutes)`。
- 熔断：advance 里查当日 `publish_attempts` 失败率（workspace 级，>5 单且 >50% 失败 → 不再排发布，audit `pipeline.breaker`）。**防的是 AI 幻觉批量上架，比新链路本身更该先做。**
- 「认领并发布」= claim 端点加 `advance?: boolean`，认领后直接 enqueue advance。
- 链路进度徽标：`status + pendingSuggestions + 排队中的 publish job` 派生，列表接口多带一个聚合计数，不落新字段。

### 3.2 订单管理（切片 B）

**同步（webhook + 轮询，同一 job 收口）**：
- `shopify.app.toml` `[webhooks]` 声明 `orders/create|updated|cancelled` → `{APP_URL}/api/shopify/webhooks`（自有应用生效）。webhook 端点收到订单 topic → 不处理报文，直接 `enqueue(order.sync, {storeId, remoteId})`——payload 不留库，worker 内走 Admin API 拉最新单（payload 过期/截断都免疫）。
- 手动 `access_token` 店：连接时尝试 `adapter.registerOrderWebhooks`（`webhookSubscriptionCreate` GraphQL）；其 HMAC 用的是**该店自建应用的 secret**，我们没有 → 验签不可行，**此类店铺只走轮询**。所有店每晚 + webhook 静默期兜底轮询 `orders(query:"updated_at:>…")`。
- scopes 追加：`read_orders`、`write_merchant_managed_fulfillment_orders`（fulfillmentCreate 所需）。
- `order.sync` handler：`order(id:)`/`orders(updated_at_min)` → upsert orders + order_items → enqueue `order.map`。
- `order.map`：行匹配顺序 ① `remote_variant_id ∈ listing.remoteVariantMap` ② `sku == variant.sku` ③ `unmatched`（人工绑定入口：`POST /orders/:id/items/:iid/bind {sourceItemId, sourceSkuId}`）。listing 删除后映射保留 sourceItemId 快照。
- `status` 派生函数（纯函数，item.procure_status + shipments + financial_status → 主状态），任何子实体变更后重算写回——tab 计数走 SQL，不靠计算列。

**采购（手动 + 插件辅助，不做自动下单）**：
- 订单详情「去采购」→ `POST /orders/:id/procure` 返回 `{offerId, specText, qty, address}` 并经 site-bridge `PROCURE_1688` → 插件开 `detail.1688.com/offer/{id}.html` + 在 detail 页浮层显示采购卡（规格/数量/地址一键复制）+「标记已下单」回填 `source_order_id`。表单自动填充不做（下单表单结构不稳 + 风控面大）。
- `purchase_orders` 手工建（勾选 order_items 生成）+ 状态手动推进（placed→paid→国内段→国际段→done），轨迹号手动录入或货代回填。

**履约回传**：shipment 录入国际运单 → `fulfill.push` job → `adapter.pushFulfillment(remoteOrderId, tracking)`：查 `order.fulfillmentOrders` → `fulfillmentCreate{lineItemsByFulfillmentOrder, trackingInfo{number,company,url}, notifyCustomer}` → 写回 `remote_fulfillment_id` + status=pushed。部分发货按 fulfillmentOrder 行项粒度提交。

**货代（L2 地址簿）**：`freight_forwarders` CRUD；采购助手里收货地址可切「货代仓」。API 直连全部 defer。

### 3.3 商品列表 / 货源监控（切片 C）

- 变化检测并入 `propagateToListings`：diff 出 price/stock/title/下架 → `audit_logs(action='source.change', entityType='source_item')` + 关联 listing 打 `source_changed_at`；stock 走现有 pushStock 分支；price 且 `syncPolicy.price=='auto'`（类型放宽允许 auto）→ 按 `store.pricing` 重算 `variants.price` → 新 job `listing.pushPrice` → `adapter.pushPrices`（`productVariantsBulkUpdate`，可选能力，缺省=只打漂移）。
- 货源下架：插件 rescan 遇「商品不存在/已下架」→ `POST /collect/report {offerId, availability:'delisted'}` → `source_items.availability` + 按 `rules.inventory.oosAction` 执行 zero/unpublish/notify。
- 商品页三 tab：草稿 / 在线 / **关注**（`remoteDrift≠[]` ∪ `source_changed_at>7d` ∪ `linkStatus=remote_deleted` ∪ `availability='delisted'`）。列表列加：货源价/库存（有变黄标）、远端状态、自动动作。
- 批量：`POST /listings/batch`（mode: `price_set|price_mul|price_add|tag_add|tag_remove|sync_policy|publish_at`，ids≤200）。**可保存视图不做服务端**——localStorage 存筛选项即够；标签/分组复用 `listings.tags`（已有字段，筛选按 tag 即可），不建 listing_labels。
- 监控开启缺口提示：存量刊登 `syncPolicy` 全默认 notify → 商品页提供「批量开启库存跟踪/自动价」入口（吸收 AutoDS 的坑）。

### 3.4 仓储（切片 D：L1 合表 + L2 地址簿）

- L1 = `stores.rules.inventory`：推送量 `f(sourceStock)` = mirror（直通）/fixed n/percent/cap，再减 `buffer` 安全库存；归 0 时按 `oosAction` 置 0 / DELIST_LISTING / 只告警。判定发生在 propagateToListings 内（触发时机同 §0-5）。UI 明示「库存非实时，随插件回扫刷新（约 4h）」。
- L2 = `freight_forwarders` 地址簿 + `purchase_orders.forwarder_id` + 采购助手地址切换。**不做货代 API、不做代打包流转**。

### 3.5 商品优化工作流（切片 E：stage 注册表）

- `src/ai/stages/`：`interface Stage { name; run(ctx): Promise<{suggestions?; issues?}> }`，注册表 `STAGES: Stage[]` 定序（`clean(已存在=认领预处理,保持原位) → translate → title → description → category → attributes → options`）。`listing.aiEnhance` 单 job 内顺序执行启用 stage（`rules.pipeline.disabledStages` 关掉），**不拆一 stage 一 job**（少一倍队列表写入 + 原子失败）。
- 不破坏 `listing_suggestions` 的四条保证：① 产物仍是字段级 suggestion 行；② 幂等粒度从「删全部 pending」改为「删同 field 同 stage pending」；③ decide/审计/术语-类目-属性学习钩子零改动；④ UI 渲染零改动。
- v1 只做现有两个 LLM stage（enhance、categorySuggest 迁入注册表）；pricing/compliance 保持原位（认领定价、发布门禁已是确定性正确位置）；seo/images 编排化 defer。

### 3.6 AI 选品（切片 F）

- `selection_plans` CRUD + `discovery_items` 池。
- 数据流（全部插件回流，见 §0-4）：
  - **被动回流**：list.ts 扫描卡片时若当前 URL 命中任一 enabled plan 的 filters → 顺手 `POST /discovery/feed {planId, items:[{offerId,title,priceText,image,signals}]}`（用户正常浏览即产数据，零风控面）。
  - **主动拉取**：plan.schedule=daily → `GET /discovery/tasks`（插件 alarm 顺带调用，复用 rescan-queue 模式）返回到期 plan 的搜索 URL → SW `fetch`（用户会话）→ DOMParser 提卡片 → 同一 feed 端点。插件不在线则 plan 不产数据，`lastRunAt` 如实展示——不做服务端裸抓。
- 打分：`selection.score {planId}` job = 确定性信号（daiFa/48h/回头率/价格带命中 + 店铺定价试算毛利）→ `score`；LLM 只对 top-20 写 `ai_note`（一次调用，成本封顶）。**信号诚实原则**：列表页拿不到诚信通年限等详情字段时信号留空、不伪造。
- 候选卡片「采集」→ `POST /discovery/collect {ids}` → 挂进插件采集队列（复用 `COLLECT_1688`/STAGE→详情页重采链路）→ `collected_via='plan'`，`discovery_items.status→collected` + `source_item_db_id` 回填。
- 预设计划：新 workspace 建 3 个默认 plan（低风险类目关键词），让选品页冷门期不空。

---

## 4. 关键决策点显式回答（汇总 §0）

1. **订单同步**：webhook（toml 声明 orders/create|updated|cancelled + 自有应用；token 店连接时尝试 `webhookSubscriptionCreate`，验签不可行则仅轮询）+ `order.sync` 增量轮询兜底全部店铺。webhook 只入队不处理报文。
2. **链路编排**：jobs 链式（handler 末尾 enqueue 下一类型），无 pipeline runner。
3. **stage 管线**：代码注册表 + `listing_suggestions.stage` 幂等键；suggestions 机制四不变。
4. **discovery_items**：插件回流（被动浏览上报 + SW 主动拉列表页），服务端不裸抓。
5. **inventory_push_rules**：规则并入 `stores.rules.inventory`；触发时机 = 货源重采事件（propagateToListings），无独立调度器；UI 明示非实时。

## 5. REST 路由清单（新增/改动）

| 路由 | 说明 |
|---|---|
| `PATCH /stores/:id` | rules 增加 pipeline/inventory 两组键（现端点扩展） |
| `POST /source-items/claim` | 加 `advance?: boolean`（认领并走链路） |
| `POST /collect/report` | 插件上报货源可用性（下架标记） |
| `GET/POST/PATCH/DELETE /api/selection-plans*`、`GET /api/discovery/items`、`POST /api/discovery/feed`、`GET /api/discovery/tasks`、`POST /api/discovery/collect` | 选品域 |
| `GET /api/orders`（tab/q/店筛）、`GET /api/orders/:id`、`POST /api/orders/:id/review`、`POST /api/orders/:id/items/:iid/bind`、`POST /api/orders/:id/procure`、`POST /api/orders/:id/fulfill` | 订单域 |
| `GET/POST /api/purchase-orders`、`PATCH /api/purchase-orders/:id` | 采购域 |
| `GET/POST/PATCH/DELETE /api/freight-forwarders` | 货代地址簿 |
| `POST /api/listings/batch` | 批量改价/标签/策略/定时 |
| `POST /api/shopify/webhooks` | 扩展 order topics 分发 |

## 6. 页面改动

- **铺货**：认领弹窗加「认领并发布」；店稿卡链路进度徽标；店铺抽屉加「自动化链路」+「库存规则」设置组（即 rules 两个 jsonb 键的表单）。
- **商品**：三 tab（草稿/在线/关注）+ 批量栏 + 货源变化黄标 + 「批量开启监控」入口。
- **订单**（新一级导航）：状态 tab 列表、行内展开（映射标/地址一键复制/采购链/利润粗算）、绑定货源、去采购（拉起插件）、录运单。
- **采购**（新）：PO 列表按货源卖家分组、状态推进、轨迹录入。
- **选品**（新）：计划列表 + 候选卡片墙（勾选采集/忽略）+ AI 理由。
- **设置**：货代地址簿 CRUD。**任务**：新 job 类型 label。

## 7. Job 清单（新 7 个）

`listing.claim` / `pipeline.advance` / `listing.pushPrice` / `order.sync` / `order.map` / `fulfill.push` / `selection.score`。其余全部复用现有（rescan=插件 alarm+propagate，publish=现有门禁内嵌，inventory=pushStock）。

## 8. 测试计划（vitest + PGlite + fakeShopify）

- 链路：collect→autoClaim→aiEnhance→advance（白名单接受/卡点/熔断/pace runAt）全链；decide 幂等回归。
- stage：同 stage 重跑只覆盖自己 pending；disabledStages 生效。
- 订单：webhook→order.sync→upsert 幂等（同 remote_id 重放）；map 三档匹配；fulfill.push→fakeShopify fulfillmentCreate 桩→shipment 回写。
- 库存：strategy/buffer/oosAction 纯函数 + propagate→pushStock/pushPrice/delist 分支。
- 选品：feed 去重、score 确定性、collect→collected_via 回填。
- **每个新路由写跨 workspace 隔离测试**（AGENTS.md 硬性要求）。
- 插件手动 checklist：搜索页回流、采购助手卡、rescan 下架上报。

## 9. 实施顺序（可交付切片）

| 切片 | 内容 | 依赖 | 理由 |
|---|---|---|---|
| A | 一键上品（rules.pipeline + 链式 advance + pace/定时） | 无（零新表） | 纯编排复用，先让「采了就能上」跑起来 |
| B | 订单（6 表 + sync/map/fulfill + 插件采购助手 + 货代地址簿） | 部署有公网域名（webhook） | 闭环价值最大（调研§8.1 建议提前） |
| C | 商品列表/监控（change 检测、pushPrice、下架、三 tab、批量） | B 可并行 | 托管补强 |
| D | 仓储 L1（rules.inventory） | C 的 propagate 判定 | 与监控同源 |
| E | stage 注册表 | 无 | 内部重构，不动 UI |
| F | AI 选品（2 表 + 插件回流 + 打分） | E 之后接 aiNote 更顺 | 上游增量，独立可交付 |

## 10. 风险点（另一派会过度设计 / 本派可能漏的）

1. **webhook 覆盖盲区**：手动 access_token 店的 webhook HMAC 用商家自建应用 secret 签——我们验签不了，只能轮询；且 webhook 投递本身不保证到达。对手会建完整 reconciliation 层；本派必须守住的是「每店增量轮询兜底」这条底线不能省，否则订单静默丢单。
2. **SKU 映射断链**：按 `sku` 字符串匹配，用户在 Shopify 改 SKU 或远端变体重建即断。对手会建 SKU 主档（=双写灾难）。本派的省法：发布时把 productSet 返回的 `variant id ↔ sku` 落 `listings.remote_variant_map`，订单映射优先走 remoteVariantId——加一列换一个主键级稳定度，但不加这层兜底断链率会静默爬升。
3. **「插件在线」隐性依赖**：discovery 回流、货源回扫、采购协助都依赖用户浏览器开着。对手会试图服务端裸抓 1688（已验证风控）。本派的风险是**数据新鲜度静默劣化**——必须给 UI 明确语义：plan.lastRunAt、rescan 最后回流时间、「插件离线 N 天」横幅；否则用户以为监控在跑实际早停了。
