import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type {
  CollectedOffer,
  CollectHarvest,
  OfferSku,
  SourceChangeAppliedAction,
  SourceChangeType,
} from "@caiji/shared";
import { findInitData, normalizeOffer } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import type { Db } from "../db/client.js";
import {
  listings,
  sourceChanges,
  sourceItems,
  stores,
} from "../db/schema.js";
import { audit } from "../lib/audit.js";
import { applyPricing } from "../lib/draft.js";
import { HttpError } from "../lib/errors.js";
import {
  changeFingerprint,
  diffSourceItem,
  isSourceOos,
  pushQuantity,
  type SourceChangeDraft,
} from "../lib/sourceMonitor.js";
import {
  DELIST_LISTING,
  enqueueListingClaim,
  FETCH_MISSING_MEDIA,
  PUSH_PRICE,
  PUSH_STOCK,
} from "../jobs/handlers.js";
import { backfillDiscovery } from "../lib/selection.js";
import { enqueue } from "../jobs/queue.js";
import { requireAuth } from "./auth.js";
import { toSourceItemDto } from "./sourceItems.js";

/** Harvest contract: extension ships pageContent + URL tokens; all field
 * extraction happens here so site adaptors hot-update without releases.
 * Falls back to productExtInfo.offer when the page side already parsed
 * (sniffed API payloads / DOM fallback). */
export function harvestToOffer(body: CollectHarvest): CollectedOffer | null {
  const { sourceInfo, pageContent, productExtInfo } = body;
  const initData =
    productExtInfo?.initData ?? (pageContent ? findInitData(pageContent) : null);
  // 详情图只能来自页面侧（DOM/descUrl），initData 里没有，附带在 extInfo 上传。
  const extDesc = Array.isArray(productExtInfo?.descImages)
    ? productExtInfo.descImages.filter((u): u is string => typeof u === "string")
    : undefined;
  if (initData) {
    const offer = normalizeOffer(initData, sourceInfo.itemId, sourceInfo.itemUrl);
    if (offer.title) {
      return { ...offer, descImages: extDesc, collectedAt: body.collectedAt ?? offer.collectedAt };
    }
  }
  const offer = productExtInfo?.offer as CollectedOffer | undefined;
  if (offer?.title) {
    return {
      ...offer,
      skus: offer.skus ?? [],
      images: offer.images ?? [],
      descImages: offer.descImages ?? extDesc,
      attributes: offer.attributes ?? {},
      sourceUrl: offer.sourceUrl || sourceInfo.itemUrl,
      offerId: offer.offerId ?? sourceInfo.itemId,
      collectedAt: body.collectedAt ?? offer.collectedAt,
    };
  }
  return null;
}

/** Canonical URL so different URL shapes of one offer dedupe to one row. */
export function canonicalSourceUrl(offer: CollectedOffer): string {
  if (offer.sourcePlatform === "1688" && offer.offerId) {
    return `https://detail.1688.com/offer/${offer.offerId}.html`;
  }
  return offer.sourceUrl;
}

