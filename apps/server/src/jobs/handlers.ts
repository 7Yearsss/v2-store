import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { RemoteSnapshot, SourcePlatform } from "@caiji/shared";
import { runCategorySuggest } from "../ai/category.js";
import { runAiEnhance } from "../ai/enhance.js";
import { adapterFor } from "../channels/index.js";
import type { Deps } from "../context.js";
import type { Db } from "../db/client.js";
import {
  jobs,
  listings,
  publishAttempts,
  publishRuns,
  sourceItems,
  stores,
} from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { resolveCategoryMapping } from "../lib/category.js";
import {
  computeDrift,
  filterDriftByPolicy,
  normalizePublishError,
  pushedSnapshot,
} from "../lib/drift.js";
import { findBannedWords } from "../lib/rules.js";
import { fetchAndStore, resolveSources } from "../modules/media.js";
import { enqueue, type JobHandler, PermanentJobError } from "./queue.js";

export const PUBLISH_LISTING = "listing.publish";
export const FETCH_MISSING_MEDIA = "media.fetchMissing";
export const SYNC_STORE = "store.syncListings";
export const AI_ENHANCE_LISTING = "listing.aiEnhance";
export const CATEGORY_SUGGEST = "listing.categorySuggest";
export const SYNC_CATEGORIES = "store.syncCategories";
export const DELIST_LISTING = "listing.delist";
/** 只更新远端库存（货源库存变化的轻量同步，不触碰远端标题/描述/价格）。 */
export const PUSH_STOCK = "listing.pushStock";

/** Queue a category-suggestion pass unless one is already waiting/running. */
export async function enqueueCategorySuggest(
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
        eq(jobs.type, CATEGORY_SUGGEST),
        inArray(jobs.status, ["queued", "running"]),
        inArray(sql`${jobs.payload}->>'listingId'`, listingIds),
      ),
    );
  const have = new Set(pending.map((p) => p.lid));
  let queued = 0;
  for (const id of listingIds.filter((id) => !have.has(id))) {
    await enqueue(db, CATEGORY_SUGGEST, { listingId: id }, { workspaceId, maxAttempts: 2 });
    queued++;
  }
  return queued;
}

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

/** Queue a platform category-tree sync for a store unless one is already waiting. */
export async function enqueueCategorySync(db: Db, storeId: string, workspaceId: string) {
  const [pending] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, SYNC_CATEGORIES),
        inArray(jobs.status, ["queued", "running"]),
        sql`${jobs.payload}->>'storeId' = ${storeId}`,
      ),
    )
    .limit(1);
  if (!pending) {
    await enqueue(db, SYNC_CATEGORIES, { storeId }, { workspaceId, maxAttempts: 2 });
  }
}

/** 按每刊登最新 attempt 聚合 run 状态（重试留档的旧 attempt 不参与）。 */
async function aggregatePublishRun(db: Db, runId: string) {
  const rows = await db
    .select()
    .from(publishAttempts)
    .where(eq(publishAttempts.runId, runId))
    .orderBy(asc(publishAttempts.createdAt));
  const latest = new Map<string, (typeof rows)[number]>();
  for (const a of rows) latest.set(a.listingId, a);
  const cur = [...latest.values()];
  if (!cur.length) return;
  const status = cur.some((a) => a.status === "queued" || a.status === "running")
    ? ("running" as const)
    : cur.every((a) => a.status === "failed")
      ? ("failed" as const)
      : cur.some((a) => a.status === "failed")
        ? ("partial_success" as const)
        : ("succeeded" as const);
  await db
    .update(publishRuns)
    .set({ status, updatedAt: new Date() })
    .where(eq(publishRuns.id, runId));
}

