import { and, asc, eq, inArray, isNotNull, lt, ne, sql } from "drizzle-orm";
import type { PipelinePolicy, RemoteSnapshot, SourcePlatform } from "@caiji/shared";
import { runStages } from "../ai/stages/index.js";
import { adapterFor } from "../channels/index.js";
import type { ListingRow } from "../channels/types.js";
import type { Deps } from "../context.js";
import type { Db } from "../db/client.js";
import {
  jobs,
  listings,
  listingSuggestions,
  orderItems,
  orders,
  publishAttempts,
  publishRuns,
  shipments,
  sourceItems,
  stores,
} from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { resolveCategoryMapping } from "../lib/category.js";
import { claimItems } from "../lib/claim.js";
import { refreshOrderStatus, upsertRemoteOrder } from "../lib/orders.js";
import { isSourceOos, pushQuantity } from "../lib/sourceMonitor.js";
import {
  computeDrift,
  filterDriftByPolicy,
  normalizePublishError,
  pushedSnapshot,
  toFieldsSnapshot,
} from "../lib/drift.js";
import { advancePolicy, circuitOpen, nextRunAt } from "../lib/pipeline.js";
import { findBannedWords } from "../lib/rules.js";
import { acceptSuggestion } from "../lib/suggestions.js";
import { scorePlanItems } from "../lib/selection.js";
import { meteredEditImage } from "../lib/ai.js";
import {
  fetchAndStore,
  loadImage,
  mediaUrl,
  resolveSources,
  storeImage,
} from "../modules/media.js";
import { enqueue, type JobHandler, PermanentJobError } from "./queue.js";

export const PUBLISH_LISTING = "listing.publish";
export const FETCH_MISSING_MEDIA = "media.fetchMissing";
export const SYNC_STORE = "store.syncListings";
export const AI_ENHANCE_LISTING = "listing.aiEnhance";
export const CATEGORY_SUGGEST = "listing.categorySuggest";
export const SYNC_CATEGORIES = "store.syncCategories";
export const DELIST_LISTING = "listing.delist";
/** 图片 AI 编辑（如白底主图）：生成的图存进媒体库并插到原图后面。 */
export const AI_IMAGE = "listing.aiImage";
/** 只更新远端库存（货源库存变化的轻量同步，不触碰远端标题/描述/价格）。 */
export const PUSH_STOCK = "listing.pushStock";
/** 链路认领：collect 命中 autoClaim / 认领并发布的异步入口，复用 claimItems。 */
export const LISTING_CLAIM = "listing.claim";
/** 链路推进：autoAccept → holdPoint → precheck → autoPublish（pace/scheduled 顺延）。 */
export const PIPELINE_ADVANCE = "pipeline.advance";
/** 只更新远端价格（货源改价按店铺定价规则重算后推送）。 */
export const PUSH_PRICE = "listing.pushPrice";
/** 每日兜底：按店铺 inventory 策略重算所有已发布刊登的推送库存。 */
export const RECONCILE_INVENTORY = "inventory.reconcile";
/** 订单增量/单条同步（webhook 只入队，worker 内拉最新单）。 */
export const ORDER_SYNC = "order.sync";
/** 订单行项 → 刊登/货源映射（remoteVariantId → sku → 人工 bind）。 */
export const ORDER_MAP = "order.map";
/** 履约回传（fulfillmentOrders → fulfillmentCreate 写 trackingInfo）。 */
export const FULFILL_PUSH = "fulfill.push";
/** 选品候选打分：确定性信号分 + top-20 LLM 评语。 */
export const SELECTION_SCORE = "selection.score";

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

/** Queue a pipeline advance for a listing unless one is already waiting/running.
 *  已有排队任务时把 manual 合并进去（手动推进不能因自动推进在排而丢）。 */
export async function enqueuePipelineAdvance(
  db: Db,
  listingId: string,
  workspaceId: string,
  opts: { manual?: boolean } = {},
) {
  const [pending] = await db
    .select({ id: jobs.id, payload: jobs.payload })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, PIPELINE_ADVANCE),
        inArray(jobs.status, ["queued", "running"]),
        sql`${jobs.payload}->>'listingId' = ${listingId}`,
      ),
    )
    .limit(1);
  if (pending) {
    if (opts.manual && pending.payload.manual !== true) {
      await db
        .update(jobs)
        .set({ payload: { ...pending.payload, manual: true }, updatedAt: new Date() })
        .where(eq(jobs.id, pending.id));
    }
    return false;
  }
  await enqueue(
    db,
    PIPELINE_ADVANCE,
    { listingId, manual: !!opts.manual },
    { workspaceId, maxAttempts: 2 },
  );
  return true;
}

/** Queue a claim for (sourceItem × store) unless one is already waiting/running. */
export async function enqueueListingClaim(
  db: Db,
  payload: { sourceItemId: string; storeId: string; advance?: boolean },
  workspaceId: string,
) {
  const [pending] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, LISTING_CLAIM),
        inArray(jobs.status, ["queued", "running"]),
        sql`${jobs.payload}->>'sourceItemId' = ${payload.sourceItemId}`,
        sql`${jobs.payload}->>'storeId' = ${payload.storeId}`,
      ),
    )
    .limit(1);
  if (pending) return false;
  await enqueue(db, LISTING_CLAIM, payload, { workspaceId, maxAttempts: 3 });
  return true;
}

