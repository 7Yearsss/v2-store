import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, ilike, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { SourceItem, SourcePlatform } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import { listings, sourceItems, stores } from "../db/schema.js";
import { attributesToHtml, buildVariants } from "../lib/draft.js";
import { HttpError, notFound } from "../lib/errors.js";
import {
  applyAttrRules,
  applyImageLimit,
  applyTitleRules,
  filterSkusByPrice,
} from "../lib/rules.js";
import { enqueueAiEnhance } from "../jobs/handlers.js";
import { requireAuth } from "./auth.js";
import { displayUrls } from "./media.js";

type Row = typeof sourceItems.$inferSelect;

/** `images` defaults to the source URLs; pass display URLs (our copies) when resolved. */
export function toSourceItemDto(
  r: Row,
  claimedStoreIds: string[],
  images: string[] = r.images,
): SourceItem {
  return {
    id: r.id,
    sourcePlatform: r.sourcePlatform as SourcePlatform,
    sourceUrl: r.sourceUrl,
    sourceItemId: r.sourceItemId,
    title: r.title,
    priceText: r.priceText,
    skus: r.skus,
    images,
    attributes: r.attributes,
    sellerName: r.sellerName,
    collectedAt: r.collectedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    claimedStoreIds,
  };
}

const listQuery = z.object({
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const idsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

const claimSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  storeIds: z.array(z.string().uuid()).min(1).max(20),
});

export function sourceItemRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", zValidator("query", listQuery), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { q, page, pageSize } = c.req.valid("query");
    const where = and(
      eq(sourceItems.workspaceId, workspaceId),
      q ? ilike(sourceItems.title, `%${q}%`) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(sourceItems)
        .where(where)
        .orderBy(desc(sourceItems.collectedAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ n: count() }).from(sourceItems).where(where),
    ]);
    const claims = rows.length
      ? await db
          .select({ sid: listings.sourceItemId, storeId: listings.storeId })
          .from(listings)
          .where(inArray(listings.sourceItemId, rows.map((r) => r.id)))
      : [];
    const byItem = new Map<string, string[]>();
    for (const cl of claims) {
      byItem.set(cl.sid, [...(byItem.get(cl.sid) ?? []), cl.storeId]);
    }
    const show = await displayUrls(db, workspaceId, rows.map((r) => r.images));
    return c.json({
      items: rows.map((r) => toSourceItemDto(r, byItem.get(r.id) ?? [], show(r.images))),
      total: total?.n ?? 0,
    });
  });

  r.get("/:id", async (c) => {
    const { db } = c.var.deps;
    const [row] = await db
      .select()
      .from(sourceItems)
      .where(
        and(
          eq(sourceItems.id, c.req.param("id")),
          eq(sourceItems.workspaceId, c.var.auth.workspaceId),
        ),
      );
    if (!row) throw notFound("商品");
    const claims = await db
      .select({ storeId: listings.storeId })
      .from(listings)
      .where(eq(listings.sourceItemId, row.id));
    const show = await displayUrls(db, c.var.auth.workspaceId, [row.images]);
    return c.json(toSourceItemDto(row, claims.map((x) => x.storeId), show(row.images)));
  });

  r.post("/delete", zValidator("json", idsSchema), async (c) => {
    const { db } = c.var.deps;
    const { ids } = c.req.valid("json");
    const deleted = await db
      .delete(sourceItems)
      .where(
        and(
          eq(sourceItems.workspaceId, c.var.auth.workspaceId),
          inArray(sourceItems.id, ids),
        ),
      )
      .returning({ id: sourceItems.id });
    return c.json({ deleted: deleted.length });
  });

  /** 认领：把采集箱条目复制成目标店铺的刊登草稿（已认领的跳过）。 */
  r.post("/claim", zValidator("json", claimSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { ids, storeIds } = c.req.valid("json");

    const targetStores = await db
      .select()
      .from(stores)
      .where(and(eq(stores.workspaceId, workspaceId), inArray(stores.id, storeIds)));
    if (targetStores.length !== new Set(storeIds).size) throw notFound("店铺");
    const items = await db
      .select()
      .from(sourceItems)
      .where(and(eq(sourceItems.workspaceId, workspaceId), inArray(sourceItems.id, ids)));
    if (!items.length) throw new HttpError(400, "没有可认领的商品");

    const values = targetStores.flatMap((store) =>
      items.flatMap((item) => {
        const rules = store.rules ?? {};
        // 采集预处理：价格区间过滤 SKU；全部被滤掉则不建这条刊登。
        const skus = filterSkusByPrice(item.skus, rules, item.priceText);
        if (item.skus.length && !skus.length) return [];
        const { options, variants } = buildVariants(skus, {
          skuPrefix: item.sourceItemId ?? item.id.slice(0, 8),
          priceText: item.priceText,
          pricing: store.pricing,
        });
        return [
          {
            workspaceId,
            storeId: store.id,
            sourceItemId: item.id,
            title: applyTitleRules(item.title, rules),
            descriptionHtml: attributesToHtml(applyAttrRules(item.attributes, rules)),
            images: applyImageLimit(item.images, rules),
            options,
            variants,
            // never expose the supplier as the brand
            vendor: store.vendor,
          },
        ];
      }),
    );
    const created = values.length
      ? await db
          .insert(listings)
          .values(values)
          .onConflictDoNothing({ target: [listings.storeId, listings.sourceItemId] })
          .returning({ id: listings.id, storeId: listings.storeId })
      : [];
    // 认领即入 AI 产线（店铺设置可关、服务端需配 AI）；建议出现在刊登编辑页，接受前不改草稿。
    if (c.var.deps.config.ai) {
      const aiStoreIds = new Set(
        targetStores.filter((s) => s.aiEnhance === "on").map((s) => s.id),
      );
      const aiListingIds = created
        .filter((l) => aiStoreIds.has(l.storeId))
        .map((l) => l.id);
      await enqueueAiEnhance(db, aiListingIds, workspaceId);
    }
    return c.json({
      created: created.length,
      // 应建数（item×store 全组合）- 实建数：含已认领冲突与规则过滤掉的。
      skipped: targetStores.length * items.length - created.length,
    });
  });

  return r;
}
