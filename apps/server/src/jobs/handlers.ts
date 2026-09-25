import { and, eq } from "drizzle-orm";
import { adapterFor } from "../channels/index.js";
import type { Deps } from "../context.js";
import { listings, sourceItems, stores } from "../db/schema.js";
import { fetchAndStore, resolveSources } from "../modules/media.js";
import { type JobHandler, PermanentJobError } from "./queue.js";

export const PUBLISH_LISTING = "listing.publish";
export const FETCH_MISSING_MEDIA = "media.fetchMissing";

/** Copy a source item's images the extension didn't upload. */
const fetchMissingMedia: JobHandler = {
  async run(deps: Deps, job) {
    const [item] = await deps.db
      .select()
      .from(sourceItems)
      .where(eq(sourceItems.id, String(job.payload.sourceItemId)));
    if (!item) return;
    const have = await resolveSources(deps.db, item.workspaceId, item.images);
    const failed: string[] = [];
    for (const url of item.images.filter((u) => !have.has(u))) {
      await fetchAndStore(deps, item.workspaceId, url).catch(() => failed.push(url));
    }
    if (failed.length) throw new Error(`${failed.length} 张图片下载失败`);
  },
};

const publishListing: JobHandler = {
  async run(deps: Deps, job) {
    const listingId = String(job.payload.listingId);
    const [row] = await deps.db
      .select({ listing: listings, store: stores })
      .from(listings)
      .innerJoin(stores, eq(stores.id, listings.storeId))
      .where(eq(listings.id, listingId));
    if (!row) throw new PermanentJobError("刊登记录已删除");
    if (row.store.status === "disconnected") throw new PermanentJobError("店铺已断开授权");
    const result = await adapterFor(row.store.platform).publish(deps, row.store, row.listing);
    await deps.db
      .update(listings)
      .set({
        status: "published",
        remoteId: result.remoteId,
        remoteUrl: result.remoteUrl,
        lastError: result.warnings?.length ? result.warnings.join("；") : null,
        publishedAt: new Date(),
      })
      .where(eq(listings.id, listingId));
  },
  async onFailed(deps, job, error) {
    await deps.db
      .update(listings)
      .set({ status: "failed", lastError: error })
      .where(
        and(eq(listings.id, String(job.payload.listingId)), eq(listings.status, "publishing")),
      );
  },
};

export const jobHandlers: Record<string, JobHandler> = {
  [PUBLISH_LISTING]: publishListing,
  [FETCH_MISSING_MEDIA]: fetchMissingMedia,
};
