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
  /** 认领时默认标签。 */
  defaultTags?: string[];
  /** 认领时默认商品类型（AI 建议仍可覆盖）。 */
  defaultProductType?: string;
  /** 货源没有重量字段时的默认重量（kg），发布写入变体 measurement。 */
  defaultWeightKg?: number;
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
  syncedAt: string | null;
  lastError: string | null;
  publishedAt: string | null;
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
  value: unknown;
  status: SuggestionStatus;
  createdAt: string;
}

export * from "./offer1688.js";