/** Insert or refresh a collect-box row; re-collecting updates source data. */
export async function ingestOffer(
  db: Db,
  workspaceId: string,
  userId: string,
  offer: CollectedOffer,
  via?: "manual" | "plan" | "inquiry",
) {
  const sourceUrl = canonicalSourceUrl(offer);
  const values = {
    workspaceId,
    sourcePlatform: offer.sourcePlatform,
    sourceUrl,
    sourceItemId: offer.offerId ?? null,
    title: offer.title,
    priceText: offer.priceText ?? null,
    skus: offer.skus,
    images: offer.images,
    descImages: offer.descImages ?? [],
    attributes: offer.attributes,
    sellerName: offer.sellerName ?? null,
    sourceCategoryId: offer.categoryId ?? null,
    sourceCategoryName: offer.categoryPath?.[0] ?? null,
    collectedBy: userId,
    /** 重复采集时 undefined 会被 drizzle set 跳过，保留首次入口归因。 */
    collectedVia: via,
    collectedAt: new Date(offer.collectedAt || Date.now()),
  };
  const [existing] = await db
    .select()
    .from(sourceItems)
    .where(
      and(
        eq(sourceItems.workspaceId, workspaceId),
        offer.offerId
          ? or(
              and(
                eq(sourceItems.sourcePlatform, offer.sourcePlatform),
                eq(sourceItems.sourceItemId, offer.offerId),
              ),
              eq(sourceItems.sourceUrl, sourceUrl),
            )
          : eq(sourceItems.sourceUrl, sourceUrl),
      ),
    )
    .limit(1);
  if (existing) {
    // 成功采到数据 = 货源仍在架上；回扫时戳也一并刷新
    const patch = {
      ...values,
      lastScannedAt: new Date(),
      ...(existing.availability !== "ok"
        ? { availability: "ok" as const, delistedAt: null }
        : {}),
    };
    const [row] = await db
      .update(sourceItems)
      .set(patch)
      .where(eq(sourceItems.id, existing.id))
      .returning();
    return { item: row!, duplicated: true, prev: existing };
  }
  const [row] = await db
    .insert(sourceItems)
    .values({ ...values, lastScannedAt: new Date() })
    .returning();
  return { item: row!, duplicated: false, prev: undefined };
}

/** 货源恢复上架：把该条目所有未消费的 delisted 变更落账 relisted。 */
async function markRelisted(db: Db, workspaceId: string, itemId: string) {
  await db
    .update(sourceChanges)
    .set({ appliedAt: new Date(), appliedAction: [{ action: "relisted" }] })
    .where(
      and(
        eq(sourceChanges.workspaceId, workspaceId),
        eq(sourceChanges.sourceItemId, itemId),
        eq(sourceChanges.changeType, "delisted"),
        isNull(sourceChanges.appliedAt),
      ),
    );
}

/** 重复采集 = 货源刷新（fl-monitor）。
 *  1) prev vs offer 全字段 diff → source_changes 落库（sku 粒度 + 指纹去重，
 *     同 (type,sku) 的旧未消费行标 superseded）；
 *  2) 关联刊登一律刷新 source_changed_at（关注页黄标）；
 *  3) 自动应用判定：店铺 rules.monitor.enabled 是总开关，再叠加刊登 syncPolicy
 *     与 rules.inventory 策略：
 *       price → priceAuto && syncPolicy.price=auto → 按 store.pricing 重算 +
 *               listing.pushPrice（adapter.pushPrices 可选能力）；
 *       stock → rules.inventory 策略(mirror|fixed|percent|cap)−buffer →
 *               syncPolicy.stock=auto && trackStock 时 listing.pushStock；
 *       title/images/attributes → 只标 drift 不覆盖刊登；
 *       delisted（或全 sku ≤ minStock）→ oosAction zero|unpublish|notify。
 *  全部关联刊登都消费掉的变更立即落 applied_at/applied_action；其余留 pending
 *  由用户在关注页手动「应用/忽略」。 */