/**
 * 让刊登进入链路：写 stage=claimed + 策略快照（审计「为什么自动发了」）+ 排队 AI 产线。
 * AI 无论开关都排——job 尾负责 enqueue advance，AI 关闭时链路跳过产线直接推进。
 * 已在链路（stage 非空）不重复入场；返回是否入场成功。
 */
export async function enterPipeline(
  db: Db,
  listingId: string,
  policy: PipelinePolicy,
): Promise<boolean> {
  const [row] = await db
    .update(listings)
    .set({
      pipelineStage: "claimed",
      pipelineHoldReason: null,
      policySnapshot: policy,
      publishAt:
        policy.publishMode === "scheduled" && policy.publishAt
          ? new Date(policy.publishAt)
          : null,
    })
    .where(and(eq(listings.id, listingId), sql`${listings.pipelineStage} is null`))
    .returning({ id: listings.id, workspaceId: listings.workspaceId });
  if (!row) return false;
  await enqueueAiEnhance(db, [listingId], row.workspaceId);
  return true;
}

/** 撤销 stage=queued 刊登排队中的发布：job 置 failed（不会被执行），attempt 记失败并聚合 run。 */
export async function dequeueQueuedPublish(db: Db, listingId: string): Promise<boolean> {
  const pending = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, PUBLISH_LISTING),
        eq(jobs.status, "queued"),
        sql`${jobs.payload}->>'listingId' = ${listingId}`,
      ),
    );
  if (!pending.length) return false;
  await db
    .update(jobs)
    .set({ status: "failed", lastError: "链路操作取消了排队中的发布", updatedAt: new Date() })
    .where(
      inArray(
        jobs.id,
        pending.map((p) => p.id),
      ),
    );
  const atts = await db
    .select({ id: publishAttempts.id })
    .from(publishAttempts)
    .where(
      and(eq(publishAttempts.listingId, listingId), eq(publishAttempts.status, "queued")),
    );
  for (const a of atts) {
    await finishAttempt(db, a.id, { status: "failed", error: "链路操作已取消排队中的发布" });
  }
  return true;
}

/** Queue an AI image edit for one listing image (dedup on listing+url+action). */
export async function enqueueAiImage(
  db: Db,
  listingId: string,
  workspaceId: string,
  imageUrl: string,
  action: string,
) {
  const pending = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, AI_IMAGE),
        inArray(jobs.status, ["queued", "running"]),
        eq(sql`${jobs.payload}->>'listingId'`, listingId),
        eq(sql`${jobs.payload}->>'imageUrl'`, imageUrl),
        eq(sql`${jobs.payload}->>'action'`, action),
      ),
    );
  if (pending.length) return false;
  await enqueue(db, AI_IMAGE, { listingId, imageUrl, action }, { workspaceId, maxAttempts: 1 });
  return true;
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

/** Queue a selection scoring pass unless one for the same plan is waiting/running. */
export async function enqueueSelectionScore(
  db: Db,
  workspaceId: string,
  planId: string | null,
) {
  const key = planId ?? "";
  const [pending] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.workspaceId, workspaceId),
        eq(jobs.type, SELECTION_SCORE),
        inArray(jobs.status, ["queued", "running"]),
        sql`coalesce(${jobs.payload}->>'planId', '') = ${key}`,
      ),
    )
    .limit(1);
  if (pending) return false;
  await enqueue(db, SELECTION_SCORE, { planId }, { workspaceId, maxAttempts: 1 });
  return true;
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

/**
 * Queue an order sync for a store unless an identical one is waiting/running.
 * remoteId 给了就只拉那一单（webhook 路径），否则按 stores.ordersCursor 增量拉。
 * webhook 风暴下同参数去重，避免队列堆积。
 */
export async function enqueueOrderSync(
  db: Db,
  storeId: string,
  workspaceId: string,
  remoteId?: string,
) {
  const dup = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, ORDER_SYNC),
        inArray(jobs.status, ["queued", "running"]),
        sql`${jobs.payload}->>'storeId' = ${storeId}`,
        remoteId
          ? sql`${jobs.payload}->>'remoteId' = ${remoteId}`
          : sql`${jobs.payload}->>'remoteId' is null`,
      ),
    )
    .limit(1);
  if (dup.length) return;
  await enqueue(
    db,
    ORDER_SYNC,
    remoteId ? { storeId, remoteId } : { storeId },
    { workspaceId },
  );
}

/** Queue an order.map pass for one order (or all open orders of a store). */
export async function enqueueOrderMap(
  db: Db,
  payload: { orderId?: string; storeId?: string },
  workspaceId: string,
) {
  const [dup] = await db
    .select({ id: jobs.id })
    .from(jobs)
    .where(
      and(
        eq(jobs.type, ORDER_MAP),
        inArray(jobs.status, ["queued", "running"]),
        payload.orderId
          ? sql`${jobs.payload}->>'orderId' = ${payload.orderId}`
          : sql`${jobs.payload}->>'storeId' = ${payload.storeId ?? ""}`,
      ),
    )
    .limit(1);
  if (dup) return;
  await enqueue(db, ORDER_MAP, payload, { workspaceId, maxAttempts: 2 });
}

