import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, ilike, inArray, ne, sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { Listing, ListingSuggestion, OptionsSuggestionValue } from "@caiji/shared";
import type { ListingRow } from "../channels/types.js";
import type { AppEnv } from "../context.js";
import { jobs, listings, listingSuggestions } from "../db/schema.js";
import { HttpError, notFound } from "../lib/errors.js";
import { AI_ENHANCE_LISTING, enqueueAiEnhance, PUBLISH_LISTING } from "../jobs/handlers.js";
import { enqueue } from "../jobs/queue.js";
import { requireAuth } from "./auth.js";
import { displayUrls } from "./media.js";

/** `images` defaults to stored refs; pass display URLs (our copies) when resolved. */
export function toListingDto(r: ListingRow, images: string[] = r.images): Listing {
  return {
    id: r.id,
    storeId: r.storeId,
    sourceItemId: r.sourceItemId,
    status: r.status,
    title: r.title,
    descriptionHtml: r.descriptionHtml,
    images,
    options: r.options,
    variants: r.variants,
    tags: r.tags,
    productType: r.productType,
    vendor: r.vendor,
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
    const show = await displayUrls(db, c.var.auth.workspaceId, rows.map((r) => r.images));
    return c.json({ items: rows.map((r) => toListingDto(r, show(r.images))), total: total?.n ?? 0 });
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
    const show = await displayUrls(c.var.deps.db, c.var.auth.workspaceId, [row.images]);
    return c.json(toListingDto(row, show(row.images)));
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
    const show = await displayUrls(db, c.var.auth.workspaceId, [row.images]);
    return c.json(toListingDto(row, show(row.images)));
  });

  /** Queue publish (first publish or re-sync of an already published product). */
  r.post("/publish", zValidator("json", idsSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { ids } = c.req.valid("json");
    const queued = await db.transaction(async (tx) => {
      const rows = await tx
        .update(listings)
        .set({ status: "publishing", lastError: null })
        .where(
          and(
            eq(listings.workspaceId, workspaceId),
            inArray(listings.id, ids),
            ne(listings.status, "publishing"),
          ),
        )
        .returning({ id: listings.id });
      for (const row of rows) {
        await enqueue(tx, PUBLISH_LISTING, { listingId: row.id }, { workspaceId });
      }
      return rows.length;
    });
    return c.json({ queued, skipped: ids.length - queued });
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
            eq(jobs.type, AI_ENHANCE_LISTING),
            inArray(jobs.status, ["queued", "running"]),
            sql`${jobs.payload}->>'listingId' = ${listingId}`,
          ),
        )
        .limit(1),
    ]);
    return c.json({ items: items.map(toSuggestionDto), pending: pendingJobs.length > 0 });
  });

  /** Accept → write the field into the listing; reject → mark. Batch in one tx. */
  r.post("/:id/suggestions/decide", zValidator("json", decideSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const listingId = c.req.param("id");
    const { decisions } = c.req.valid("json");

    const result = await db.transaction(async (tx) => {
      const [listing] = await tx
        .select()
        .from(listings)
        .where(
          and(
            eq(listings.id, listingId),
            eq(listings.workspaceId, workspaceId),
            ne(listings.status, "publishing"),
          ),
        );
      if (!listing) throw new HttpError(409, "刊登不存在或正在发布中");
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
          Object.assign(listingPatch, applySuggestion(listing, s));
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
