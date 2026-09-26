import type {
  CategoryCandidate,
  ChannelAttribute,
  FulfillPushInput,
  ListingVariant,
  RemoteOrder,
  RemoteSnapshot,
  RemoteStatus,
  RemoteVariantMap,
} from "@caiji/shared";
import type { Deps } from "../context.js";
import type { listings, stores } from "../db/schema.js";

export type StoreRow = typeof stores.$inferSelect;
export type ListingRow = typeof listings.$inferSelect;

/** Error surfaced to the user verbatim (bad token, platform validation…). */
export class ChannelError extends Error {
  constructor(
    message: string,
    /** retrying won't help (validation, auth) — fail the job immediately. */
    public permanent = true,
  ) {
    super(message);
  }
}

export interface ShopInfo {
  name: string;
  currency: string;
  shopDomain: string;
}

/** 结构化校验问题：发布预览与发布门禁共用同一套判定（所见=所判）。 */
export interface ChannelIssue {
  /** 稳定机器码：required / too_long / invalid_value / platform_rule… */
  code: string;
  /** 出问题的字段（title / variants / variants.price…）。 */
  field?: string;
  message: string;
  /** block（缺省）挡发布；warn 只是平台建议。 */
  severity?: "block" | "warn";
}

export interface PublishResult {
  remoteId: string;
  remoteUrl: string | null;
  /** set on first publish; undefined = leave the synced value alone */
  remoteStatus?: RemoteStatus;
  /** 本地变体 sku ↔ 远端 variantId 映射（回填 listings.remote_variant_map，订单行匹配键）。 */
  remoteVariantMap?: RemoteVariantMap;
  /** published, but something needs attention (e.g. images failed) */
  warnings?: string[];
}

/**
 * One implementation per target platform. Platform differences (category
 * mapping, media upload, required attributes) stay inside the adapter.
 */
export interface ChannelAdapter {
  verify(deps: Deps, store: StoreRow): Promise<ShopInfo>;
  /**
   * 结构化发布校验：预览接口与发布 job 共用，平台规则差异只写在实现里。
   * 店铺级规则（禁售词等）不属于平台校验，由调用方另行叠加。
   */
  validate(
    deps: Deps,
    store: StoreRow,
    listing: ListingRow,
  ): ChannelIssue[] | Promise<ChannelIssue[]>;
  /** Create or fully sync the remote product (idempotent on listing.remoteId). */
  publish(deps: Deps, store: StoreRow, listing: ListingRow): Promise<PublishResult>;
  /** Channel-side status per remote id; missing products map to DELETED. */
  fetchStatuses(deps: Deps, store: StoreRow, remoteIds: string[]): Promise<Map<string, RemoteStatus>>;
  /**
   * 拉远端商品的平台中立快照（id/status/title/description/variants 价格库存），
   * 用于漂移计算与发布前确认；map 值 null = 远端不存在。可选能力：缺省时
   * 同步链路退回 fetchStatuses 只拉状态。
   */
  fetchRemoteSnapshots?(
    deps: Deps,
    store: StoreRow,
    remoteIds: string[],
  ): Promise<Map<string, RemoteSnapshot | null>>;
  /**
   * 只更新远端库存（不动标题/描述/价格）。用于货源库存变化的同步路径，
   * 避免全量 publish 覆盖商家在平台上改过的内容。返回警告文案或 null；
   * 可选能力：缺省时同步链路用全量发布兜底（会记审计标明是兜底覆盖）。
   */
  pushStock?(
    deps: Deps,
    store: StoreRow,
    remoteId: string,
    variants: ListingVariant[],
  ): Promise<string | null>;
  /**
   * 只更新远端变体价格（货源改价重算后的轻量同步，不动标题/描述/库存）。
   * 返回警告文案或 null；可选能力：缺省时同步链路只标 drift。
   */
  pushPrices?(
    deps: Deps,
    store: StoreRow,
    remoteId: string,
    variants: ListingVariant[],
  ): Promise<string | null>;
  /** Unpublish a remote product without deleting it (Shopify status → DRAFT).
   *  Absent = delisting unsupported on this channel. */
  delistProduct?(deps: Deps, store: StoreRow, remoteId: string): Promise<void>;
  /** Search the platform's category tree (taxonomy) by keyword; absent = no category support yet. */
  searchCategories?(
    deps: Deps,
    store: StoreRow,
    query: string,
  ): Promise<CategoryCandidate[]>;
  /**
   * Platform-native category predictor (e.g. Mercado Livre domain_discovery):
   * product title in the site's language → ranked candidates. When present the
   * suggestion pipeline prefers it over keyword search + AI ranking.
   */
  predictCategories?(
    deps: Deps,
    store: StoreRow,
    input: { title: string; sourceCategoryName?: string | null; language?: string | null },
  ): Promise<CategoryCandidate[]>;
  /**
   * Pull the platform's whole category tree into channel_categories cache.
   * Returns the number of nodes cached. Absent = no full-tree support.
   */
  syncCategoryTree?(deps: Deps, store: StoreRow): Promise<{ count: number }>;
  /**
   * Standard attributes of one platform category (Shopify taxonomy attribute
   * list: name/kind/choice values). Lazily fetched and cached in
   * channel_categories.attributesSchema — absent = no attribute support.
   */
  categoryAttributes?(
    deps: Deps,
    store: StoreRow,
    categoryId: string,
  ): Promise<ChannelAttribute[]>;
  /**
   * Inventory locations the channel store fulfills from (Shopify locations,
   * Ozon warehouses). Feeds the 库存地点 picker; absent = location choice
   * unsupported — publish writes to the channel default.
   */
  listLocations?(
    deps: Deps,
    store: StoreRow,
  ): Promise<Array<{ id: string; name: string; isActive: boolean }>>;
  /**
   * OAuth 授权店连接成功后注册订单 webhook（orders/create|updated|cancelled）。
   * 手动 token 店没有我们的 app secret，验签不了 —— 缺省 = 只能走增量轮询。
   */
  registerOrderWebhooks?(
    deps: Deps,
    store: StoreRow,
    callbackUrl: string,
  ): Promise<{ registered: string[]; errors: string[] }>;
  /**
   * 拉渠道订单：remoteId 给定时拉单条，否则按 updatedAfter（ISO 游标）增量拉。
   * 返回平台中立 RemoteOrder；缺省 = 该平台不支持订单同步。
   */
  fetchOrders?(
    deps: Deps,
    store: StoreRow,
    opts: { updatedAfter?: string | null; remoteId?: string },
  ): Promise<RemoteOrder[]>;
  /**
   * 履约回传：fulfillmentOrders → fulfillmentCreate（trackingInfo + notifyCustomer），
   * 部分发货按 fulfillmentOrder 粒度。返回远端 fulfillment id；缺省 = 不支持。
   */
  pushFulfillment?(
    deps: Deps,
    store: StoreRow,
    input: FulfillPushInput,
  ): Promise<{ remoteFulfillmentId: string }>;
}
