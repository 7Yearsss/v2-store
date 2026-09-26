export type SourcePlatform =
  | "1688"
  | "taobao"
  | "pdd"
  | "temu"
  | "amazon"
  | "unknown";

/** One sellable variant row ("颜色:红色 / 尺码:XL" flattened spec text). */
export interface OfferSku {
  skuId?: string;
  spec: string;
  priceCny?: number;
  stock?: number;
  /** SKU 规格图（1688 skuProps 的首规格值图片，如颜色图）。 */
  image?: string;
}

/** Normalized source-side offer — output of every OfferSource parser. */
export interface CollectedOffer {
  sourcePlatform: SourcePlatform;
  sourceUrl: string;
  offerId?: string;
  title: string;
  priceText?: string;
  skus: OfferSku[];
  images: string[];
  /** 详情区长图（1688 详情 tab 的描述图，进发布后的 descriptionHtml）。 */
  descImages?: string[];
  attributes: Record<string, string>;
  /** 来源平台叶子类目 ID（1688 leafCategoryId）。 */
  categoryId?: string;
  categoryPath?: string[];
  sellerName?: string;
  collectedAt: string; // ISO
}

// --- harvest contract (page side收割, server side解析) ----------------------

/** Identity tokens pulled from a source URL — the unit of work for collection. */
export interface SourceInfo {
  itemUrl: string;
  itemId?: string;
  /** sub-site discriminator for multi-domain sources (e.g. www vs factory). */
  site?: string;
  source: SourcePlatform;
  postFee?: string;
}

export type AntiCode = "notLogin" | "needVerifySecurity" | "rowDataInvalid";

/**
 * What the extension posts to POST /api/collect: raw page HTML + URL tokens.
 * Field extraction happens server-side so site adaptors hot-update without an
 * extension release. `productExtInfo` carries already-structured data when the
 * page side had it cheaply (sniffed API payloads, DOM fallback).
 */
export interface CollectHarvest {
  sourceInfo: SourceInfo;
  /** documentElement.innerHTML of the detail page (or fetched detail HTML). */
  pageContent?: string;
  /** final URL after redirects. */
  afterUrl?: string;
  productExtInfo?: Record<string, unknown>;
  collectedAt: string;
}

// --- API DTOs (server ↔ web ↔ extension) ------------------------------------

export interface ApiError {
  error: string;
  code?: string;
}

export interface Me {
  user: { id: string; email: string; name: string };
  workspace: { id: string; name: string; plan: string };
  role: "owner" | "admin" | "member";
}

/** 采集箱条目：采集来的货源原料，未认领到任何店铺。 */
export interface SourceItem {
  id: string;
  sourcePlatform: SourcePlatform;
  sourceUrl: string;
  sourceItemId: string | null;
  title: string;
  priceText: string | null;
  skus: OfferSku[];
  images: string[];
  descImages: string[];
  attributes: Record<string, string>;
  sellerName: string | null;
  /** 来源平台叶子类目（1688 leafCategoryId / leafCategoryName）。 */
  sourceCategoryId: string | null;
  sourceCategoryName: string | null;
  collectedAt: string;
  updatedAt: string;
  /** store ids this item has been claimed to. */
  claimedStoreIds: string[];
  // --- fl-monitor ---
  /** 货源在架上状态：ok | delisted（插件/回扫上报）。 */
  availability: "ok" | "delisted";
  /** 转入断货的时间（断货天数由此算）。 */
  delistedAt: string | null;
  /** 最近一次成功回扫/采集时间。 */
  lastScannedAt: string | null;
  /** 采集通道（manual|plan|inquiry…）。 */
  collectedVia: string | null;
}

export type ChannelPlatform = "shopify";

export type StoreAuthType = "oauth" | "client_credentials" | "access_token";