/** attempt 终态落库 + 聚合所属 run。 */
async function finishAttempt(
  db: Db,
  attemptId: string,
  patch: {
    status: "succeeded" | "failed";
    error?: string | null;
    remoteId?: string | null;
    remoteUrl?: string | null;
    jobId?: string | null;
  },
) {
  const errorCode = patch.error ? normalizePublishError(patch.error) : null;
  const [row] = await db
    .update(publishAttempts)
    .set({
      status: patch.status,
      error: patch.error ?? null,
      errorCode,
      remoteId: patch.remoteId ?? undefined,
      remoteUrl: patch.remoteUrl ?? undefined,
      jobId: patch.jobId ?? undefined,
      updatedAt: new Date(),
    })
    .where(eq(publishAttempts.id, attemptId))
    .returning({ runId: publishAttempts.runId });
  if (row) await aggregatePublishRun(db, row.runId);
}

/**
 * 远端快照差异 → 刊登托管字段。只标记漂移，绝不自动覆盖本地或远端；
 * 唯一例外是 syncPolicy.stock === "auto" 时的库存推送（写 lastAutoAction + 审计）。
 */
async function applyRemoteSnapshot(
  deps: Deps,
  store: typeof stores.$inferSelect,
  listing: typeof listings.$inferSelect,
  snap: RemoteSnapshot | null,
) {
  const now = new Date();
  if (!snap) {
    // 远端不存在 → 标 remote_deleted，不本地硬删
    if (listing.linkStatus !== "remote_deleted") {
      await audit(deps.db, listing.workspaceId, {
        actor: "system:sync",
        action: "listing.remote_marked_deleted",
        entityType: "listing",
        entityId: listing.id,
        payload: { remoteId: listing.remoteId },
      });
    }
    await deps.db
      .update(listings)
      .set({
        remoteStatus: "DELETED",
        linkStatus: "remote_deleted",
        remoteDrift: [],
        remoteSnapshot: null,
        lastPulledAt: now,
        syncedAt: now,
      })
      .where(eq(listings.id, listing.id));
    return;
  }

  // 策略 off 的类别不记录漂移（如 price=off 的商家在 Shopify 改价不算"不一致"）
  let drift = filterDriftByPolicy(computeDrift(listing, snap), listing.syncPolicy);
  const patch: Partial<typeof listings.$inferSelect> = {
    remoteStatus: snap.status,
    linkStatus: "linked",
    remoteSnapshot: snap,
    remoteDrift: drift,
    lastPulledAt: now,
    syncedAt: now,
  };

  // 库存自动推送：唯一的自动写远端路径，必须有痕（lastAutoAction + audit）；
  // 需店铺开启「同步货源库存」（未开启的变体没有 tracked inventoryItem，写了也失败）
  const adapter = adapterFor(store.platform);
  if (
    drift.some((d) => d.field === "stock") &&
    listing.syncPolicy.stock === "auto" &&
    store.rules?.trackStock &&
    adapter.pushStock
  ) {
    const at = new Date().toISOString();
    let warn: string | null = null;
    try {
      warn = await adapter.pushStock(deps, store, snap.remoteId, listing.variants);
    } catch (e) {
      warn = e instanceof Error ? e.message : String(e);
    }
    patch.lastAutoAction = {
      action: "stock_push",
      at,
      detail: warn
        ? { ok: false, error: warn }
        : { ok: true, variants: listing.variants.length },
    };
    await audit(deps.db, listing.workspaceId, {
      actor: "system:sync",
      action: "listing.auto_stock_push",
      entityType: "listing",
      entityId: listing.id,
      payload: { remoteId: snap.remoteId, ok: !warn, error: warn ?? undefined },
    });
    if (!warn) {
      drift = drift.filter((d) => d.field !== "stock");
      patch.remoteDrift = drift;
      // 快照回写用与 pushStock 相同的 SKU 对齐（位置对齐会在远端重排时记错变体库存）
      patch.remoteSnapshot = {
        ...snap,
        variants: snap.variants?.map((rv, ri) => {
          const lv = rv.sku
            ? listing.variants.find((v) => v.sku === rv.sku)
            : listing.variants[ri]?.sku
              ? undefined
              : listing.variants[ri];
          return lv ? { ...rv, stock: lv.stock ?? rv.stock } : rv;
        }),
      };
    }
  }
  await deps.db.update(listings).set(patch).where(eq(listings.id, listing.id));
}