export async function recordSourceChanges(
  db: Db,
  workspaceId: string,
  item: typeof sourceItems.$inferSelect,
  drafts: SourceChangeDraft[],
  offerSkus: OfferSku[],
) {
  const zero = { updated: 0, republished: 0, changes: 0, pending: 0 };
  if (!drafts.length) return zero;

  // 指纹去重：同指纹的未消费变更已存在则跳过；同键位的旧 pending 落账 superseded
  const pendingRows = await db
    .select({
      id: sourceChanges.id,
      changeType: sourceChanges.changeType,
      skuId: sourceChanges.skuId,
      fingerprint: sourceChanges.fingerprint,
    })
    .from(sourceChanges)
    .where(
      and(
        eq(sourceChanges.workspaceId, workspaceId),
        eq(sourceChanges.sourceItemId, item.id),
        isNull(sourceChanges.appliedAt),
      ),
    );
  const pendingFp = new Set(pendingRows.map((r) => r.fingerprint));
  const fresh = drafts.filter((d) => !pendingFp.has(d.fingerprint));
  if (!fresh.length) return zero;

  const now = new Date();
  const freshKeys = [...new Set(fresh.map((d) => `${d.changeType}\u0000${d.skuId ?? ""}`))];
  for (const key of freshKeys) {
    const [changeType, skuId] = key.split("\u0000");
    await db
      .update(sourceChanges)
      .set({
        appliedAt: now,
        appliedAction: [{ action: "superseded" }],
      })
      .where(
        and(
          eq(sourceChanges.workspaceId, workspaceId),
          eq(sourceChanges.sourceItemId, item.id),
          eq(sourceChanges.changeType, changeType as SourceChangeType),
          skuId ? eq(sourceChanges.skuId, skuId) : isNull(sourceChanges.skuId),
          isNull(sourceChanges.appliedAt),
        ),
      );
  }

  const inserted = await db
    .insert(sourceChanges)
    .values(
      fresh.map((d) => ({
        workspaceId,
        sourceItemId: item.id,
        changeType: d.changeType,
        skuId: d.skuId,
        oldValue: d.oldValue === undefined ? null : (d.oldValue as object),
        newValue: d.newValue === undefined ? null : (d.newValue as object),
        fingerprint: d.fingerprint,
      })),
    )
    .returning({
      id: sourceChanges.id,
      changeType: sourceChanges.changeType,
    });

  const rows = await db
    .select({
      listing: listings,
      storeRules: stores.rules,
      pricing: stores.pricing,
    })
    .from(listings)
    .innerJoin(stores, eq(stores.id, listings.storeId))
    .where(
      and(
        eq(listings.workspaceId, workspaceId),
        eq(listings.sourceItemId, item.id),
      ),
    );

  const changedTypes = new Set(fresh.map((d) => d.changeType));
  const hasDelisted = changedTypes.has("delisted");
  /** type → 每刊登的动作（写进该 type 下全部 change 的 applied_action）。 */
  const actsByType = new Map<SourceChangeType, SourceChangeAppliedAction[]>();
  /** type → 已处理它的刊登数；== rows.length 时该 type 的变更整体落账。 */
  const handledByType = new Map<SourceChangeType, number>();
  const markAct = (t: SourceChangeType, listingId: string, action: string) => {
    actsByType.set(t, [
      ...(actsByType.get(t) ?? []),
      { listingId, action },
    ]);
    handledByType.set(t, (handledByType.get(t) ?? 0) + 1);
  };

  let updated = 0;
  let republished = 0;
  for (const { listing: l, storeRules, pricing } of rows) {
    const monitor = storeRules?.monitor;
    const enabled = monitor?.enabled === true;
    const inv = storeRules?.inventory;
    const published = l.status === "published" && !!l.remoteId;
    let stockDirty = false;
    let priceDirty = false;

    const variants = l.variants.map((v, i) => {
      const sku =
        (v.sourceSkuId
          ? offerSkus.find((s) => (s.skuId || s.spec) === v.sourceSkuId)
          : undefined) ?? offerSkus[i];
      const next = { ...v };
      if (sku) {
        const qty = pushQuantity(sku.stock, inv);
        if (next.stock !== qty) {
          next.stock = qty;
          stockDirty = true;
        }
        if ((next.costCny ?? null) !== (sku.priceCny ?? null)) {
          next.costCny = sku.priceCny;
          if (
            enabled &&
            monitor?.priceAuto &&
            l.syncPolicy.price === "auto" &&
            sku.priceCny != null
          ) {
            next.price = applyPricing(sku.priceCny, pricing);
            priceDirty = true;
          }
        }
      } else if (v.sourceSkuId) {
        // 货源撤掉该 SKU → 变体库存归零
        if (next.stock !== 0) {
          next.stock = 0;
          stockDirty = true;
        }
      }
      return next;
    });

    const oos =
      enabled && isSourceOos(item.availability, offerSkus, monitor);
    if (oos) {
      const oosAction = inv?.oosAction ?? "notify";
      if (oosAction === "zero") {
        for (const v of variants) {
          if (v.stock !== 0) {
            v.stock = 0;
            stockDirty = true;
          }
        }
        if (published) {
          // force：售罄清零是店主的明确配置，不走刊登级 stock 策略
          await enqueue(
            db,
            PUSH_STOCK,
            { listingId: l.id, force: true },
            { workspaceId },
          );
          republished++;
          markAct("delisted", l.id, "oos_zero_queued");
        } else {
          markAct("delisted", l.id, "oos_zero");
        }
      } else if (oosAction === "unpublish") {
        if (published) {
          await enqueue(db, DELIST_LISTING, { listingId: l.id }, { workspaceId });
          republished++;
          markAct("delisted", l.id, "oos_unpublish_queued");
        } else {
          markAct("delisted", l.id, "oos_unpublish_draft");
        }
      } else {
        markAct("delisted", l.id, "oos_notify");
      }
    }

    if (stockDirty || changedTypes.has("stock")) {
      if (!enabled) {
        /* 监控未开：只留 pending 变更，本地库存照刷 */
      } else if (!published) {
        markAct("stock", l.id, "stock_updated");
      } else if (
        l.syncPolicy.stock === "auto" &&
        storeRules?.trackStock &&
        stockDirty
      ) {
        await enqueue(db, PUSH_STOCK, { listingId: l.id }, { workspaceId });
        republished++;
        markAct("stock", l.id, "stock_push_queued");
      } else if (l.syncPolicy.stock === "auto" && storeRules?.trackStock) {
        markAct("stock", l.id, "stock_unchanged");
      }
    }
    if (priceDirty) {
      if (published) {
        await enqueue(db, PUSH_PRICE, { listingId: l.id }, { workspaceId });
        republished++;
        markAct("price", l.id, "price_push_queued");
      } else {
        markAct("price", l.id, "price_recalculated");
      }
    }

    updated++;
    await db
      .update(listings)
      .set({ variants, sourceChangedAt: now, updatedAt: now })
      .where(eq(listings.id, l.id));
  }

  // 全部关联刊登都处理过的变更 → 直接落账；否则留 pending
  const listingCount = rows.length;
  const appliedAtById = new Map<string, SourceChangeAppliedAction[]>();
  for (const { id, changeType } of inserted) {
    const handled = handledByType.get(changeType) ?? 0;
    const acts = actsByType.get(changeType) ?? [];
    if (
      listingCount === 0 ||
      (handled >= listingCount && acts.length)
    ) {
      appliedAtById.set(
        id,
        acts.length ? acts : [{ action: "no_listings" }],
      );
    }
  }
  for (const [id, acts] of appliedAtById) {
    await db
      .update(sourceChanges)
      .set({ appliedAt: now, appliedAction: acts })
      .where(eq(sourceChanges.id, id));
  }

  if (inserted.length) {
    await audit(db, workspaceId, {
      actor: "system:monitor",
      action: "source.change",
      entityType: "source_item",
      entityId: item.id,
      payload: {
        changes: Object.fromEntries(
          [...changedTypes].map((t) => [
            t,
            fresh.filter((d) => d.changeType === t).length,
          ]),
        ),
        applied: appliedAtById.size,
        listings: rows.length,
      },
    });
  }

  return {
    updated,
    republished,
    changes: inserted.length,
    pending: inserted.length - appliedAtById.size,
  };
}

