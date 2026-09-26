import { zValidator } from "@hono/zod-validator";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { CollectedOffer, CollectHarvest } from "@caiji/shared";
import { findInitData, normalizeOffer } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import type { Db } from "../db/client.js";
import { listings, sourceItems, stores } from "../db/schema.js";
import { HttpError } from "../lib/errors.js";
import {
  enqueueListingClaim,
  FETCH_MISSING_MEDIA,
  PUSH_STOCK,
} from "../jobs/handlers.js";
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
    collectedAt: new Date(offer.collectedAt || Date.now()),
  };
  const [existing] = await db
    .select({ id: sourceItems.id })
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
    const [row] = await db
      .update(sourceItems)
      .set(values)
      .where(eq(sourceItems.id, existing.id))
      .returning();
    return { item: row!, duplicated: true };
  }
  const [row] = await db.insert(sourceItems).values(values).returning();
  return { item: row!, duplicated: false };
}

/** 重复采集 = 货源刷新：把最新 SKU 库存/成本同步到该条目的所有刊登。
 *  仅库存变化且店铺开了「同步货源库存」+ 刊登 syncPolicy.stock=auto 才排队
 *  「只推库存」（listing.pushStock → adapter.pushStock）；adapter 不支持时
 *  job 内退回全量并审计标注。价格不覆盖（商家可能改过售价）。 */
async function propagateToListings(
  db: Db,
  workspaceId: string,
  sourceItemId: string,
  skus: CollectedOffer["skus"],
) {
  if (!skus.length) return { updated: 0, republished: 0 };
  const rows = await db
    .select({ listing: listings, storeRules: stores.rules })
    .from(listings)
    .innerJoin(stores, eq(stores.id, listings.storeId))
    .where(and(eq(listings.workspaceId, workspaceId), eq(listings.sourceItemId, sourceItemId)));
  let updated = 0;
  let republished = 0;
  for (const { listing: l, storeRules } of rows) {
    let stockChanged = false;
    let costChanged = false;
    const variants = l.variants.map((v, i) => {
      const sku =
        (v.sourceSkuId ? skus.find((s) => s.skuId === v.sourceSkuId) : undefined) ??
        skus[i];
      if (!sku) return v;
      const next = { ...v, stock: sku.stock, costCny: sku.priceCny };
      if (next.stock !== v.stock) stockChanged = true;
      if (next.costCny !== v.costCny) costChanged = true;
      return next;
    });
    if (!stockChanged && !costChanged) continue;
    updated++;
    // 只有库存差异才推远端（成本只是本地数据）；库存自动写受店铺 trackStock + 刊登策略双重控制
    const republish =
      l.status === "published" &&
      !!l.remoteId &&
      stockChanged &&
      !!storeRules?.trackStock &&
      l.syncPolicy.stock === "auto";
    await db
      .update(listings)
      .set({ variants, updatedAt: new Date() })
      .where(eq(listings.id, l.id));
    if (republish) {
      republished++;
      await enqueue(db, PUSH_STOCK, { listingId: l.id }, { workspaceId });
    }
  }
  return { updated, republished };
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
});

const checkSchema = z.object({
  items: z
    .array(z.object({ itemUrl: z.string().optional(), itemId: z.string().optional() }))
    .max(500),
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
    const { item, duplicated } = await ingestOffer(db, workspaceId, userId, offer);
    const propagation = duplicated
      ? await propagateToListings(db, workspaceId, item.id, offer.skus)
      : { updated: 0, republished: 0 };
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
      { ok: true, item: toSourceItemDto(item, []), duplicated, ...propagation },
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