/** Pull channel-side status/snapshots of every linked listing of a store. */
const syncStore: JobHandler = {
  async run(deps: Deps, job) {
    const [store] = await deps.db
      .select()
      .from(stores)
      .where(eq(stores.id, String(job.payload.storeId)));
    if (!store || store.status === "disconnected") return;
    const rows = await deps.db
      .select()
      .from(listings)
      .where(
        and(
          eq(listings.storeId, store.id),
          eq(listings.workspaceId, store.workspaceId),
          isNotNull(listings.remoteId),
        ),
      );
    if (!rows.length) return;
    const adapter = adapterFor(store.platform);
    const now = new Date();

    if (adapter.fetchRemoteSnapshots) {
      const snaps = await adapter.fetchRemoteSnapshots(
        deps,
        store,
        rows.map((r) => r.remoteId!),
      );
      for (const l of rows) {
        await applyRemoteSnapshot(deps, store, l, snaps.get(l.remoteId!) ?? null);
      }
      return;
    }

    // adapter 无快照能力：退回只拉状态
    const statuses = await adapter.fetchStatuses(deps, store, rows.map((r) => r.remoteId!));
    for (const r of rows) {
      const remoteStatus = statuses.get(r.remoteId!);
      if (!remoteStatus) continue;
      if (remoteStatus === "DELETED" && r.linkStatus !== "remote_deleted") {
        await audit(deps.db, r.workspaceId, {
          actor: "system:sync",
          action: "listing.remote_marked_deleted",
          entityType: "listing",
          entityId: r.id,
          payload: { remoteId: r.remoteId },
        });
      }
      await deps.db
        .update(listings)
        .set({
          remoteStatus,
          linkStatus: remoteStatus === "DELETED" ? "remote_deleted" : "linked",
          syncedAt: now,
          lastPulledAt: now,
        })
        .where(eq(listings.id, r.id));
    }
  },
};

/** Copy a source item's images (main + desc) the extension didn't upload. */
const fetchMissingMedia: JobHandler = {
  async run(deps: Deps, job) {
    const [item] = await deps.db
      .select()
      .from(sourceItems)
      .where(eq(sourceItems.id, String(job.payload.sourceItemId)));
    if (!item) return;
    const all = [...item.images, ...item.descImages];
    const have = await resolveSources(deps.db, item.workspaceId, all);
    const failed: string[] = [];
    for (const url of all.filter((u) => !have.has(u))) {
      await fetchAndStore(deps, item.workspaceId, url).catch(() => failed.push(url));
    }
    if (failed.length) throw new Error(`${failed.length} 张图片下载失败`);
  },
};