export interface PricingRule {
  /** 1 CNY = exchangeRate × store currency. */
  exchangeRate: number;
  /** multiplier applied after currency conversion. */
  markup: number;
  /** price ending, e.g. 0.99 → 12.99; null keeps two decimals. */
  priceEnding: number | null;
  /** fixed CNY added to the source cost before conversion (shipping, packing…). */
  extraCostCny?: number;
  /** floor for the final price, in store currency; null = no floor. */
  minPrice?: number | null;
}

export interface ReplaceRule {
  from: string;
  to: string;
}

/**
 * 一键链路自动化策略（店铺级，stores.rules.pipeline）。
 * 链路：采集 → 认领 → AI stage → 卡点 → 发布前检查 → 发布（pace/scheduled）。
 */
export interface PipelinePolicy {
  /** 采集成功即自动认领到本店（collect → listing.claim）。 */
  autoClaim?: boolean;
  /** 可自动接受的 AI 建议字段白名单。 */
  autoAcceptFields?: SuggestionField[];
  /**
   * 审核卡点：
   * after_ai       — AI 跑完就停，人工放行进 precheck
   * after_precheck — precheck 跑完再人工放行发布
   * auto           — 全程自动（仍过禁售词/平台校验门禁）
   */
  holdPoint?: "after_ai" | "after_precheck" | "auto";
  /** precheck 通过即自动发布（否则停在可发布态等手工点）。 */
  autoPublish?: boolean;
  /**
   * 发布节奏：
   * now       — 立即发布
   * scheduled — 到点发布（publishAt）
   * paced     — 同店相邻两件发布至少隔 paceMinutes 分钟
   */
  publishMode?: "now" | "scheduled" | "paced";
  /** scheduled 模式的发布时间（ISO）。 */
  publishAt?: string;
  /** paced 模式的发布间隔分钟数。 */
  paceMinutes?: number;
  /** precheck 有 warn 也卡住人工确认（block 级永远拦）。 */
  holdOnWarning?: boolean;
  /** 关闭的 AI stage key（stage 注册表里的 key）。 */
  disabledStages?: string[];
}

/** 库存推送策略（stores.rules.inventory；消费判定由 fl-monitor 实现）。 */
export interface InventoryRules {
  /** mirror=跟随货源 | fixed=固定 | percent=货源×percent | cap=封顶 cap。 */
  strategy?: "mirror" | "fixed" | "percent" | "cap";
  fixedQty?: number;
  percent?: number;
  cap?: number;
  /** 安全库存：低于 buffer 视为缺货。 */
  buffer?: number;
  /** 缺货动作：zero=推 0 | unpublish=下架 | notify=仅通知。 */
  oosAction?: "zero" | "unpublish" | "notify";
}

/** 货源监控配置（stores.rules.monitor；回扫由插件 alarm 驱动，fl-monitor 实现）。 */
export interface MonitorRules {
  enabled?: boolean;
  /** 低于 minStock 视为缺货（与 inventory.buffer 共同判定）。 */
  minStock?: number | null;
  /** 价格变化是否自动同步到刊登。 */
  priceAuto?: boolean;
}

