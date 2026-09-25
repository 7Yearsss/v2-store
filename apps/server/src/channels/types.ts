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
}