const publishListing: JobHandler = {
  async run(deps: Deps, job) {
    const listingId = String(job.payload.listingId);
    const attemptId =
      typeof job.payload.attemptId === "string" ? job.payload.attemptId : undefined;
    const [row] = await deps.db
      .select({ listing: listings, store: stores, item: sourceItems })
      .from(listings)
      .innerJoin(stores, eq(stores.id, listings.storeId))
      .innerJoin(sourceItems, eq(sourceItems.id, listings.sourceItemId))
      .where(eq(listings.id, listingId));
    if (!row) throw new PermanentJobError("刊登记录已删除");
    if (row.store.status === "disconnected") throw new PermanentJobError("店铺已断开授权");
    if (attemptId) {
      // 同一刊登同时只允许一个发布 job：按 id 取最小者优先，保证并发时恰有一个继续、
      // 其余跳过（对称地互相排除会让所有 job 都跳过、刊登卡在 publishing）
      const [conflict] = await deps.db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            eq(jobs.type, PUBLISH_LISTING),
            inArray(jobs.status, ["queued", "running"]),
            sql`${jobs.payload}->>'listingId' = ${listingId}`,
            lt(jobs.id, job.id),
          ),
        )
        .limit(1);
      if (conflict) {
        await finishAttempt(deps.db, attemptId, {
          status: "failed",
          error: "该刊登已有另一个发布任务在执行，本次发布已跳过",
          jobId: job.id,
        });
        return;
      }
      await deps.db
        .update(publishAttempts)
        .set({ status: "running", jobId: job.id, updatedAt: new Date() })
        .where(eq(publishAttempts.id, attemptId));
    }
    const adapter = adapterFor(row.store.platform);
    // 发布门禁（绕过端点的路径也要拦）：平台结构化校验 + 店铺禁售词
    const issues = await adapter.validate(deps, row.store, row.listing);
    const blocking = issues.filter((i) => (i.severity ?? "block") === "block");
    if (blocking.length) {
      throw new PermanentJobError(blocking.map((i) => i.message).join("；"));
    }
    const banned = findBannedWords(row.listing, row.store.rules?.bannedWords);
    if (banned.length) {
      throw new PermanentJobError(`发布前检查未通过，含禁售词：${banned.join("、")}`);
    }

    let listing = row.listing;
    // 已有 remoteId 的更新发布：先拉远端快照记录漂移，再执行用户明确的覆盖发布
    if (listing.remoteId && listing.remoteStatus !== "DELETED" && adapter.fetchRemoteSnapshots) {
      const snaps = await adapter
        .fetchRemoteSnapshots(deps, row.store, [listing.remoteId])
        .catch(() => null);
      if (snaps) {
        const snap = snaps.get(listing.remoteId) ?? null;
        const now = new Date();
        if (!snap) {
          // 远端已删 → 按新建处理
          await deps.db
            .update(listings)
            .set({
              remoteStatus: "DELETED",
              linkStatus: "remote_deleted",
              remoteSnapshot: null,
              remoteDrift: [],
              lastPulledAt: now,
              syncedAt: now,
            })
            .where(eq(listings.id, listingId));
          listing = { ...listing, remoteId: null, remoteStatus: "DELETED" };
        } else {
          await deps.db
            .update(listings)
            .set({
              remoteStatus: snap.status,
              linkStatus: "linked",
              remoteSnapshot: snap,
              remoteDrift: filterDriftByPolicy(computeDrift(listing, snap), listing.syncPolicy),
              lastPulledAt: now,
              syncedAt: now,
            })
            .where(eq(listings.id, listingId));
          // 同步内存状态：更新发布时 adapter 不回报 remoteStatus，快照兜底要用刚拉到的值
          listing = { ...listing, remoteStatus: snap.status };
        }
      }
    }
    // deleted on the channel → publish as a new product
    if (listing.remoteStatus === "DELETED") listing = { ...listing, remoteId: null };
    // 类目兜底：刊登没设类目但已有确认映射（如接受建议前直接发布），套用并回写
    if (!listing.channelCategoryId && row.item.sourceCategoryId) {
      const m = await resolveCategoryMapping(
        deps.db,
        listing.workspaceId,
        row.item.sourcePlatform as SourcePlatform,
        row.item.sourceCategoryId,
        row.store.platform,
      );
      if (m) {
        listing = {
          ...listing,
          channelCategoryId: m.channelCategoryId,
          channelCategoryName: m.channelCategoryName,
        };
        await deps.db
          .update(listings)
          .set({
            channelCategoryId: m.channelCategoryId,
            channelCategoryName: m.channelCategoryName,
          })
          .where(eq(listings.id, listingId));
      }
    }
    const result = await adapter.publish(deps, row.store, listing);
    const now = new Date();
    await deps.db
      .update(listings)
      .set({
        status: "published",
        remoteId: result.remoteId,
        remoteUrl: result.remoteUrl,
        linkStatus: "linked",
        remoteSnapshot: pushedSnapshot(
          listing,
          result.remoteId,
          // 更新发布时 adapter 不回报状态（远端草稿态保持）——沿用已有记录而不是默认 ACTIVE
          result.remoteStatus ?? listing.remoteStatus ?? undefined,
        ),
        remoteDrift: [],
        ...(result.remoteStatus ? { remoteStatus: result.remoteStatus, syncedAt: now } : {}),
        lastError: result.warnings?.length ? result.warnings.join("；") : null,
        publishedAt: now,
      })
      .where(eq(listings.id, listingId));
    if (attemptId) {
      await finishAttempt(deps.db, attemptId, {
        status: "succeeded",
        remoteId: result.remoteId,
        remoteUrl: result.remoteUrl,
      });
    }
    const [attempt] = attemptId
      ? await deps.db
          .select({ runId: publishAttempts.runId })
          .from(publishAttempts)
          .where(eq(publishAttempts.id, attemptId))
      : [];
    await audit(deps.db, listing.workspaceId, {
      actor: "user",
      action: "listing.publish",
      entityType: "listing",
      entityId: listingId,
      payload: {
        remoteId: result.remoteId,
        remoteUrl: result.remoteUrl,
        attemptId: attemptId ?? null,
        runId: attempt?.runId ?? null,
        warnings: result.warnings?.length ? result.warnings : undefined,
      },
    });
  },
  async onFailed(deps, job, error) {
    const listingId = String(job.payload.listingId);
    await deps.db
      .update(listings)
      .set({ status: "failed", lastError: error })
      .where(and(eq(listings.id, listingId), eq(listings.status, "publishing")));
    const attemptId =
      typeof job.payload.attemptId === "string" ? job.payload.attemptId : undefined;
    if (attemptId) {
      await finishAttempt(deps.db, attemptId, { status: "failed", error });
      const [l] = await deps.db
        .select({ workspaceId: listings.workspaceId })
        .from(listings)
        .where(eq(listings.id, listingId));
      if (l) {
        await audit(deps.db, l.workspaceId, {
          actor: "user",
          action: "listing.publish_failed",
          entityType: "listing",
          entityId: listingId,
          payload: {
            attemptId,
            error,
            errorCode: normalizePublishError(error),
          },
        });
      }
    }
  },
};

