import type {
  CategoryCandidate,
  ChannelAttribute,
  RemoteStatus,
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

export interface PublishResult {
  remoteId: string;
  remoteUrl: string | null;
  /** set on first publish; undefined = leave the synced value alone */
  remoteStatus?: RemoteStatus;
  /** published, but something needs attention (e.g. images failed) */
  warnings?: string[];
}

/**
 * One implementation per target platform. Platform differences (category
 * mapping, media upload, required attributes) stay inside the adapter.
 */
export interface ChannelAdapter {
  verify(deps: Deps, store: StoreRow): Promise<ShopInfo>;
  /** Create or fully sync the remote product (idempotent on listing.remoteId). */
  publish(deps: Deps, store: StoreRow, listing: ListingRow): Promise<PublishResult>;
  /** Channel-side status per remote id; missing products map to DELETED. */
  fetchStatuses(deps: Deps, store: StoreRow, remoteIds: string[]): Promise<Map<string, RemoteStatus>>;
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
}