/** 采集预处理 + 发布前检查规则（店铺级，认领/发布时应用）。 */
export interface StoreRules {
  /** 认领时加到标题前/后（空格自动补）。 */
  titlePrefix?: string;
  titleSuffix?: string;
  /** 应用到标题与属性（认领时）。 */
  replacements?: ReplaceRule[];
  /** 源成本区间过滤：区间外 SKU 不建刊登变体；全部滤掉则不建刊登。 */
  priceMinCny?: number | null;
  priceMaxCny?: number | null;
  /** 认领图片上限（再叠加系统上限 20）。 */
  maxImages?: number | null;
  /** 发布门禁：标题/描述/标签/选项命中任一词则拦截发布。 */
  bannedWords?: string[];
  /** 发布到店铺后的初始状态；默认上架。 */
  publishStatus?: "active" | "draft";
  /** 同步货源库存：on = 发布追踪库存并把 1688 SKU 库存写入 Shopify；
   *  off（默认）= 不追踪库存（无限可售）。 */
  trackStock?: boolean;
  /** 库存写入的 Shopify 地点 gid（locations 里选）；不填用主地点 */
  inventoryLocationId?: string;
  /** 认领时默认标签。 */
  defaultTags?: string[];
  /** 认领时默认商品类型（AI 建议仍可覆盖）。 */
  defaultProductType?: string;
  /** 货源没有重量字段时的默认重量（kg），发布写入变体 measurement。 */
  defaultWeightKg?: number;
  /** 一键链路自动化策略。 */
  pipeline?: PipelinePolicy;
  /** 库存推送规则（仓储 L1）：货源库存 → 写入渠道的数量变换。 */
  inventory?: InventoryRules;
  /** 货源监控总开关。默认关：重扫只落 source_changes，不自动改刊登；
   *  enabled 后再叠加刊登级 syncPolicy / priceAuto 判定。 */
  monitor?: MonitorRules;
}

/** 术语翻译映射：变体选项名/值、属性名/值的源词 → 目标语译文，按刊登语言分桶。 */
export interface TermMapping {
  id: string;
  lang: string;
  sourceText: string;
  targetText: string;
  createdAt: string;
}

export interface Store {
  id: string;
  platform: ChannelPlatform;
  name: string;
  shopDomain: string;
  authType: StoreAuthType;
  status: "active" | "error" | "disconnected";
  currency: string | null;
  pricing: PricingRule;
  /** brand shown on published products; empty = none (never the supplier). */
  vendor: string;
  /** AI pipeline runs on claim when true. */
  aiEnhance: boolean;
  /** target language of AI-rewritten content (BCP-47-ish, e.g. "en", "zh-CN"). */
  language: string;
  rules: StoreRules;
  lastError: string | null;
  createdAt: string;
}

/** 刊登模板的载体：店铺刊登设置的完整快照（不含店铺连接信息）。 */
export interface StoreSettingsPayload {
  pricing: PricingRule;
  vendor: string;
  aiEnhance: boolean;
  language: string;
  rules: StoreRules;
}

export interface ListingTemplate {
  id: string;
  name: string;
  payload: StoreSettingsPayload;
  createdAt: string;
}

export interface ListingOption {
  name: string;
  values: string[];
}

export interface ListingVariant {
  sourceSkuId?: string;
  sku: string;
  /** one value per ListingOption, same order. */
  optionValues: string[];
  price: number;
  compareAtPrice?: number;
  costCny?: number;
  stock?: number;
  /** 变体图（发布时绑定为 Shopify variant 的图片）。 */
  image?: string;
}

export type ListingStatus = "draft" | "publishing" | "published" | "failed";

/** Product status on the channel, synced back periodically. */
export type RemoteStatus = "ACTIVE" | "DRAFT" | "ARCHIVED" | "UNLISTED" | "DELETED";

// --- 托管（在线商品回拉 / 漂移 / 自动动作） -------------------------------------

/** 刊登与远端商品的绑定状态。 */
export type LinkStatus = "linked" | "unlinked" | "remote_deleted";

/** 库存同步策略：auto = 回扫发现差异时自动推送本地库存；notify = 只标记漂移；off = 不管。 */
export type StockSyncPolicy = "auto" | "notify" | "off";
/** 内容漂移策略：只标记（notify）或忽略（off）；不会自动覆盖远端。 */
export type FlagSyncPolicy = "notify" | "off";
/** 价格策略：auto = 货源改价自动重算并推渠道价（另需店铺 monitor.priceAuto）；notify/off 同上。 */
export type PriceSyncPolicy = "auto" | "notify" | "off";

export interface ListingSyncPolicy {
  stock: StockSyncPolicy;
  content: FlagSyncPolicy;
  price: PriceSyncPolicy;
}