/**
 * 货源库存变化 → 只推远端库存（adapter.pushStock），不做全量 productSet，
 * 避免覆盖商家在平台上改过的标题/描述。adapter 无该能力时退回全量发布
 * 并明确审计标注为兜底覆盖。自动动作必须写 lastAutoAction + audit。
 */
const pushStockJob: JobHandler = {
  async run(deps: Deps, job) {
    const listingId = String(job.payload.listingId);
    const [row] = await deps.db
      .select({ listing: listings, store: stores })
      .from(listings)
      .innerJoin(stores, eq(stores.id, listings.storeId))
      .where(eq(listings.id, listingId));
    if (!row) return; // 刊登已删：无事可做
    const { listing, store } = row;
    if (store.status === "disconnected") throw new PermanentJobError("店铺已断开授权");
    if (!listing.remoteId || listing.remoteStatus === "DELETED") return;
    // 已入队的也尊重当前策略：店铺未追踪库存或刊登 stock 策略非 auto 时跳过
    if (!store.rules?.trackStock || listing.syncPolicy.stock !== "auto") return;
    const adapter = adapterFor(store.platform);
    const at = new Date().toISOString();
    if (!adapter.pushStock) {
      // 兜底：平台不支持库存单推 → 全量发布（明确标注为覆盖式兜底）
      await deps.db
        .update(listings)
        .set({ status: "publishing", lastError: null })
        .where(eq(listings.id, listingId));
      await enqueue(deps.db, PUBLISH_LISTING, { listingId }, { workspaceId: listing.workspaceId });
      await deps.db
        .update(listings)
        .set({
          lastAutoAction: {
            action: "stock_push_fallback_publish",
            at,
            detail: { reason: "adapter 无 pushStock 能力，退回全量发布" },
          },
        })
        .where(eq(listings.id, listingId));
      await audit(deps.db, listing.workspaceId, {
        actor: "system",
        action: "listing.auto_stock_push_fallback",
        entityType: "listing",
        entityId: listingId,
        payload: { remoteId: listing.remoteId, mode: "full_publish" },
      });
      return;
    }
    const warn = await adapter.pushStock(deps, store, listing.remoteId, listing.variants);
    await deps.db
      .update(listings)
      .set({
        lastAutoAction: {
          action: "stock_push",
          at,
          detail: warn
            ? { ok: false, error: warn, source: "source_item_update" }
            : { ok: true, variants: listing.variants.length, source: "source_item_update" },
        },
      })
      .where(eq(listings.id, listingId));
    await audit(deps.db, listing.workspaceId, {
      actor: "system",
      action: "listing.auto_stock_push",
      entityType: "listing",
      entityId: listingId,
      payload: {
        remoteId: listing.remoteId,
        ok: !warn,
        error: warn ?? undefined,
        source: "source_item_update",
      },
    });
    if (warn) throw new Error(warn); // 让 job 记一次可见失败（可重试），业务行已留痕
  },
};

