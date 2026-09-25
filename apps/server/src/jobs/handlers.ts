import { and, eq } from "drizzle-orm";
import { adapterFor } from "../channels/index.js";
import type { Deps } from "../context.js";
import { listings, stores } from "../db/schema.js";
import { type JobHandler, PermanentJobError } from "./queue.js";

export const PUBLISH_LISTING = "listing.publish";

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
        lastError: null,
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
};
