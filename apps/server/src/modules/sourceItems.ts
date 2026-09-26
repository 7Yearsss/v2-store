import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, ilike, inArray, notExists } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { SourceItem, SourcePlatform } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import { categoryMappings, listings, sourceItems, stores } from "../db/schema.js";
import { applyAttrMappings, loadAttrMappings } from "../lib/attributes.js";
import { attributesToHtml, buildVariants, parseWeightKg } from "../lib/draft.js";
import { HttpError, notFound } from "../lib/errors.js";
import {
  applyAttrRules,
  applyImageLimit,
  applyTitleRules,
  filterSkusByPrice,
} from "../lib/rules.js";
import { enqueueAiEnhance, enqueueCategorySuggest } from "../jobs/handlers.js";
import { applyTerm, loadTermMap } from "../lib/terms.js";
import { requireAuth } from "./auth.js";
import { displayUrls } from "./media.js";

type Row = typeof sourceItems.$inferSelect;

/** `images` defaults to the source URLs; pass display URLs (our copies) when resolved. */
export function toSourceItemDto(
  r: Row,
  claimedStoreIds: string[],
  images: string[] = r.images,
  descImages: string[] = r.descImages,
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
    descImages,
    attributes: r.attributes,
    sellerName: r.sellerName,
    sourceCategoryId: r.sourceCategoryId,
    sourceCategoryName: r.sourceCategoryName,
    collectedAt: r.collectedAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    claimedStoreIds,
    availability: r.availability,
    delistedAt: r.delistedAt?.toISOString() ?? null,
    lastScannedAt: r.lastScannedAt?.toISOString() ?? null,
    collectedVia: r.collectedVia,
  };
}

const listQuery = z.object({
  q: z.string().trim().optional(),
  unclaimed: z.coerce.boolean().optional(),
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
    const { q, unclaimed, page, pageSize } = c.req.valid("query");
    const where = and(
      eq(sourceItems.workspaceId, workspaceId),
      q ? ilike(sourceItems.title, `%${q}%`) : undefined,
      unclaimed ? notExists(db.select({ id: listings.id }).from(listings).where(eq(listings.sourceItemId, sourceItems.id))) : undefined,
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
    const show = await displayUrls(
      db,
      workspaceId,
      rows.map((r) => [...r.images, ...r.descImages]),
    );
    return c.json({
      items: rows.map((r) =>
        toSourceItemDto(r, byItem.get(r.id) ?? [], show(r.images), show(r.descImages)),
      ),
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
    const show = await displayUrls(db, c.var.auth.workspaceId, [[...row.images, ...row.descImages]]);
    return c.json(
      toSourceItemDto(row, claims.map((x) => x.storeId), show(row.images), show(row.descImages)),
    );
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

    // 已确认的来源类目映射：同来源类目认领时直接套用
    const catIds = new Set(
      items.map((i) => i.sourceCategoryId).filter((v): v is string => !!v),
    );
    const mappings = catIds.size
      ? await db
          .select()
          .from(categoryMappings)
          .where(
            and(
              eq(categoryMappings.workspaceId, workspaceId),
              inArray(categoryMappings.sourceCategoryId, [...catIds]),
            ),
          )
      : [];
    const mappingOf = (item: (typeof items)[number], store: (typeof targetStores)[number]) =>
      mappings.find(
        (m) =>
          m.sourceCategoryId === item.sourceCategoryId &&
          m.sourcePlatform === item.sourcePlatform &&
          m.channel === store.platform,
      );

    // 术语翻译映射：每种刊登语言一份，认领时预翻选项名/值与属性
    const termMaps = new Map<string, Map<string, string>>();
    for (const store of targetStores) {
      if (!termMaps.has(store.language)) {
        termMaps.set(store.language, await loadTermMap(db, workspaceId, store.language));
      }
    }
    const termOf = (store: (typeof targetStores)[number]) => {
      const map = termMaps.get(store.language)!;
      return (s: string) => applyTerm(map, s);
    };

    // 已确认的属性映射：按店铺平台加载一次，认领时自动套用
    const attrMaps = new Map<string, Awaited<ReturnType<typeof loadAttrMappings>>>();
    for (const store of targetStores) {
      if (!attrMaps.has(store.platform)) {
        attrMaps.set(store.platform, await loadAttrMappings(db, workspaceId, store.platform));
      }
    }

    const values = targetStores.flatMap((store) =>
      items.flatMap((item) => {
        const rules = store.rules ?? {};
        // 采集预处理：价格区间过滤 SKU；全部被滤掉则不建这条刊登。
        const skus = filterSkusByPrice(item.skus, rules, item.priceText);
        if (item.skus.length && !skus.length) return [];
        const term = termOf(store);
        const { options, variants } = buildVariants(skus, {
          skuPrefix: item.sourceItemId ?? item.id.slice(0, 8),
          priceText: item.priceText,
          pricing: store.pricing,
          termMap: term,
        });
        const mapping = mappingOf(item, store);
        const weightKg =
          parseWeightKg(applyAttrRules(item.attributes, rules)) ??
          rules.defaultWeightKg ??
          null;
        // 属性名译文撞名时保留原名消歧，避免两个属性合成一条丢值
        const attrSeen = new Map<string, number>();
        const attrs = Object.fromEntries(
          Object.entries(applyAttrRules(item.attributes, rules)).map(([k, v]) => {
            const tk = term(k);
            const n = (attrSeen.get(tk) ?? 0) + 1;
            attrSeen.set(tk, n);
            return [n > 1 ? `${tk}（${k}）` : tk, term(v)];
          }),
        );
        return [
          {
            workspaceId,
            storeId: store.id,
            sourceItemId: item.id,
            title: applyTitleRules(item.title, rules),
            descriptionHtml: attributesToHtml(attrs),
            images: applyImageLimit(item.images, rules),
            descImages: item.descImages.slice(0, 30),
            options,
            variants,
            tags: rules.defaultTags ?? [],
            productType: rules.defaultProductType ?? "",
            weightKg,
            // never expose the supplier as the brand
            vendor: store.vendor,
            channelCategoryId: mapping?.channelCategoryId ?? null,
            channelCategoryName: mapping?.channelCategoryName ?? null,
            channelAttributes: applyAttrMappings(
              attrMaps.get(store.platform) ?? new Map(),
              item.attributes,
              term,
            ),
            // 店铺开了「同步货源库存」的刊登默认自动回推库存（旧行为），其余只标记漂移
            syncPolicy: rules.trackStock
              ? { stock: "auto" as const, content: "notify" as const, price: "notify" as const }
              : undefined,
          },
        ];
      }),
    );
    const created = values.length
      ? await db
          .insert(listings)
          .values(values)
          .onConflictDoNothing({ target: [listings.storeId, listings.sourceItemId] })
          .returning({
            id: listings.id,
            storeId: listings.storeId,
            sourceItemId: listings.sourceItemId,
          })
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
      // 未套用映射的来源类目 → 类目建议产线（AI Top-3 → 用户确认）
      const noCategoryIds = created
        .filter((l) => aiStoreIds.has(l.storeId))
        .filter((l) => {
          const item = items.find((i) => i.id === l.sourceItemId);
          const store = targetStores.find((s) => s.id === l.storeId);
          return item?.sourceCategoryId && store && !mappingOf(item, store);
        })
        .map((l) => l.id);
      await enqueueCategorySuggest(db, noCategoryIds, workspaceId);
    }
    return c.json({
      created: created.length,
      // 应建数（item×store 全组合）- 实建数：含已认领冲突与规则过滤掉的。
      skipped: targetStores.length * items.length - created.length,
    });
  });

  return r;
}
