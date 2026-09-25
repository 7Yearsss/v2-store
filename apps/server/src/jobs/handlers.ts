import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { runAiEnhance } from "../ai/enhance.js";
import { adapterFor } from "../channels/index.js";
import type { Deps } from "../context.js";
import type { Db } from "../db/client.js";
import { jobs, listings, sourceItems, stores } from "../db/schema.js";
import { findBannedWords } from "../lib/rules.js";
import { fetchAndStore, resolveSources } from "../modules/media.js";
import { enqueue, type JobHandler, PermanentJobError } from "./queue.js";

export const PUBLISH_LISTING = "listing.publish";
export const FETCH_MISSING_MEDIA = "media.fetchMissing";
export const SYNC_STORE = "store.syncListings";
export const AI_ENHANCE_LISTING = "listing.aiEnhance";

/** Queue an AI pass for a listing unless one is already waiting/running. */
export async function enqueueAiEnhance(
  db: Db,
  listingIds: string[],
  workspaceId: string,
) {
  if (!listingIds.length) return 0;
  const pending = await db
    .select({ lid: sql<string>`${jobs.payload}->>'listingId'` })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, AI_ENHANCE_LISTING),
        inArray(jobs.status, ["queued", "running"]),
        inArray(sql`${jobs.payload}->>'listingId'`, listingIds),
      ),
    );
  const have = new Set(pending.map((p) => p.lid));
  let queued = 0;
  for (const id of listingIds.filter((id) => !have.has(id))) {
    await enqueue(db, AI_ENHANCE_LISTING, { listingId: id }, { workspaceId, maxAttempts: 2 });
    queued++;
  }
  return queued;
}

/** Queue a status sync for a store unless one is already waiting. */
export async function enqueueStoreSync(db: Db, storeId: string, workspaceId: string) {
  const [pending] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, SYNC_STORE),
        eq(jobs.status, "queued"),
        sql`${jobs.payload}->>'storeId' = ${storeId}`,
      ),
    )
    .limit(1);
  if (!pending) await enqueue(db, SYNC_STORE, { storeId }, { workspaceId, maxAttempts: 1 });
}

/** Pull channel-side status of every published listing of a store. */
const syncStore: JobHandler = {
  async run(deps: Deps, job) {
    const [store] = await deps.db
      .select()
      .from(stores)
      .where(eq(stores.id, String(job.payload.storeId)));
    if (!store || store.status === "disconnected") return;
    const rows = await deps.db
      .select({ id: listings.id, remoteId: listings.remoteId })
      .from(listings)
      .where(and(eq(listings.storeId, store.id), isNotNull(listings.remoteId)));
    if (!rows.length) return;
    const statuses = await adapterFor(store.platform).fetchStatuses(
      deps,
      store,
      rows.map((r) => r.remoteId!),
    );
    const now = new Date();
    for (const r of rows) {
      const remoteStatus = statuses.get(r.remoteId!);
      if (remoteStatus) {
        await deps.db.update(listings).set({ remoteStatus, syncedAt: now }).where(eq(listings.id, r.id));
      }
    }
  },
};

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
    // 发布门禁（绕过端点的路径也要拦）
    const banned = findBannedWords(row.listing, row.store.rules?.bannedWords);
    if (banned.length) {
      throw new PermanentJobError(`发布前检查未通过，含禁售词：${banned.join("、")}`);
    }
    // deleted on the channel → publish as a new product
    const listing =
      row.listing.remoteStatus === "DELETED" ? { ...row.listing, remoteId: null } : row.listing;
    const result = await adapterFor(row.store.platform).publish(deps, row.store, listing);
    await deps.db
      .update(listings)
      .set({
        status: "published",
        remoteId: result.remoteId,
        remoteUrl: result.remoteUrl,
        ...(result.remoteStatus ? { remoteStatus: result.remoteStatus, syncedAt: new Date() } : {}),
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

const aiEnhance: JobHandler = {
  async run(deps: Deps, job) {
    await runAiEnhance(deps, String(job.payload.listingId));
  },
};

export const jobHandlers: Record<string, JobHandler> = {
  [PUBLISH_LISTING]: publishListing,
  [FETCH_MISSING_MEDIA]: fetchMissingMedia,
  [SYNC_STORE]: syncStore,
  [AI_ENHANCE_LISTING]: aiEnhance,
};