/** Queue a fulfillment push for one shipment row. */
export async function enqueueFulfillPush(db: Db, shipmentId: string, workspaceId: string) {
  await enqueue(db, FULFILL_PUSH, { shipmentId }, { workspaceId, maxAttempts: 3 });
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
    // 正式开跑：链路 queued → publishing；排队发布的草稿态到这一步才转 publishing
    // （paced/scheduled 顺延期间刊登仍可编辑）。
    await deps.db
      .update(listings)
      .set({
        status: "publishing",
        pipelineStage: sql`case when ${listings.pipelineStage} = 'queued' then 'publishing' else ${listings.pipelineStage} end`,
      })
      .where(
        and(eq(listings.id, listingId), inArray(listings.status, ["draft", "publishing"])),
      );
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
        // 本地 sku ↔ 远端 variantId：订单映射的主键级键，发布成功后回填
        ...(result.remoteVariantMap ? { remoteVariantMap: result.remoteVariantMap } : {}),
        lastError: result.warnings?.length ? result.warnings.join("；") : null,
        publishedAt: now,
      })
      .where(eq(listings.id, listingId));
    // 链路刊登：发布成功即 'published'（无论从哪一环走来）
    await deps.db
      .update(listings)
      .set({ pipelineStage: "published", pipelineHoldReason: null, publishAt: null })
      .where(
        and(
          eq(listings.id, listingId),
          isNotNull(listings.pipelineStage),
          ne(listings.pipelineStage, "published"),
        ),
      );
    // 新变体映射就位后，该店未匹配的订单行可以再过一遍映射
    await enqueueOrderMap(deps.db, { storeId: listing.storeId }, listing.workspaceId);
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
    const [l] = await deps.db
      .select({ workspaceId: listings.workspaceId, pipelineStage: listings.pipelineStage })
      .from(listings)
      .where(eq(listings.id, listingId));
    if (l?.pipelineStage && l.pipelineStage !== "published") {
      // 链路刊登：发布失败 → failed + 原因（含排队发布的草稿态）
      await deps.db
        .update(listings)
        .set({ pipelineStage: "failed", pipelineHoldReason: error })
        .where(and(eq(listings.id, listingId), ne(listings.pipelineStage, "published")));
      // 熔断统计基于 attempt：本轮失败计入当日失败率（触发落一次 audit）
      await circuitOpen(deps.db, l.workspaceId, listingId);
    }
    const attemptId =
      typeof job.payload.attemptId === "string" ? job.payload.attemptId : undefined;
    if (attemptId) {
      await finishAttempt(deps.db, attemptId, { status: "failed", error });
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
    // 已入队的也尊重当前策略：店铺未追踪库存或刊登 stock 策略非 auto 时跳过；
    // force=售罄清零（oosAction=zero）是店铺级明确配置，不受刊登策略拦截
    const force = job.payload.force === true;
    // manual=用户在变更列表点了「应用」：明确意图，绕过自动策略门禁
    const manual = job.payload.manual === true;
    if (!force && !manual && (!store.rules?.trackStock || listing.syncPolicy.stock !== "auto")) return;
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

/** stage 注册表入口：跑全部启用 stage（enhance + categorySuggest + …），尾端推进链路。 */
const aiEnhance: JobHandler = {
  async run(deps: Deps, job) {
    const listingId = String(job.payload.listingId);
    await deps.db
      .update(listings)
      .set({ pipelineStage: "ai_running" })
      .where(and(eq(listings.id, listingId), eq(listings.pipelineStage, "claimed")));
    await runStages(deps, listingId);
    // AI 产线是链路的第二站：跑完入下一环（空/终态/排队中都不是链路在跑，不推进）
    const [l] = await deps.db
      .select({ workspaceId: listings.workspaceId, pipelineStage: listings.pipelineStage })
      .from(listings)
      .where(eq(listings.id, listingId));
    if (
      l?.pipelineStage &&
      !["published", "failed", "queued", "publishing"].includes(l.pipelineStage)
    ) {
      await enqueuePipelineAdvance(deps.db, listingId, l.workspaceId);
    }
  },
  async onFailed(deps, job, error) {
    const listingId = String(job.payload.listingId);
    await deps.db
      .update(listings)
      .set({ pipelineStage: "failed", pipelineHoldReason: error })
      .where(
        and(
          eq(listings.id, listingId),
          inArray(listings.pipelineStage, [
            "claimed",
            "ai_running",
            "hold_ai",
            "precheck",
            "hold_precheck",
          ]),
        ),
      );
  },
};

const categorySuggest: JobHandler = {
  async run(deps: Deps, job) {
    await runStages(deps, String(job.payload.listingId), { only: "categorySuggest" });
  },
};

/** 链路认领：collect 命中 autoClaim 的异步入口。复用 claimItems；已有刊登不重建、不重复入场。 */
const listingClaim: JobHandler = {
  async run(deps: Deps, job) {
    const sourceItemId = String(job.payload.sourceItemId);
    const storeId = String(job.payload.storeId);
    const advance = job.payload.advance === true;
    const [[item], [store]] = await Promise.all([
      deps.db.select().from(sourceItems).where(eq(sourceItems.id, sourceItemId)),
      deps.db.select().from(stores).where(eq(stores.id, storeId)),
    ]);
    if (!item || !store || store.status === "disconnected") return;
    if (item.workspaceId !== store.workspaceId) return; // 防御：不该发生
    const created = await claimItems(deps.db, item.workspaceId, [item], [store]);
    let listingId = created[0]?.id;
    if (!listingId) {
      const [l] = await deps.db
        .select({ id: listings.id, pipelineStage: listings.pipelineStage })
        .from(listings)
        .where(and(eq(listings.storeId, storeId), eq(listings.sourceItemId, sourceItemId)));
      listingId = l?.id;
      if (!listingId) return; // 预处理规则下没有刊登可进链路（如价格全被过滤）
      if (l!.pipelineStage) return; // 已在链路：autoClaim 幂等，不重复入场
    }
    const policy = advance ? advancePolicy(store.rules?.pipeline) : store.rules?.pipeline;
    if (policy) {
      await enterPipeline(deps.db, listingId, policy); // 内含 AI 产线排队（链路驱动）
    } else if (created[0] && store.aiEnhance !== "off" && deps.config.ai) {
      await enqueueAiEnhance(deps.db, [listingId], item.workspaceId);
    }
  },
};

/**
 * pipeline.advance：autoAccept 白名单（复用 decide 的 apply+学习钩子）→ holdPoint →
 * precheck（与发布同一道门禁）→ autoPublish（带熔断 + pace/scheduled 顺延）。
 * payload.manual=人工推进：越过所有 hold 与熔断，queued 时提前放行发布。
 */
const pipelineAdvance: JobHandler = {
  async run(deps: Deps, job) {
    const listingId = String(job.payload.listingId);
    const manual = job.payload.manual === true;
    const [row] = await deps.db
      .select({ listing: listings, store: stores, item: sourceItems })
      .from(listings)
      .innerJoin(stores, eq(stores.id, listings.storeId))
      .innerJoin(sourceItems, eq(sourceItems.id, listings.sourceItemId))
      .where(eq(listings.id, listingId));
    if (!row) return; // 刊登已删
    let { listing } = row;
    const { store, item } = row;
    if (!listing.pipelineStage) return;
    if (store.status === "disconnected") throw new PermanentJobError("店铺已断开授权");
    // 手动暂停：仅手动推进放行
    if (listing.pipelineHoldReason === "manual" && !manual) return;
    // 发布 job 已接管
    if (listing.pipelineStage === "publishing") return;
    if (listing.pipelineStage === "queued") {
      if (!manual) return;
      // 手动推进 = 提前放行排队中的发布（publishAt/scheduled 作废）
      await deps.db
        .update(jobs)
        .set({ runAt: new Date() })
        .where(
          and(
            eq(jobs.type, PUBLISH_LISTING),
            eq(jobs.status, "queued"),
            sql`${jobs.payload}->>'listingId' = ${listingId}`,
          ),
        );
      await deps.db
        .update(listings)
        .set({ publishAt: null })
        .where(eq(listings.id, listingId));
      return;
    }
    if (manual && listing.pipelineHoldReason === "manual") {
      await deps.db
        .update(listings)
        .set({ pipelineHoldReason: null })
        .where(eq(listings.id, listingId));
      listing = { ...listing, pipelineHoldReason: null };
    }

    // 策略快照兜底：老链路行没有快照时回落当前店铺配置并固化
    const policy: PipelinePolicy = listing.policySnapshot ?? store.rules?.pipeline ?? {};
    if (!listing.policySnapshot) {
      await deps.db
        .update(listings)
        .set({ policySnapshot: policy })
        .where(eq(listings.id, listingId));
      listing = { ...listing, policySnapshot: policy };
    }
    const setStage = async (
      stage: NonNullable<typeof listing.pipelineStage>,
      holdReason: string | null = null,
    ) => {
      await deps.db
        .update(listings)
        .set({ pipelineStage: stage, pipelineHoldReason: holdReason })
        .where(eq(listings.id, listingId));
      listing = { ...listing, pipelineStage: stage, pipelineHoldReason: holdReason };
    };

    // ① autoAccept 白名单：自动接受指定字段的 pending 建议（复用 decide 的 apply+学习钩子）
    const fields = policy.autoAcceptFields ?? [];
    if (fields.length) {
      const patch: Partial<ListingRow> = {};
      let accepted = 0;
      await deps.db.transaction(async (tx) => {
        const rows = await tx
          .select()
          .from(listingSuggestions)
          .where(
            and(
              eq(listingSuggestions.listingId, listingId),
              eq(listingSuggestions.workspaceId, listing.workspaceId),
              eq(listingSuggestions.status, "pending"),
              inArray(listingSuggestions.field, fields),
            ),
          );
        for (const s of rows) {
          try {
            Object.assign(
              patch,
              await acceptSuggestion(tx, listing, s, {
                workspaceId: listing.workspaceId,
                storePlatform: store.platform,
                storeLanguage: store.language,
                sourcePlatform: item.sourcePlatform,
                confirmedBy: "ai",
              }),
            );
            await tx
              .update(listingSuggestions)
              .set({ status: "accepted" })
              .where(eq(listingSuggestions.id, s.id));
            accepted++;
          } catch {
            // 无可用候选等不建议自动接受：留在 pending 待人工
          }
        }
        if (Object.keys(patch).length) {
          await tx.update(listings).set(patch).where(eq(listings.id, listingId));
        }
      });
      if (accepted) {
        listing = { ...listing, ...patch };
        await audit(deps.db, listing.workspaceId, {
          actor: "system",
          action: "pipeline.auto_accept",
          entityType: "listing",
          entityId: listingId,
          payload: { fields, accepted },
        });
      }
    }

    // ② holdPoint=after_ai：AI 完事后卡在人工审核
    if (!manual && policy.holdPoint === "after_ai") {
      await setStage("hold_ai", "等待人工审核 AI 建议");
      await audit(deps.db, listing.workspaceId, {
        actor: "system",
        action: "pipeline.hold",
        entityType: "listing",
        entityId: listingId,
        payload: { stage: "hold_ai" },
      });
      return;
    }

    // ③ precheck：与发布同一道门禁（adapter.validate + 禁售词）
    const adapter = adapterFor(store.platform);
    const issues = await adapter.validate(deps, store, listing);
    const blocking = issues.filter((i) => (i.severity ?? "block") === "block");
    const banned = findBannedWords(listing, store.rules?.bannedWords);
    if (blocking.length || banned.length) {
      const reason = [
        ...blocking.map((i) => i.message),
        ...(banned.length ? [`含禁售词：${banned.join("、")}`] : []),
      ].join("；");
      await setStage("failed", reason);
      await audit(deps.db, listing.workspaceId, {
        actor: "system",
        action: "pipeline.precheck_failed",
        entityType: "listing",
        entityId: listingId,
        payload: {
          issues: blocking.map((i) => ({ code: i.code, message: i.message })),
          banned,
        },
      });
      return;
    }
    const warnings = issues.filter((i) => i.severity === "warn").map((i) => i.message);
    if (!manual && warnings.length && policy.holdOnWarning) {
      await setStage("hold_precheck", `门禁告警待确认：${warnings.join("；")}`);
      await audit(deps.db, listing.workspaceId, {
        actor: "system",
        action: "pipeline.hold",
        entityType: "listing",
        entityId: listingId,
        payload: { stage: "hold_precheck", warnings },
      });
      return;
    }
    if (!manual && policy.holdPoint === "after_precheck") {
      await setStage("hold_precheck", "发布前检查通过，待人工确认");
      await audit(deps.db, listing.workspaceId, {
        actor: "system",
        action: "pipeline.hold",
        entityType: "listing",
        entityId: listingId,
        payload: { stage: "hold_precheck", warnings },
      });
      return;
    }
    // ④ autoPublish 关：链路停在 precheck 待人工推进
    if (!manual && !policy.autoPublish) {
      await setStage("precheck", null);
      return;
    }
    // ⑤ 熔断：当日失败率 >50% 且样本 >5 → 自动发布停排（手动推进可越过）
    if (!manual && (await circuitOpen(deps.db, listing.workspaceId, listingId))) {
      await setStage("hold_precheck", "当日自动发布失败率过高，已熔断（可人工推进）");
      return;
    }
    // ⑥ 自动发布：pace/scheduled 顺延 runAt；queued 期间保持 draft 可编辑
    const runAt = await nextRunAt(deps.db, store, listing, policy);
    const attemptId = await deps.db.transaction(async (tx) => {
      const [run] = await tx
        .insert(publishRuns)
        .values({
          workspaceId: listing.workspaceId,
          listingIds: [listingId],
          status: "queued",
        })
        .returning({ id: publishRuns.id });
      const [attempt] = await tx
        .insert(publishAttempts)
        .values({
          workspaceId: listing.workspaceId,
          runId: run!.id,
          listingId,
          storeId: store.id,
          status: "queued",
          fieldsSnapshot: toFieldsSnapshot(listing),
        })
        .returning({ id: publishAttempts.id });
      await tx
        .update(listings)
        .set({
          pipelineStage: "queued",
          pipelineHoldReason: null,
          publishAt: runAt.getTime() > Date.now() ? runAt : listing.publishAt,
          lastError: null,
        })
        .where(eq(listings.id, listingId));
      await enqueue(
        tx,
        PUBLISH_LISTING,
        { listingId, attemptId: attempt!.id, pipeline: true },
        { workspaceId: listing.workspaceId, runAt },
      );
      return attempt!.id;
    });
    listing = { ...listing, pipelineStage: "queued" };
    await audit(deps.db, listing.workspaceId, {
      actor: "system",
      action: "pipeline.publish_queued",
      entityType: "listing",
      entityId: listingId,
      payload: { attemptId, runAt: runAt.toISOString(), mode: policy.publishMode ?? "now" },
    });
  },
};

/** 图片 AI 动作的提示词；动作名留扩展空间（后续可加抠图/场景图等）。 */
const AI_IMAGE_PROMPTS: Record<string, string> = {
  whiteBg:
    "Put this product on a pure white seamless background with soft studio lighting. " +
    "Keep the product itself pixel-accurate: same shape, colors, text and labels. " +
    "No props, no text overlay, no watermark. Output a square product photo.",
};

const aiImage: JobHandler = {
  async run(deps: Deps, job) {
    const listingId = String(job.payload.listingId);
    // 按 URL 定位源图：生成期间用户可能删图/排序，下标会漂移
    const url = String(job.payload.imageUrl);
    const action = String(job.payload.action ?? "whiteBg");
    const [listing] = await deps.db
      .select()
      .from(listings)
      .where(eq(listings.id, listingId));
    if (!listing) return;
    if (!listing.images.includes(url)) {
      throw new PermanentJobError(`源图已不在刊登里：${url}`);
    }
    const img = await loadImage(deps, listing.workspaceId, url, { fetchMissing: true });
    if (!img) throw new Error(`取不到图片：${url}`);
    const prompt = AI_IMAGE_PROMPTS[action] ?? AI_IMAGE_PROMPTS.whiteBg!;
    const out = await meteredEditImage(
      deps,
      { workspaceId: listing.workspaceId, listingId },
      { image: img.bytes, contentType: img.asset.contentType, prompt },
    );
    const asset = await storeImage(
      deps,
      listing.workspaceId,
      `ai-image://${listingId}/${encodeURIComponent(url)}/${action}`,
      out,
    );
    // 写时重读最新 images：生成期间的并发编辑（删图/排序/另一个 AI 图）不能丢
    const [fresh] = await deps.db
      .select({ images: listings.images })
      .from(listings)
      .where(eq(listings.id, listingId));
    const cur = fresh?.images ?? listing.images;
    const at = cur.indexOf(url);
    const images = [...cur];
    images.splice(at >= 0 ? at + 1 : cur.length, 0, mediaUrl(asset.id));
    await deps.db.update(listings).set({ images }).where(eq(listings.id, listingId));
  },
};

/**
 * 货源改价 → 只推远端价格（adapter.pushPrices）。可选能力缺省时只记 lastAutoAction
 * +审计（不整品覆盖，避免动标题/描述）。自动动作必须有痕。
 */
const pushPriceJob: JobHandler = {
  async run(deps: Deps, job) {
    const listingId = String(job.payload.listingId);
    const [row] = await deps.db
      .select({ listing: listings, store: stores })
      .from(listings)
      .innerJoin(stores, eq(stores.id, listings.storeId))
      .where(eq(listings.id, listingId));
    if (!row) return;
    const { listing, store } = row;
    if (store.status === "disconnected") throw new PermanentJobError("店铺已断开授权");
    if (!listing.remoteId || listing.remoteStatus === "DELETED") return;
    // 入队时复核策略：监控总开关 + priceAuto + 刊登 price=auto 缺一即跳；
    // manual=用户在变更列表点了「应用」：明确意图，绕过自动策略门禁
    const manual = job.payload.manual === true;
    if (
      !manual &&
      (!store.rules?.monitor?.enabled ||
        !store.rules.monitor.priceAuto ||
        listing.syncPolicy.price !== "auto")
    ) {
      return;
    }
    const adapter = adapterFor(store.platform);
    const at = new Date().toISOString();
    if (!adapter.pushPrices) {
      await deps.db
        .update(listings)
        .set({
          lastAutoAction: {
            action: "price_push_unsupported",
            at,
            detail: { reason: "adapter 无 pushPrices 能力，仅标记" },
          },
        })
        .where(eq(listings.id, listingId));
      await audit(deps.db, listing.workspaceId, {
        actor: "system",
        action: "listing.auto_price_push_unsupported",
        entityType: "listing",
        entityId: listingId,
        payload: { remoteId: listing.remoteId },
      });
      return;
    }
    const warn = await adapter.pushPrices(deps, store, listing.remoteId, listing.variants);
    await deps.db
      .update(listings)
      .set({
        lastAutoAction: {
          action: "price_push",
          at,
          detail: warn
            ? { ok: false, error: warn }
            : { ok: true, variants: listing.variants.length },
        },
      })
      .where(eq(listings.id, listingId));
    await audit(deps.db, listing.workspaceId, {
      actor: "system",
      action: "listing.auto_price_push",
      entityType: "listing",
      entityId: listingId,
      payload: { remoteId: listing.remoteId, ok: !warn, error: warn ?? undefined },
    });
    if (warn) throw new Error(warn);
  },
};

/**
 * 仓储 L1 兜底：重扫可能漏报（插件未装/被风控），每日按 rules.inventory 策略
 * 把该店铺所有监控中刊登的推送库存重算一遍——与货源本地值不一致就刷新并推远端。
 */
const selectionScore: JobHandler = {
  async run(deps, job) {
    const planId = (job.payload.planId as string | null | undefined) ?? null;
    if (!job.workspaceId) throw new PermanentJobError("job 缺 workspaceId");
    await scorePlanItems(deps, job.workspaceId, planId);
  },
};

const reconcileInventory: JobHandler = {
  async run(deps: Deps, job) {
    const storeId = String(job.payload.storeId);
    const [store] = await deps.db
      .select()
      .from(stores)
      .where(eq(stores.id, storeId));
    if (!store || store.status === "disconnected" || !store.rules?.monitor?.enabled) {
      return;
    }
    const rows = await deps.db
      .select({ listing: listings, item: sourceItems })
      .from(listings)
      .innerJoin(sourceItems, eq(sourceItems.id, listings.sourceItemId))
      .where(
        and(
          eq(listings.storeId, store.id),
          eq(listings.workspaceId, store.workspaceId),
          isNotNull(listings.remoteId),
          ne(listings.remoteStatus, "DELETED"),
        ),
      );
    const inv = store.rules.inventory;
    const monitor = store.rules.monitor;
    let pushed = 0;
    for (const { listing, item } of rows) {
      const oos = isSourceOos(item.availability, item.skus, monitor);
      let dirty = false;
      const variants = listing.variants.map((v, i) => {
        // sourceSkuId 已绑定但货源里没了 = 该规格被供应商下架 → 不借位，按 0 处理
        const sku = v.sourceSkuId
          ? item.skus.find((s) => (s.skuId || s.spec) === v.sourceSkuId)
          : item.skus[i];
        let qty = sku
          ? pushQuantity(sku.stock, inv)
          : v.sourceSkuId
            ? 0
            : (v.stock ?? 0);
        if (oos && inv?.oosAction === "zero") qty = 0;
        if (qty !== v.stock) {
          dirty = true;
          return { ...v, stock: qty };
        }
        return v;
      });
      if (!dirty) {
        // 库存没变也可能要处理断货动作（已在 0 库存但仍 published 的刊登）
        if (oos && inv?.oosAction === "unpublish" && listing.status === "published") {
          await enqueue(deps.db, DELIST_LISTING, { listingId: listing.id }, { workspaceId: store.workspaceId });
        }
        continue;
      }
      await deps.db
        .update(listings)
        .set({ variants, updatedAt: new Date() })
        .where(eq(listings.id, listing.id));
      if (
        listing.status === "published" &&
        store.rules.trackStock &&
        listing.syncPolicy.stock === "auto"
      ) {
        await enqueue(
          deps.db,
          PUSH_STOCK,
          { listingId: listing.id, force: oos && inv?.oosAction === "zero" },
          { workspaceId: store.workspaceId },
        );
        pushed++;
      }
      if (oos && inv?.oosAction === "unpublish" && listing.status === "published") {
        await enqueue(deps.db, DELIST_LISTING, { listingId: listing.id }, { workspaceId: store.workspaceId });
      }
    }
    if (pushed) {
      await audit(deps.db, store.workspaceId, {
        actor: "system:monitor",
        action: "inventory.reconcile",
        entityType: "store",
        entityId: store.id,
        payload: { listings: rows.length, pushed },
      });
    }
  },
};

// --- 订单域 -------------------------------------------------------------------

/**
 * order.sync：webhook/手动同步都只入队，这里才真正拉远端。
 * remoteId 路径（webhook）：拉单条；否则按 ordersCursor 增量拉并推进游标。
 * upsert 靠「remote.updatedAt <= raw.updatedAt → 跳过」挡乱序重放。
 */
const orderSync: JobHandler = {
  async run(deps, job) {
    const storeId = String(job.payload.storeId);
    const remoteId =
      typeof job.payload.remoteId === "string" ? job.payload.remoteId : undefined;
    const [store] = await deps.db.select().from(stores).where(eq(stores.id, storeId));
    if (!store || store.status === "disconnected") return;
    const adapter = adapterFor(store.platform);
    if (!adapter.fetchOrders) return;

    // ordersCursor 形态："<ISO>"，或拉满页数时的 "<ISO>|<pageAfter>" 续拉位
    const sep = store.ordersCursor?.indexOf("|") ?? -1;
    const cursorTs = sep === -1 ? store.ordersCursor : store.ordersCursor!.slice(0, sep);
    const resumeAfter = sep === -1 ? null : store.ordersCursor!.slice(sep + 1) || null;
    const res = await adapter.fetchOrders(
      deps,
      store,
      remoteId ? { remoteId } : { updatedAfter: cursorTs, after: resumeAfter },
    );
    let maxUpdated = cursorTs ? Date.parse(cursorTs) : 0;
    for (const ro of res.orders) {
      const { orderId, skipped } = await upsertRemoteOrder(deps, store, ro);
      if (!skipped) {
        await enqueueOrderMap(deps.db, { orderId }, store.workspaceId);
      }
      const u = ro.updatedAt ? Date.parse(ro.updatedAt) : 0;
      if (u > maxUpdated) maxUpdated = u;
    }
    if (!remoteId) {
      if (res.nextAfter) {
        // 这一页区间还没拉完：游标停在「同 updatedAfter + 分页位」，马上续拉
        const next = `${cursorTs ?? ""}|${res.nextAfter}`;
        if (next !== store.ordersCursor) {
          await deps.db
            .update(stores)
            .set({ ordersCursor: next })
            .where(eq(stores.id, storeId));
        }
        await enqueue(deps.db, ORDER_SYNC, { storeId }, { workspaceId: store.workspaceId });
      } else if (maxUpdated) {
        const cursor = new Date(maxUpdated).toISOString();
        if (cursor !== store.ordersCursor) {
          await deps.db
            .update(stores)
            .set({ ordersCursor: cursor })
            .where(eq(stores.id, storeId));
        }
      }
    }
  },
};

/**
 * order.map：行项三级匹配——remoteVariantMap（发布回填的稳定键）→ listing 变体
 * sku → unmatched。人工绑定（listingId 已设）的行不覆盖，只补齐 mapping 状态。
 * 解析到刊登但没拿到 sourceSkuId 的记 partial（=能看到货源、缺规格，要人工补）。
 */
const orderMap: JobHandler = {
  async run(deps, job) {
    const orderId =
      typeof job.payload.orderId === "string" ? job.payload.orderId : undefined;
    const storeId =
      typeof job.payload.storeId === "string" ? job.payload.storeId : undefined;
    const orderRows = orderId
      ? await deps.db.select().from(orders).where(eq(orders.id, orderId))
      : await deps.db
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.storeId, storeId ?? ""),
              ne(orders.status, "cancelled"),
              ne(orders.status, "done"),
            ),
          );
    for (const order of orderRows) {
      const items = await deps.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.orderId, order.id));
      const storeListings = await deps.db
        .select()
        .from(listings)
        .where(eq(listings.storeId, order.storeId));
      const byVariant = new Map<string, (typeof storeListings)[number]>();
      const bySku = new Map<string, (typeof storeListings)[number]>();
      for (const l of storeListings) {
        for (const ref of Object.values(l.remoteVariantMap ?? {})) {
          if (ref?.variantId) byVariant.set(ref.variantId, l);
        }
        for (const v of l.variants) if (v.sku && !bySku.has(v.sku)) bySku.set(v.sku, l);
      }
      for (const it of items) {
        // 已有绑定（人工/自动）优先保留：sourceItemId 还在就只刷新辅助字段
        let listing: (typeof storeListings)[number] | undefined;
        let sourceItemId: string | null = null;
        let sourceSkuId: string | null = null;
        if (it.sourceItemId) {
          sourceItemId = it.sourceItemId;
          sourceSkuId = it.sourceSkuId;
          listing =
            storeListings.find((l) => l.id === it.listingId) ??
            storeListings.find((l) => l.sourceItemId === it.sourceItemId);
        } else {
          listing =
            (it.remoteVariantId ? byVariant.get(it.remoteVariantId) : undefined) ??
            (it.sku ? bySku.get(it.sku) : undefined);
          if (listing) {
            sourceItemId = listing.sourceItemId;
            const vmap = listing.remoteVariantMap;
            const lv = listing.variants.find(
              (v) =>
                (it.remoteVariantId &&
                  vmap?.[v.sku ?? ""]?.variantId === it.remoteVariantId) ||
                (it.sku && v.sku === it.sku),
            );
            sourceSkuId = lv?.sourceSkuId ?? null;
          }
        }
        if (sourceItemId) {
          // 绑定的货源还在不在采集箱决定 mapping 有没有意义
          const [src] = await deps.db
            .select({ id: sourceItems.id })
            .from(sourceItems)
            .where(eq(sourceItems.id, sourceItemId))
            .limit(1);
          if (!src) {
            sourceItemId = null;
            sourceSkuId = null;
            listing = undefined;
          }
        }
        const patch: {
          listingId: string | null;
          sourceItemId: string | null;
          sourceSkuId: string | null;
          mapping: "matched" | "partial" | "unmatched";
        } = sourceItemId
          ? {
              listingId: listing?.id ?? it.listingId,
              sourceItemId,
              sourceSkuId,
              mapping: sourceSkuId ? "matched" : "partial",
            }
          : {
              listingId: null,
              sourceItemId: null,
              sourceSkuId: null,
              mapping: "unmatched",
            };
        if (
          patch.listingId !== it.listingId ||
          patch.sourceItemId !== it.sourceItemId ||
          patch.sourceSkuId !== it.sourceSkuId ||
          patch.mapping !== it.mapping
        ) {
          await deps.db.update(orderItems).set(patch).where(eq(orderItems.id, it.id));
        }
      }
      await refreshOrderStatus(deps, order.id);
    }
  },
};

