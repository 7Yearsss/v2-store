import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, ilike, inArray, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type {
  AttributesSuggestionValue,
  CategorySuggestionValue,
  Listing,
  ListingSuggestion,
  OptionsSuggestionValue,
} from "@caiji/shared";
import type { ListingRow } from "../channels/types.js";
import type { AppEnv } from "../context.js";
import { jobs, listings, listingSuggestions, sourceItems, stores } from "../db/schema.js";
import { HttpError, notFound } from "../lib/errors.js";
import { upsertAttrMappings } from "../lib/attributes.js";
import { TAXONOMY_VERSION, upsertCategoryMapping } from "../lib/category.js";
import { findBannedWords } from "../lib/rules.js";
import { upsertTermPairs } from "../lib/terms.js";
import {
  AI_ENHANCE_LISTING,
  CATEGORY_SUGGEST,
  DELIST_LISTING,
  enqueueAiEnhance,
  PUBLISH_LISTING,
} from "../jobs/handlers.js";
import { toProductSetInput, validateForShopify } from "../channels/shopify/adapter.js";
import { enqueue } from "../jobs/queue.js";
import { requireAuth } from "./auth.js";
import { displayUrls } from "./media.js";

/** `images`/`descImages` default to stored refs; pass display URLs (our copies) when resolved. */
export function toListingDto(
  r: ListingRow,
  images: string[] = r.images,
  descImages: string[] = r.descImages,
): Listing {
  return {
    id: r.id,
    storeId: r.storeId,
    sourceItemId: r.sourceItemId,
    status: r.status,
    title: r.title,
    descriptionHtml: r.descriptionHtml,
    images,
    descImages,
    options: r.options,
    variants: r.variants,
    tags: r.tags,
    productType: r.productType,
    vendor: r.vendor,
    weightKg: r.weightKg,
    channelCategoryId: r.channelCategoryId,
    channelCategoryName: r.channelCategoryName,
    channelAttributes: r.channelAttributes,
    remoteId: r.remoteId,
    remoteUrl: r.remoteUrl,
    remoteStatus: r.remoteStatus,
    syncedAt: r.syncedAt?.toISOString() ?? null,
    lastError: r.lastError,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const listQuery = z.object({
  status: z.enum(["draft", "publishing", "published", "failed"]).optional(),
  storeId: z.string().uuid().optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

const variantSchema = z.object({
  sourceSkuId: z.string().optional(),
  sku: z.string().max(255),
  optionValues: z.array(z.string().min(1).max(255)).max(3),
  price: z.number().min(0),
  compareAtPrice: z.number().min(0).optional(),
  costCny: z.number().min(0).optional(),
  stock: z.number().int().optional(),
});

const patchSchema = z
  .object({
    title: z.string().trim().min(1).max(255),
    descriptionHtml: z.string().max(200_000),
    // source URLs or our own /api/media/<id> refs
    images: z
      .array(z.string().refine((u) => /^https?:\/\//.test(u) || /^\/api\/media\/[0-9a-f-]{36}$/.test(u)))
      .max(250),
    options: z
      .array(z.object({ name: z.string().min(1).max(255), values: z.array(z.string()) }))
      .max(3),
    variants: z.array(variantSchema).min(1).max(2048),
    tags: z.array(z.string().trim().min(1).max(255)).max(250),
    productType: z.string().max(255),
    vendor: z.string().max(255),
    weightKg: z.number().min(0).max(100_000).nullable(),
  })
  .partial()
  .refine(
    (p) =>
      !p.variants ||
      !p.options ||
      p.variants.every((v) => v.optionValues.length === p.options!.length),
    { message: "变体的选项值数量必须与选项数一致" },
  );

const idsSchema = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) });

const decideSchema = z.object({
  decisions: z
    .array(
      z.object({
        id: z.string().uuid(),
        action: z.enum(["accept", "reject"]),
        /** 类目建议：接受哪个候选（缺省取 AI 排第一的）。 */
        choice: z.string().max(500).optional(),
      }),
    )
    .min(1)
    .max(200),
});

function toSuggestionDto(r: typeof listingSuggestions.$inferSelect): ListingSuggestion {
  return {
    id: r.id,
    listingId: r.listingId,
    field: r.field,
    value: r.value,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

/** Write an accepted suggestion into the listing row (must run inside the caller's tx). */
function applySuggestion(
  listing: ListingRow,
  s: typeof listingSuggestions.$inferSelect,
): Partial<ListingRow> {
  switch (s.field) {
    case "title":
      return { title: String(s.value).slice(0, 255) };
    case "descriptionHtml":
      return { descriptionHtml: String(s.value).slice(0, 200_000) };
    case "productType":
      return { productType: String(s.value).slice(0, 255) };
    case "tags":
      return { tags: (s.value as string[]).slice(0, 250) };
    case "options": {
      const v = s.value as OptionsSuggestionValue;
      const variants = listing.variants.map((vr, i) => ({
        ...vr,
        optionValues: v.variantOptionValues[i] ?? vr.optionValues,
      }));
      return { options: v.options, variants };
    }
    case "attributes": {
      const v = s.value as AttributesSuggestionValue;
      return {
        channelAttributes: v.attributes.map((a) => ({
          attrId: a.attrId,
          name: a.attrName,
          value: a.value,
        })),
      };
    }
    default:
      return {};
  }
}

export function listingRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", zValidator("query", listQuery), async (c) => {
    const { db } = c.var.deps;
    const { status, storeId, q, page, pageSize } = c.req.valid("query");
    const where = and(
      eq(listings.workspaceId, c.var.auth.workspaceId),
      status ? eq(listings.status, status) : undefined,
      storeId ? eq(listings.storeId, storeId) : undefined,
      q ? ilike(listings.title, `%${q}%`) : undefined,
    );
    const [rows, [total]] = await Promise.all([
      db
        .select()
        .from(listings)
        .where(where)
        .orderBy(desc(listings.updatedAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize),
      db.select({ n: count() }).from(listings).where(where),
    ]);
    const show = await displayUrls(
      db,
      c.var.auth.workspaceId,
      rows.map((r) => [...r.images, ...r.descImages]),
    );
    return c.json({
      items: rows.map((r) => toListingDto(r, show(r.images), show(r.descImages))),
      total: total?.n ?? 0,
    });
  });

  r.get("/counts", async (c) => {
    const rows = await c.var.deps.db
      .select({ status: listings.status, n: count() })
      .from(listings)
      .where(eq(listings.workspaceId, c.var.auth.workspaceId))
      .groupBy(listings.status);
    return c.json(Object.fromEntries(rows.map((r) => [r.status, r.n])));
  });

  r.get("/:id", async (c) => {
    const [row] = await c.var.deps.db
      .select()
      .from(listings)
      .where(
        and(
          eq(listings.id, c.req.param("id")),
          eq(listings.workspaceId, c.var.auth.workspaceId),
        ),
      );
    if (!row) throw notFound("刊登");
    const show = await displayUrls(c.var.deps.db, c.var.auth.workspaceId, [
      [...row.images, ...row.descImages],
    ]);
    return c.json(toListingDto(row, show(row.images), show(row.descImages)));
  });

  r.patch("/:id", zValidator("json", patchSchema), async (c) => {
    const { db } = c.var.deps;
    const [row] = await db
      .update(listings)
      .set(c.req.valid("json"))
      .where(
        and(
          eq(listings.id, c.req.param("id")),
          eq(listings.workspaceId, c.var.auth.workspaceId),
          ne(listings.status, "publishing"),
        ),
      )
      .returning();
    if (!row) throw new HttpError(409, "刊登不存在或正在发布中");
    const show = await displayUrls(db, c.var.auth.workspaceId, [[...row.images, ...row.descImages]]);
    return c.json(toListingDto(row, show(row.images), show(row.descImages)));
  });

  /** Queue publish (first publish or re-sync of an already published product).
   *  发布门禁：命中店铺禁售词的刊登不排队，逐条返回命中原因。 */
  r.post("/publish", zValidator("json", idsSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { ids } = c.req.valid("json");
    const { queued, blocked } = await db.transaction(async (tx) => {
      const rows = await tx
        .select({ listing: listings, rules: stores.rules })
        .from(listings)
        .innerJoin(stores, eq(stores.id, listings.storeId))
        .where(
          and(
            eq(listings.workspaceId, workspaceId),
            inArray(listings.id, ids),
            ne(listings.status, "publishing"),
          ),
        );
      const blocked = rows.flatMap(({ listing: l, rules }) => {
        const hits = findBannedWords(l, rules?.bannedWords);
        return hits.length ? [{ id: l.id, title: l.title, words: hits }] : [];
      });
      const blockedIds = new Set(blocked.map((b) => b.id));
      const okIds = rows.filter((r) => !blockedIds.has(r.listing.id)).map((r) => r.listing.id);
      if (okIds.length) {
        await tx
          .update(listings)
          .set({ status: "publishing", lastError: null })
          .where(inArray(listings.id, okIds));
        for (const id of okIds) {
          await enqueue(tx, PUBLISH_LISTING, { listingId: id }, { workspaceId });
        }
      }
      return { queued: okIds.length, blocked };
    });
    return c.json({ queued, skipped: ids.length - queued - blocked.length, blocked });
  });

  /** 发布预览：不触碰远端，把这次发布会写出去的字段汇总返回
   *  （校验/禁售词检查同时跑，让「发布前检查」在点发布前就可见）。 */
  r.get("/:id/publish-preview", async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const [row] = await db
      .select({ listing: listings, store: stores })
      .from(listings)
      .innerJoin(stores, eq(stores.id, listings.storeId))
      .where(and(eq(listings.id, c.req.param("id")), eq(listings.workspaceId, workspaceId)));
    if (!row) throw notFound("刊登");
    const { listing, store } = row;

    const warnings: string[] = [];
    const validation = store.platform === "shopify" ? validateForShopify(listing) : null;
    if (validation) warnings.push(validation);
    const banned = findBannedWords(listing, store.rules?.bannedWords);
    if (banned.length) warnings.push(`发布前检查拦截：含禁售词 ${banned.join("、")}`);
    if (!listing.channelCategoryId) warnings.push("类目未映射，发布后需要在店铺后台手动选类目");

    const publishStatus = store.rules?.publishStatus ?? "active";
    const trackStock = !!store.rules?.trackStock;
    const input =
      store.platform === "shopify"
        ? toProductSetInput(listing, store.pricing.exchangeRate, listing.images, !listing.remoteId, {
            publishStatus,
            trackStock,
          })
        : null;

    return c.json({
      ok: warnings.length === 0,
      warnings,
      product: input
        ? {
            title: input.title,
            vendor: input.vendor ?? "",
            productType: input.productType ?? "",
            tags: input.tags,
            status: input.status ?? "(沿用店铺当前状态)",
            seo: input.seo,
            categoryId: input.category ?? "",
            categoryName: listing.channelCategoryName ?? "",
            imageCount: input.files.length + listing.descImages.length,
            options: (input.productOptions ?? []).map((o) => ({ name: o.name, values: o.values.map((v) => v.name) })),
            variants: input.variants.map((v) => ({
              sku: v.sku ?? "",
              price: v.price,
              compareAtPrice: v.compareAtPrice ?? "",
              cost: v.inventoryItem?.cost ?? "",
              optionValues: v.optionValues.map((o) => o.name),
            })),
            trackStock,
            attributes: listing.channelAttributes.map((a) => ({ name: a.name, value: a.value })),
          }
        : null,
    });
  });

  /** Queue delist: 已发布 + 有 remoteId 的刊登下架（远端 status→DRAFT，刊登记录保留）。 */
  r.post("/delist", zValidator("json", idsSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { ids } = c.req.valid("json");
    const rows = await db
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.workspaceId, workspaceId),
          inArray(listings.id, ids),
          eq(listings.status, "published"),
        ),
      );
    const okIds = rows.map((r) => r.id);
    if (okIds.length) {
      await db.transaction(async (tx) => {
        for (const id of okIds) {
          await enqueue(tx, DELIST_LISTING, { listingId: id }, { workspaceId });
        }
      });
    }
    return c.json({ queued: okIds.length, skipped: ids.length - okIds.length });
  });

  /** AI 建议列表 + 是否还有 AI 任务在跑（用于轮询提示）。 */
  r.get("/:id/suggestions", async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const listingId = c.req.param("id");
    const [listing] = await db
      .select({ id: listings.id })
      .from(listings)
      .where(and(eq(listings.id, listingId), eq(listings.workspaceId, workspaceId)));
    if (!listing) throw notFound("刊登");
    const [items, pendingJobs] = await Promise.all([
      db
        .select()
        .from(listingSuggestions)
        .where(
          and(
            eq(listingSuggestions.listingId, listingId),
            eq(listingSuggestions.workspaceId, workspaceId),
          ),
        )
        .orderBy(desc(listingSuggestions.createdAt)),
      db
        .select({ id: jobs.id })
        .from(jobs)
        .where(
          and(
            inArray(jobs.type, [AI_ENHANCE_LISTING, CATEGORY_SUGGEST]),
            inArray(jobs.status, ["queued", "running"]),
            sql`${jobs.payload}->>'listingId' = ${listingId}`,
          ),
        )
        .limit(1),
    ]);
    return c.json({ items: items.map(toSuggestionDto), pending: pendingJobs.length > 0 });
  });

  /** 手动改类目：设置刊登类目并把映射记住（有来源类目时）。 */
  r.post(
    "/:id/category",
    zValidator(
      "json",
      z.object({
        channelCategoryId: z.string().min(1).max(500),
        channelCategoryName: z.string().min(1).max(500),
        /** false = 只改这条刊登，不写入类目映射 */
        remember: z.boolean().default(true),
      }),
    ),
    async (c) => {
      const { db } = c.var.deps;
      const { workspaceId } = c.var.auth;
      const listingId = c.req.param("id");
      const body = c.req.valid("json");
      const [row] = await db
        .select({ listing: listings, storePlatform: stores.platform, item: sourceItems })
        .from(listings)
        .innerJoin(stores, eq(stores.id, listings.storeId))
        .innerJoin(sourceItems, eq(sourceItems.id, listings.sourceItemId))
        .where(
          and(eq(listings.id, listingId), eq(listings.workspaceId, workspaceId)),
        );
      if (!row) throw notFound("刊登");
      const [updated] = await db
        .update(listings)
        .set({
          channelCategoryId: body.channelCategoryId,
          channelCategoryName: body.channelCategoryName,
        })
        .where(eq(listings.id, listingId))
        .returning();
      if (body.remember && row.item.sourceCategoryId) {
        await upsertCategoryMapping(db, {
          workspaceId,
          sourcePlatform: row.item.sourcePlatform,
          sourceCategoryId: row.item.sourceCategoryId,
          sourceCategoryName: row.item.sourceCategoryName,
          channel: row.storePlatform,
          candidate: {
            id: body.channelCategoryId,
            name: body.channelCategoryName.split(">").pop()?.trim() || body.channelCategoryName,
            fullName: body.channelCategoryName,
          },
          confidence: 100,
          confirmedBy: "user",
          version: TAXONOMY_VERSION,
        });
      }
      return c.json(toListingDto(updated!));
    },
  );

  /** Accept → write the field into the listing; reject → mark. Batch in one tx. */
  r.post("/:id/suggestions/decide", zValidator("json", decideSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const listingId = c.req.param("id");
    const { decisions } = c.req.valid("json");

    const result = await db.transaction(async (tx) => {
      const [row] = await tx
        .select({ listing: listings, storePlatform: stores.platform, storeLanguage: stores.language })
        .from(listings)
        .innerJoin(stores, eq(stores.id, listings.storeId))
        .where(
          and(
            eq(listings.id, listingId),
            eq(listings.workspaceId, workspaceId),
            ne(listings.status, "publishing"),
          ),
        );
      if (!row) throw new HttpError(409, "刊登不存在或正在发布中");
      const { listing } = row;
      const ids = decisions.map((d) => d.id);
      const rows = await tx
        .select()
        .from(listingSuggestions)
        .where(
          and(
            inArray(listingSuggestions.id, ids),
            eq(listingSuggestions.listingId, listingId),
            eq(listingSuggestions.workspaceId, workspaceId),
            eq(listingSuggestions.status, "pending"),
          ),
        );
      const byId = new Map(rows.map((r) => [r.id, r]));
      let accepted = 0;
      let rejected = 0;
      const listingPatch: Partial<ListingRow> = {};
      for (const d of decisions) {
        const s = byId.get(d.id);
        if (!s) continue;
        if (d.action === "accept") {
          if (s.field === "category") {
            const v = s.value as CategorySuggestionValue;
            const cand =
              v.candidates.find((cd) => cd.id === d.choice) ?? v.candidates[0];
            if (!cand) throw new HttpError(400, "类目建议没有可选候选");
            Object.assign(listingPatch, {
              channelCategoryId: cand.id,
              channelCategoryName: cand.fullName || cand.name,
            });
            // 用户确认即记住：同来源类目以后自动套用
            await upsertCategoryMapping(tx, {
              workspaceId,
              sourcePlatform: "1688",
              sourceCategoryId: v.sourceCategoryId ?? "",
              sourceCategoryName: v.sourceCategoryName,
              channel: row.storePlatform,
              candidate: cand,
              confidence: 100,
              confirmedBy: "user",
              version: TAXONOMY_VERSION,
            });
          } else {
            Object.assign(listingPatch, applySuggestion(listing, s));
            if (s.field === "options") {
              const v = s.value as OptionsSuggestionValue;
              // 接受即学习：以建议生成时的选项快照为准（用户可能已改过草稿），按位成对存术语映射
              const pairs: Array<[string, string]> = [];
              (v.sourceOptions ?? listing.options).forEach((o, i) => {
                pairs.push([o.name, v.options[i]?.name ?? o.name]);
                o.values.forEach((sv, j) => {
                  pairs.push([sv, v.options[i]?.values[j] ?? sv]);
                });
              });
              await upsertTermPairs(tx, workspaceId, row.storeLanguage, pairs);
            }
            // 接受属性提案即记住 源属性名→平台属性 映射
            if (s.field === "attributes") {
              const v = s.value as AttributesSuggestionValue;
              await upsertAttrMappings(
                tx,
                workspaceId,
                row.storePlatform,
                v.attributes.map((a) => ({
                  sourceName: a.sourceName,
                  attrId: a.attrId,
                  attrName: a.attrName,
                })),
              );
            }
          }
          accepted++;
        } else rejected++;
        await tx
          .update(listingSuggestions)
          .set({ status: d.action === "accept" ? "accepted" : "rejected" })
          .where(eq(listingSuggestions.id, s.id));
      }
      if (Object.keys(listingPatch).length) {
        await tx.update(listings).set(listingPatch).where(eq(listings.id, listingId));
      }
      return { accepted, rejected };
    });
    return c.json(result);
  });

  /** Manually re-run the AI pass (fresh suggestions supersede pending ones). */
  r.post("/:id/ai-enhance", async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const [listing] = await db
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.id, c.req.param("id")),
          eq(listings.workspaceId, workspaceId),
        ),
      );
    if (!listing) throw notFound("刊登");
    const queued = await enqueueAiEnhance(db, [listing.id], workspaceId);
    return c.json({ queued: queued > 0 });
  });

  /** 把刊登复制到另一个店铺：内容字段原样带走（含已编辑/AI 优化结果），
   *  remoteId/远端状态清掉——对目标店铺而言是全新草稿。变体价格沿用原值
   *  （两店铺币种可能不同，复制后需要按目标店铺定价人工核对）。 */
  r.post(
    "/:id/copy",
    zValidator("json", z.object({ storeId: z.string().uuid() })),
    async (c) => {
      const { db } = c.var.deps;
      const { workspaceId } = c.var.auth;
      const id = c.req.param("id");
      const { storeId } = c.req.valid("json");
      const [src] = await db
        .select()
        .from(listings)
        .where(and(eq(listings.id, id), eq(listings.workspaceId, workspaceId)));
      if (!src) throw notFound("刊登");
      const [store] = await db
        .select({ id: stores.id })
        .from(stores)
        .where(
          and(eq(stores.id, storeId), eq(stores.workspaceId, workspaceId), ne(stores.status, "disconnected")),
        );
      if (!store) throw notFound("店铺");
      const [copy] = await db
        .insert(listings)
        .values({
          workspaceId,
          storeId,
          sourceItemId: src.sourceItemId,
          status: "draft",
          title: src.title,
          descriptionHtml: src.descriptionHtml,
          images: src.images,
          descImages: src.descImages,
          options: src.options,
          variants: src.variants,
          tags: src.tags,
          productType: src.productType,
          vendor: src.vendor,
          weightKg: src.weightKg,
          channelCategoryId: src.channelCategoryId,
          channelCategoryName: src.channelCategoryName,
          channelAttributes: src.channelAttributes,
        })
        .returning();
      const show = await displayUrls(db, workspaceId, [[...copy!.images, ...copy!.descImages]]);
      return c.json(toListingDto(copy!, show(copy!.images), show(copy!.descImages)), 201);
    },
  );

  /** Removes our draft only; a product already on the shop stays there. */
  r.post("/delete", zValidator("json", idsSchema), async (c) => {
    const deleted = await c.var.deps.db
      .delete(listings)
      .where(
        and(
          eq(listings.workspaceId, c.var.auth.workspaceId),
          inArray(listings.id, c.req.valid("json").ids),
          ne(listings.status, "publishing"),
        ),
      )
      .returning({ id: listings.id });
    return c.json({ deleted: deleted.length });
  });

  return r;
}