export const DEFAULT_SYNC_POLICY: ListingSyncPolicy = {
  stock: "notify",
  content: "notify",
  price: "notify",
};

/** 远端变体的平台中立快照（价格保留平台字符串原样）。 */
export interface RemoteVariantSnapshot {
  sku?: string | null;
  /** 远端选项值（与产品选项同序）。 */
  optionValues?: string[];
  price?: string;
  compareAtPrice?: string;
  stock?: number | null;
}

/** 一次远端拉取得到的平台中立商品快照。 */
export interface RemoteSnapshot {
  remoteId: string;
  status: RemoteStatus;
  title?: string;
  descriptionHtml?: string;
  variants?: RemoteVariantSnapshot[];
  /** ISO；本次拉取时间（本地缓存快照时是写入时间）。 */
  fetchedAt: string;
}

/** 字段级漂移条目：本地期望 vs 远端实际。 */
export interface RemoteDriftEntry {
  field: "title" | "descriptionHtml" | "price" | "stock" | string;
  local: unknown;
  remote: unknown;
}

/** 最近一次自动动作（回扫/来源变更触发），无痕自动动作不允许存在。 */
export interface LastAutoAction {
  action: string;
  /** ISO 时间。 */
  at: string;
  detail?: Record<string, unknown>;
}

/**
 * 一键链路阶段（listings.pipeline_stage；null = 非链路刊登）。
 * claimed → ai_running → (hold_ai) → precheck → (hold_precheck) →
 * queued → publishing → published；任意阶段失败 → failed。
 */
export type PipelineStage =
  | "claimed"
  | "ai_running"
  | "hold_ai"
  | "precheck"
  | "hold_precheck"
  | "queued"
  | "publishing"
  | "published"
  | "failed";