/** fulfill.push：一条 shipment → 一次 fulfillmentCreate；失败走 onFailed 标 failed。 */
const fulfillPush: JobHandler = {
  async run(deps, job) {
    const shipmentId = String(job.payload.shipmentId);
    const [row] = await deps.db
      .select({ shipment: shipments, order: orders, store: stores })
      .from(shipments)
      .innerJoin(orders, eq(orders.id, shipments.orderId))
      .innerJoin(stores, eq(stores.id, orders.storeId))
      .where(eq(shipments.id, shipmentId));
    if (!row) throw new PermanentJobError("运单已删除");
    if (row.store.status === "disconnected") throw new PermanentJobError("店铺已断开授权");
    const adapter = adapterFor(row.store.platform);
    if (!adapter.pushFulfillment) throw new PermanentJobError("该平台不支持履约回传");
    const res = await adapter.pushFulfillment(deps, row.store, {
      remoteOrderId: row.order.remoteId,
      lineItems: row.shipment.lineItems?.map((id) => ({
        remoteLineItemId: id,
        qty: Number.MAX_SAFE_INTEGER, // min() 收敛到 remainingQuantity
      })),
      tracking: {
        number: row.shipment.trackingNo ?? "",
        company: row.shipment.carrier ?? undefined,
        url: row.shipment.trackingUrl ?? undefined,
      },
      notifyCustomer: true,
    });
    await deps.db
      .update(shipments)
      .set({ status: "pushed", remoteFulfillmentId: res.remoteFulfillmentId, lastError: null })
      .where(eq(shipments.id, shipmentId));
    await audit(deps.db, row.order.workspaceId, {
      actor: "system",
      action: "order.fulfill_pushed",
      entityType: "order",
      entityId: row.order.id,
      payload: { shipmentId, remoteFulfillmentId: res.remoteFulfillmentId },
    });
    await refreshOrderStatus(deps, row.order.id);
  },
  async onFailed(deps, job, error) {
    const shipmentId = String(job.payload.shipmentId);
    const [s] = await deps.db
      .update(shipments)
      .set({ status: "failed", lastError: error })
      .where(eq(shipments.id, shipmentId))
      .returning();
    if (!s) return;
    await audit(deps.db, s.workspaceId, {
      actor: "system",
      action: "order.fulfill_failed",
      entityType: "order",
      entityId: s.orderId,
      payload: { shipmentId, error },
    });
    await refreshOrderStatus(deps, s.orderId);
  },
};

export const jobHandlers: Record<string, JobHandler> = {
  [ORDER_SYNC]: orderSync,
  [SELECTION_SCORE]: selectionScore,
  [ORDER_MAP]: orderMap,
  [FULFILL_PUSH]: fulfillPush,
  [PUBLISH_LISTING]: publishListing,
  [PUSH_STOCK]: pushStockJob,
  [FETCH_MISSING_MEDIA]: fetchMissingMedia,
  [SYNC_STORE]: syncStore,
  [AI_ENHANCE_LISTING]: aiEnhance,
  [CATEGORY_SUGGEST]: categorySuggest,
  [LISTING_CLAIM]: listingClaim,
  [PIPELINE_ADVANCE]: pipelineAdvance,
  [AI_IMAGE]: aiImage,
  [SYNC_CATEGORIES]: syncCategories,
  [DELIST_LISTING]: delistListing,
  [PUSH_PRICE]: pushPriceJob,
  [RECONCILE_INVENTORY]: reconcileInventory,
};