const harvestSchema = z.object({
  sourceInfo: z.object({
    itemUrl: z.string().url(),
    itemId: z.string().optional(),
    site: z.string().optional(),
    source: z.enum(["1688", "taobao", "pdd", "temu", "amazon", "unknown"]),
    postFee: z.string().optional(),
  }),
  pageContent: z.string().max(8_000_000).optional(),
  afterUrl: z.string().optional(),
  productExtInfo: z.record(z.string(), z.unknown()).optional(),
  collectedAt: z.string().default(() => new Date().toISOString()),
  collectedVia: z.enum(["manual", "plan", "inquiry"]).optional(),
});

const checkSchema = z.object({
  items: z
    .array(z.object({ itemUrl: z.string().optional(), itemId: z.string().optional() }))
    .max(500),
});

const reportSchema = z.object({
  offerId: z.string().min(1),
  availability: z.enum(["ok", "delisted"]),
});

export function collectRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.post("/", zValidator("json", harvestSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId, userId } = c.var.auth;
    const offer = harvestToOffer(c.req.valid("json") as CollectHarvest);
    if (!offer) {
      throw new HttpError(422, "页面未解析出商品数据", "rowDataInvalid");
    }
    const via = c.req.valid("json").collectedVia;
    const { item, duplicated, prev } = await ingestOffer(
      db,
      workspaceId,
      userId,
      offer,
      via,
    );
    const propagation =
      duplicated && prev
        ? await recordSourceChanges(
            db,
            workspaceId,
            item,
            diffSourceItem(prev, offer),
            offer.skus,
          )
        : { updated: 0, republished: 0, changes: 0, pending: 0 };
    // 重采到数据 = 货源已回架：之前插件上报的下架变更落账
    if (prev && prev.availability !== "ok") {
      await markRelisted(db, workspaceId, item.id);
    }
    // 选品回填：候选池里同 offerId 的 new 条目 → collected + 指向入箱行；
    // harvest 没带 via 但池里命中，说明这条就是候选 → 归因 plan。
    const discoveryBackfilled = await backfillDiscovery(
      db,
      workspaceId,
      offer.offerId,
      item.id,
    );
    if (!via && discoveryBackfilled > 0) {
      await db
        .update(sourceItems)
        .set({ collectedVia: "plan" })
        .where(and(eq(sourceItems.id, item.id), isNull(sourceItems.collectedVia)));
      item.collectedVia = item.collectedVia ?? "plan";
    }
    // the extension uploads images right after this; the server fills gaps later
    if (item.images.length || item.descImages.length) {
      await enqueue(
        db,
        FETCH_MISSING_MEDIA,
        { sourceItemId: item.id },
        { workspaceId, runAt: new Date(Date.now() + 90_000) },
      );
    }
    // 采集成功：命中 autoClaim 的店铺 → 链式认领（认领+按策略走链路）。
    // 重复采集只同步既有刊登，不再触发认领。
    if (!duplicated) {
      const autoStores = await db
        .select({ id: stores.id })
        .from(stores)
        .where(
          and(
            eq(stores.workspaceId, workspaceId),
            ne(stores.status, "disconnected"),
            sql`coalesce((${stores.rules}->'pipeline'->>'autoClaim')::boolean, false)`,
          ),
        );
      for (const s of autoStores) {
        await enqueueListingClaim(
          db,
          { sourceItemId: item.id, storeId: s.id },
          workspaceId,
        );
      }
    }
    return c.json(
      { ok: true, item: toSourceItemDto(item, []), duplicated, discoveryBackfilled, ...propagation },
      duplicated ? 200 : 201,
    );
  });

  /** 回扫队列：有刊登的来源条目 offerId。插件定时逐个重新采集，
   *  ingestOffer/propagateToListings 自己完成库存/成本同步和自动重发。 */
  r.post("/rescan-queue", async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const rows = await db
      .selectDistinct({ offerId: sourceItems.sourceItemId })
      .from(sourceItems)
      .innerJoin(listings, eq(listings.sourceItemId, sourceItems.id))
      .where(
        and(
          eq(sourceItems.workspaceId, workspaceId),
          eq(sourceItems.sourcePlatform, "1688"),
        ),
      )
      .limit(500);
    const items = rows
      .map((r) => r.offerId)
      .filter((v): v is string => !!v)
      .map((offerId) => ({ offerId }));
    return c.json({ ok: true, items });
  });

  /** 插件上报货源在架状态（详情页已下架等）。下架转 delisted 并走与重扫
   *  相同的变更落库 + 自动动作判定；恢复上架只翻转 availability 并把未消费的
   *  delisted 变更落账 relisted。 */
  r.post("/report", zValidator("json", reportSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { offerId, availability } = c.req.valid("json");
    const [item] = await db
      .select()
      .from(sourceItems)
      .where(
        and(
          eq(sourceItems.workspaceId, workspaceId),
          eq(sourceItems.sourcePlatform, "1688"),
          eq(sourceItems.sourceItemId, offerId),
        ),
      )
      .limit(1);
    if (!item) return c.json({ ok: true, found: false });

    const now = new Date();
    let result = { updated: 0, republished: 0, changes: 0, pending: 0 };
    let row = item;
    if (availability === "delisted" && item.availability !== "delisted") {
      [row] = await db
        .update(sourceItems)
        .set({ availability: "delisted", delistedAt: now, lastScannedAt: now })
        .where(eq(sourceItems.id, item.id))
        .returning();
      const draft: SourceChangeDraft = {
        changeType: "delisted",
        skuId: null,
        oldValue: { availability: "ok" },
        newValue: { availability: "delisted" },
        fingerprint: changeFingerprint(
          "delisted",
          null,
          { availability: "ok" },
          { availability: "delisted" },
        ),
      };
      result = await recordSourceChanges(db, workspaceId, row!, [draft], row!.skus);
    } else if (availability === "ok") {
      [row] = await db
        .update(sourceItems)
        .set({ availability: "ok", delistedAt: null, lastScannedAt: now })
        .where(eq(sourceItems.id, item.id))
        .returning();
      // 无论之前是否已是 ok（重采也可能先治愈了行），一律清掉残留的下架 pending
      await markRelisted(db, workspaceId, item.id);
    } else {
      [row] = await db
        .update(sourceItems)
        .set({ lastScannedAt: now })
        .where(eq(sourceItems.id, item.id))
        .returning();
    }
    return c.json({ ok: true, found: true, item: toSourceItemDto(row!, []), ...result });
  });

  /** Dedup marking — pages batch-check which items are already collected. */
  r.post("/check", zValidator("json", checkSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { items } = c.req.valid("json");
    const idOf = (i: { itemUrl?: string; itemId?: string }) =>
      i.itemId ?? i.itemUrl?.match(/offer\/(\d+)/)?.[1];
    const ids = items.map(idOf).filter((v): v is string => !!v);
    const urls = items.map((i) => i.itemUrl).filter((v): v is string => !!v);
    if (!ids.length && !urls.length) return c.json({ ok: true, collected: [] });
    const conds = [];
    if (ids.length) conds.push(inArray(sourceItems.sourceItemId, ids));
    if (urls.length) conds.push(inArray(sourceItems.sourceUrl, urls));
    const rows = await db
      .select({ url: sourceItems.sourceUrl, itemId: sourceItems.sourceItemId })
      .from(sourceItems)
      .where(and(eq(sourceItems.workspaceId, workspaceId), or(...conds)));
    const hitIds = new Set(rows.map((r) => r.itemId));
    const hitUrls = new Set(rows.map((r) => r.url));
    const collected = items
      .filter((i) => hitIds.has(idOf(i) ?? null) || (i.itemUrl && hitUrls.has(i.itemUrl)))
      .map((i) => i.itemUrl ?? i.itemId);
    return c.json({ ok: true, collected });
  });

  return r;
}