/** 刊登草稿：采集箱条目认领到某个店铺后的平台侧商品。 */
export interface Listing {
  id: string;
  storeId: string;
  sourceItemId: string;
  status: ListingStatus;
  title: string;
  descriptionHtml: string;
  images: string[];
  /** 详情图：发布时上传并追加到 descriptionHtml 末尾。 */
  descImages: string[];
  options: ListingOption[];
  variants: ListingVariant[];
  tags: string[];
  productType: string;
  vendor: string;
  /** 单件重量（kg），认领时从货源属性解析，可在编辑页改。 */
  weightKg: number | null;
  /** 已确认的目标平台类目（Shopify taxonomy gid）；未映射为 null。 */
  channelCategoryId: string | null;
  channelCategoryName: string | null;
  /** 已映射的平台标准属性（发布时写入 metafields）。 */
  channelAttributes: ListingChannelAttribute[];
  remoteId: string | null;
  remoteUrl: string | null;
  remoteStatus: RemoteStatus | null;
  /** 与远端商品的绑定状态（linked / unlinked / remote_deleted）。 */
  linkStatus: LinkStatus;
  /** 漂移处理策略（旧数据全部为 notify 安全默认）。 */
  syncPolicy: ListingSyncPolicy;
  /** 最近一次远端拉取的快照（推送成功后则为我们写入的内容）。 */
  remoteSnapshot: RemoteSnapshot | null;
  /** 字段级漂移：本地与远端不一致的字段列表，只标记不自动覆盖。 */
  remoteDrift: RemoteDriftEntry[];
  lastPulledAt: string | null;
  lastAutoAction: LastAutoAction | null;
  // --- fl-monitor ---
  /** 最近一次货源变化的检测时间；非空即「货源有变化」。 */
  sourceChangedAt: string | null;
  /** 内部标记（不上渠道）。 */
  internalTags: string[];
  /** 定时发布时间（排程器消费）。 */
  publishAt: string | null;
  /** 未消费货源变更概览（列表页带出）：pending 条数 + 涉及的变更类型。 */
  sourceMonitor?: { pending: number; types: SourceChangeType[] };
  // ---
  syncedAt: string | null;
  lastError: string | null;
  publishedAt: string | null;
  /** 链路阶段；null = 不在链路里（手工认领未开自动化）。 */
  pipelineStage: PipelineStage | null;
  /** 链路暂停/卡住的机器可读原因。 */
  pipelineHoldReason: string | null;
  /** 链路进入时的策略快照。 */
  policySnapshot?: PipelinePolicy | null;
  /** 发布回填的远端变体映射：本地 sku → {variantId, inventoryItemId}（订单/库存链路用）。 */
  remoteVariantMap: RemoteVariantMap | null;
  createdAt: string;
  updatedAt: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

// --- AI 建议（字段级，审核后才进刊登） ---------------------------------------

/** Listing fields the AI pipeline may propose changes for. */
export type SuggestionField =
  | "title"
  | "descriptionHtml"
  | "productType"
  | "tags"
  | "options"
  | "category"
  | "attributes";

/** Composite value for the `options` field: translated options plus every
 *  variant's optionValues (index-aligned with listing.variants). */
export interface OptionsSuggestionValue {
  options: ListingOption[];
  /** variantOptionValues[i] replaces variants[i].optionValues. */
  variantOptionValues: string[][];
  /** 生成建议时刊登的原始选项快照；学习词对与配对以此为准，避免接受期间草稿被改过。 */
  sourceOptions?: ListingOption[];
}

export interface CategoryCandidate {
  /** channel-native id（Shopify: gid://shopify/TaxonomyCategory/…）。 */
  id: string;
  name: string;
  /** 完整路径名（"Apparel > Tops > T-Shirts"），用于展示与排序。 */
  fullName: string;
  /** 0-100，AI 排序或平台预测器给出的置信度。 */
  confidence?: number;
}

/** Composite value for the `category` field: the source leaf category plus
 *  the AI-ranked candidates; accept picks one via `choice`. */
export interface CategorySuggestionValue {
  sourceCategoryId: string | null;
  sourceCategoryName: string | null;
  candidates: CategoryCandidate[];
}

/** 已确认的来源类目 → 平台类目映射（同来源类目下次自动套用）。 */
export interface CategoryMapping {
  id: string;
  sourcePlatform: SourcePlatform;
  sourceCategoryId: string;
  sourceCategoryName: string | null;
  channel: ChannelPlatform;
  channelCategoryId: string;
  channelCategoryName: string;
  version: string;
  confirmedBy: "user" | "ai";
  createdAt: string;
}

// --- 平台属性映射（来源属性 → 类目标准属性） ---------------------------------

/** 平台类目下的标准属性（如 Shopify taxonomy attribute）。 */
export interface ChannelAttribute {
  /** channel-native attr id（Shopify: TaxonomyAttribute/ChoiceList gid）。 */
  id: string;
  name: string;
  /** choice = 下拉值列表；text = 自由文本；measurement = 数值+单位。 */
  kind: "choice" | "text" | "measurement";
  /** choice 属性的候选值（截断缓存）。 */
  values?: { id: string; name: string }[];
}

/** 确认后落在刊登上的平台属性值。 */
export interface ListingChannelAttribute {
  attrId: string;
  name: string;
  value: string;
}

/** AI 属性提案条目：来源属性 → 平台属性 + 取值。 */
export interface ChannelAttributeProposal {
  /** 来源属性名；空 = AI 新造的属性（不写入映射表）。 */
  sourceName: string;
  sourceValue: string;
  attrId: string;
  attrName: string;
  value: string;
}

/** Composite value for the `attributes` field. */
export interface AttributesSuggestionValue {
  attributes: ChannelAttributeProposal[];
}

/** 已确认的来源属性名 → 平台属性映射（同来源属性名下次自动套用）。 */
export interface AttributeMapping {
  id: string;
  channel: ChannelPlatform;
  sourceName: string;
  channelAttrId: string;
  channelAttrName: string;
  createdAt: string;
}

export type SuggestionStatus = "pending" | "accepted" | "rejected";

/** One field-level AI proposal; the listing row is only touched on accept. */
export interface ListingSuggestion {
  id: string;
  listingId: string;
  field: SuggestionField;
  /** 产出该建议的 stage key（ai/stages 注册表；旧数据为 'ai'）。 */
  stage: string;
  value: unknown;
  status: SuggestionStatus;
  createdAt: string;
}

export * from "./offer1688.js";

export type JobStatus = "queued" | "running" | "succeeded" | "failed";

/** Background job row exposed to the tasks page; listingId/storeId lifted from payload when present. */
export interface Job {
  id: string;
  type: string;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  runAt: string;
  createdAt: string;
  updatedAt: string;
  listingId: string | null;
  storeId: string | null;
  /** run/attempt 体系内派生的 publish job 会带 attemptId；stock 兜底等直接入队的不带。 */
  attemptId: string | null;
}

// --- 发布批次（run/attempt）与审计 -------------------------------------------

/** 可归一化的发布错误码；error 字段保留平台原文。 */
export type PublishErrorCode =
  | "auth_expired"
  | "rate_limited"
  | "review_rejected"
  | "remote_deleted"
  | "unknown";

export type PublishRunStatus =
  | "queued"
  | "running"
  | "partial_success"
  | "succeeded"
  | "failed";

export type PublishAttemptStatus = "queued" | "running" | "succeeded" | "failed";

/** 发布时冻结的刊登字段快照（attempt 级；重试时取当版字段）。 */
export interface ListingFieldsSnapshot {
  title: string;
  descriptionHtml: string;
  images: string[];
  descImages: string[];
  options: ListingOption[];
  variants: ListingVariant[];
  tags: string[];
  productType: string;
  vendor: string;
  weightKg: number | null;
  channelCategoryId: string | null;
  channelCategoryName: string | null;
  channelAttributes: ListingChannelAttribute[];
}

/** 一次「勾选多条刊登发布」形成的批次。 */
export interface PublishRun {
  id: string;
  status: PublishRunStatus;
  listingIds: string[];
  /** 该 run 内 attempt 状态计数（任务页列表用）。 */
  counts: { total: number; queued: number; running: number; succeeded: number; failed: number } | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** run 内每个刊登一条 attempt；重试产生新 attempt（retryOf 指向上一条）。 */
export interface PublishAttempt {
  id: string;
  runId: string;
  listingId: string;
  storeId: string;
  status: PublishAttemptStatus;
  /** 平台原文错误。 */
  error: string | null;
  /** 归一化错误码。 */
  errorCode: PublishErrorCode | null;
  fieldsSnapshot: ListingFieldsSnapshot;
  remoteId: string | null;
  remoteUrl: string | null;
  retryOf: string | null;
  jobId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLog {
  id: string;
  /** "user:<id>" | "system" | "system:sync" 等。 */
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

// --- 货源监控（fl-monitor） ---------------------------------------------------

/** 货源变更类型：价/库存/标题/图片/属性 按 sku 或整品粒度，delisted 为整品。 */
export type SourceChangeType =
  | "price"
  | "stock"
  | "title"
  | "images"
  | "attributes"
  | "delisted";

/** 变更落账：每条 listing 一个动作；superseded/ignored 等无 listingId。 */
export interface SourceChangeAppliedAction {
  listingId?: string;
  action: string;
}

export interface SourceChange {
  id: string;
  sourceItemId: string;
  changeType: SourceChangeType;
  skuId: string | null;
  oldValue: unknown;
  newValue: unknown;
  detectedAt: string;
  appliedAt: string | null;
  appliedAction: SourceChangeAppliedAction[] | null;
}

/** POST /listings/batch 的单个批量操作。 */
export type ListingBatchOp =
  | { op: "price_set"; value: number }
  | { op: "price_mul"; value: number }
  | { op: "price_add"; value: number }
  | { op: "internal_tag"; add?: string[]; remove?: string[] }
  | { op: "sync_policy"; value: Partial<ListingSyncPolicy> }
  | { op: "publish_at"; value: string | null }
  | { op: "monitor_enable"; value?: boolean };


// --- 订单域（订单管理 + 采购 + 履约回传） ---------------------------------------

/** 刊登变体 ↔ 远端变体的稳定映射（productSet 返回值回填；订单行匹配的主键级键）。 */
export interface RemoteVariantRef {
  variantId: string;
  inventoryItemId?: string;
}
/** listings.remote_variant_map：{ [本地 variant.sku]: { variantId, inventoryItemId } } */
export type RemoteVariantMap = Record<string, RemoteVariantRef>;

export type OrderStatus =
  | "new"
  | "to_procure"
  | "procuring"
  | "to_ship"
  | "shipped"
  | "done"
  | "cancelled"
  | "exception";
export type OrderItemMapping = "matched" | "partial" | "unmatched";
/** 行项采购进度：none 未采购 → queued 已建采购单 → placed 已下单 → shipped 供应商已发货 → done 到货；failed 采购异常。 */
export type ProcureStatus = "none" | "queued" | "placed" | "shipped" | "done" | "failed";
export type PurchaseOrderStatus =
  | "draft"
  | "placed"
  | "paid"
  | "domestic_shipped"
  | "intl_shipped"
  | "done"
  | "exception";
export type ShipmentStatus = "pending" | "pushed" | "failed";

/** 收货地址（订单域唯一含 PII 的结构；库内只存密文 shipping_address_enc）。 */
export interface ShippingAddress {
  recipient?: string;
  phone?: string;
  country?: string;
  province?: string;
  city?: string;
  address1?: string;
  address2?: string;
  postcode?: string;
}

export interface OrderCustomer {
  name?: string;
  email?: string;
  phone?: string;
}

export interface TrackingEntry {
  carrier?: string;
  no: string;
  url?: string;
}

export interface OrderItem {
  id: string;
  orderId: string;
  remoteLineItemId: string | null;
  /** Shopify variant gid —— 映射键①（listings.remote_variant_map）。 */
  remoteVariantId: string | null;
  title: string;
  sku: string | null;
  qty: number;
  unitPrice: number | null;
  listingId: string | null;
  sourceItemId: string | null;
  /** 1688 specId（映射键②，经刊登变体 sourceSkuId 或人工绑定）。 */
  sourceSkuId: string | null;
  mapping: OrderItemMapping;
  procureStatus: ProcureStatus;
  /** 详情接口附带：映射目标的可读信息。 */
  listingTitle?: string | null;
  sourceTitle?: string | null;
  /** 货源 offerId（去采购链接用）。 */
  offerId?: string | null;
  sourceSeller?: string | null;
  /** 货源规格文案（采购卡展示）。 */
  specText?: string | null;
  /** 货源单价（CNY，利润粗算）。 */
  costCny?: number | null;
  /** 该行来源订单名（采购单视角下填充）。 */
  orderName?: string | null;
  /** 采购链：该行所在的采购单（订单详情/行内展开填充）。 */
  purchaseOrders?: Array<{
    id: string;
    status: PurchaseOrderStatus;
    sourceOrderId: string | null;
    sourceSeller: string | null;
  }>;
}

/** 订单 DTO：地址永远脱敏（明文只在 /orders/:id/address 单点返回）。 */
export interface Order {
  id: string;
  storeId: string;
  storeName?: string;
  remoteId: string;
  name: string | null;
  financialStatus: string | null;
  fulfillmentStatus: string | null;
  status: OrderStatus;
  /** 脱敏后的买家信息。 */
  customer: OrderCustomer | null;
  /** 脱敏后的一行地址摘要（如 "广东 深圳 · 张* · 138****1234"）。 */
  shippingAddressMasked: string | null;
  currency: string | null;
  subtotal: number | null;
  total: number | null;
  itemsCount: number | null;
  placedAt: string | null;
  syncedAt: string | null;
  reviewedAt: string | null;
  items: OrderItem[];
  shipments: Shipment[];
  /** 利润粗算（CNY）：售价按店铺汇率折回人民币 − 已匹配行的货源成本合计。 */
  profit?: { costCny: number; grossCny: number } | null;
  createdAt: string;
}

export interface Shipment {
  id: string;
  orderId: string;
  purchaseOrderId: string | null;
  carrier: string | null;
  trackingNo: string | null;
  trackingUrl: string | null;
  remoteFulfillmentId: string | null;
  status: ShipmentStatus;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PurchaseOrderItem {
  purchaseOrderId: string;
  orderItemId: string;
  qty: number;
  unitPriceCny: number | null;
  /** 附带：行项快照（列表页直接渲染）。 */
  orderItem?: OrderItem | null;
}

export interface PurchaseOrder {
  id: string;
  kind: "manual" | "source_order" | "forwarder";
  sourcePlatform: string;
  sourceSeller: string | null;
  status: PurchaseOrderStatus;
  /** 1688 订单号（手工录入或插件「标记已下单」回填）。 */
  sourceOrderId: string | null;
  domesticTracking: TrackingEntry[];
  intlTracking: TrackingEntry[];
  forwarderId: string | null;
  forwarder?: FreightForwarder | null;
  costTotalCny: number | null;
  note: string | null;
  items: PurchaseOrderItem[];
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 货代地址簿（仅地址，不接 API）。 */
export interface FreightForwarder {
  id: string;
  name: string;
  address: ShippingAddress;
  /** 货代系统类型（huoxiaoyi|manual…）。 */
  systemType: string | null;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 渠道侧订单的平台中立形态（adapter.fetchOrders 返回；raw 留档原报文）。 */
export interface RemoteOrderLine {
  remoteLineItemId: string;
  remoteVariantId?: string | null;
  title: string;
  sku?: string | null;
  qty: number;
  unitPrice?: number | null;
}

export interface RemoteOrder {
  remoteId: string;
  name?: string | null;
  financialStatus?: string | null;
  fulfillmentStatus?: string | null;
  cancelledAt?: string | null;
  customer?: OrderCustomer | null;
  shippingAddress?: ShippingAddress | null;
  currency?: string | null;
  subtotal?: number | null;
  total?: number | null;
  itemsCount?: number | null;
  placedAt?: string | null;
  /** 远端更新时间：幂等新鲜度键（<= 已存 raw.updatedAt 的重放缓存直接跳过）。 */
  updatedAt?: string | null;
  lineItems: RemoteOrderLine[];
  raw?: unknown;
}

/** 履约推送入参（fulfillmentOrders → fulfillmentCreate，按 fulfillmentOrder 粒度）。 */
export interface FulfillPushInput {
  remoteOrderId: string;
  tracking: { number: string; company?: string; url?: string };
  /** 只发这些行项（remoteLineItemId → qty）；缺省 = 发所有剩余未履约行。 */
  lineItems?: Array<{ remoteLineItemId: string; qty?: number }>;
  notifyCustomer?: boolean;
}

/** POST /orders/:id/procure 的返回：插件采购卡数据源（一单一卡可含多个货源行）。 */
export interface ProcurePayload {
  orderId: string;
  orderName: string | null;
  offers: Array<{
    offerId: string;
    sourceItemId: string;
    title: string | null;
    image?: string | null;
    /** 规格文案（1688 spec），无可填项时引导用户手动选规格。 */
    specText: string | null;
    qty: number;
    unitPriceCny?: number | null;
  }>;
  /** 明文收货地址（本端点即「复制地址」用途）；货代单时为货代仓地址。 */
  address: ShippingAddress | null;
}
