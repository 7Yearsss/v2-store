import type { CategoryCandidate, RemoteStatus } from "@caiji/shared";
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
}