/** Unpublish on the channel (Shopify → DRAFT): remote keeps existing, ERP 记录保留。
 *  刊登本身保持 published 状态——remoteStatus 反映「已下架」。 */
const delistListing: JobHandler = {
  async run(deps: Deps, job) {
    const listingId = String(job.payload.listingId);
    const [row] = await deps.db
      .select({ listing: listings, store: stores })
      .from(listings)
      .innerJoin(stores, eq(stores.id, listings.storeId))
      .where(eq(listings.id, listingId));
    if (!row) throw new PermanentJobError("刊登记录已删除");
    if (row.store.status === "disconnected") throw new PermanentJobError("店铺已断开授权");
    if (!row.listing.remoteId) {
      await deps.db
        .update(listings)
        .set({ remoteStatus: "DRAFT", syncedAt: new Date(), lastError: null })
        .where(eq(listings.id, listingId));
      return;
    }
    const adapter = adapterFor(row.store.platform);
    if (!adapter.delistProduct) throw new PermanentJobError("该平台不支持下架");
    await adapter.delistProduct(deps, row.store, row.listing.remoteId);
    await deps.db
      .update(listings)
      .set({ remoteStatus: "DRAFT", syncedAt: new Date(), lastError: null })
      .where(eq(listings.id, listingId));
  },
  async onFailed(deps, job, error) {
    // 保持 published 状态，只留错误信息（lastError 让「已发布」Tag 变黄）
    await deps.db
      .update(listings)
      .set({ lastError: error })
      .where(eq(listings.id, String(job.payload.listingId)));
  },
};

/** Pull the platform's category tree into channel_categories (低频、版本化缓存). */
const syncCategories: JobHandler = {
  async run(deps: Deps, job) {
    const [store] = await deps.db
      .select()
      .from(stores)
      .where(eq(stores.id, String(job.payload.storeId)));
    if (!store || store.status === "disconnected") return;
    const adapter = adapterFor(store.platform);
    if (!adapter.syncCategoryTree) return;
    await adapter.syncCategoryTree(deps, store);
  },
};

const aiEnhance: JobHandler = {
  async run(deps: Deps, job) {
    await runAiEnhance(deps, String(job.payload.listingId));
  },
};

const categorySuggest: JobHandler = {
  async run(deps: Deps, job) {
    await runCategorySuggest(deps, String(job.payload.listingId));
  },
};

export const jobHandlers: Record<string, JobHandler> = {
  [PUBLISH_LISTING]: publishListing,
  [PUSH_STOCK]: pushStockJob,
  [FETCH_MISSING_MEDIA]: fetchMissingMedia,
  [SYNC_STORE]: syncStore,
  [AI_ENHANCE_LISTING]: aiEnhance,
  [CATEGORY_SUGGEST]: categorySuggest,
  [SYNC_CATEGORIES]: syncCategories,
  [DELIST_LISTING]: delistListing,
};
