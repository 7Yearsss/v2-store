import { zValidator } from "@hono/zod-validator";
import {
  and,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type {
  AttributesSuggestionValue,
  CategorySuggestionValue,
  Listing,
  ListingSuggestion,
  OptionsSuggestionValue,
  SourceChangeType,
} from "@caiji/shared";
import { audit } from "../lib/audit.js";
import { adapterFor } from "../channels/index.js";
import type { ListingRow } from "../channels/types.js";
import type { AppEnv } from "../context.js";
import {
  jobs,
  listings,
  listingSuggestions,
  publishAttempts,
  publishRuns,
  sourceChanges,
  sourceItems,
  stores,
} from "../db/schema.js";
import { listAudits } from "../lib/audit.js";
import { toFieldsSnapshot } from "../lib/drift.js";
import { HttpError, notFound } from "../lib/errors.js";
import { TAXONOMY_VERSION, upsertCategoryMapping } from "../lib/category.js";
import { findBannedWords } from "../lib/rules.js";
import { acceptSuggestion } from "../lib/suggestions.js";
import {
  AI_ENHANCE_LISTING,
  CATEGORY_SUGGEST,
  DELIST_LISTING,
  dequeueQueuedPublish,
  enqueueAiEnhance,
  enqueueAiImage,
  enqueuePipelineAdvance,
  enterPipeline,
  PUBLISH_LISTING,
} from "../jobs/handlers.js";
import { toProductSetInput } from "../channels/shopify/adapter.js";
import { toAttemptDto } from "./publish.js";
import { enqueue } from "../jobs/queue.js";
import { requireAuth } from "./auth.js";
import { displayUrls } from "./media.js";

/** `images`/`descImages` default to stored refs; pass display URLs (our copies) when resolved.
 *  `monitor` = 列表页聚合出的未消费货源变更概览。 */
export function toListingDto(
  r: ListingRow,
  images: string[] = r.images,
  descImages: string[] = r.descImages,
  monitor?: { pending: number; types: SourceChangeType[] },
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
    linkStatus: r.linkStatus,
    syncPolicy: r.syncPolicy,
    remoteSnapshot: r.remoteSnapshot,
    remoteDrift: r.remoteDrift,
    lastPulledAt: r.lastPulledAt?.toISOString() ?? null,
    lastAutoAction: r.lastAutoAction,
    sourceChangedAt: r.sourceChangedAt?.toISOString() ?? null,
    internalTags: r.internalTags,
    publishAt: r.publishAt?.toISOString() ?? null,
    ...(monitor ? { sourceMonitor: monitor } : {}),
    syncedAt: r.syncedAt?.toISOString() ?? null,
    lastError: r.lastError,
    publishedAt: r.publishedAt?.toISOString() ?? null,
    pipelineStage: r.pipelineStage,
    pipelineHoldReason: r.pipelineHoldReason,
    policySnapshot: r.policySnapshot ?? null,
    remoteVariantMap: r.remoteVariantMap ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

const listQuery = z.object({
  status: z.enum(["draft", "publishing", "published", "failed"]).optional(),
  pipelineStage: z
    .enum([
      "claimed",
      "ai_running",
      "hold_ai",
      "precheck",
      "hold_precheck",
      "queued",
      "publishing",
      "published",
      "failed",
    ])
    .optional(),
  storeId: z.string().uuid().optional(),
  sourceItemId: z.string().uuid().optional(),
  /** 内部标记过滤（text[] 包含）。 */
  tag: z.string().trim().max(100).optional(),
  /** 关注页过滤：drift ∪ 未消费货源变更 ∪ remote_deleted ∪ 货源已下架。
   *  （coerce.boolean 会把 "false" 当 true，用枚举转换）。 */
  watch: z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? undefined : v === "true" || v === "1")),
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
    /** 漂移处理策略（部分更新，服务端与现值合并）。 */
    syncPolicy: z
      .object({
        stock: z.enum(["auto", "notify", "off"]),
        content: z.enum(["notify", "off"]),
        price: z.enum(["auto", "notify", "off"]),
      })
      .partial(),
    /** 内部运营标签（不上渠道）。 */
    internalTags: z.array(z.string().trim().min(1).max(64)).max(50),
    publishAt: z.string().datetime().nullable(),
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
    stage: r.stage,
    value: r.value,
    status: r.status,
    createdAt: r.createdAt.toISOString(),
  };
}

export function listingRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", zValidator("query", listQuery), async (c) => {
    const { db } = c.var.deps;
    const workspaceId = c.var.auth.workspaceId;
    const { status, pipelineStage, storeId, sourceItemId, tag, watch, q, page, pageSize } =
      c.req.valid("query");
    const where = and(
      eq(listings.workspaceId, workspaceId),
      status ? eq(listings.status, status) : undefined,
      pipelineStage ? eq(listings.pipelineStage, pipelineStage) : undefined,
      storeId ? eq(listings.storeId, storeId) : undefined,
      sourceItemId ? eq(listings.sourceItemId, sourceItemId) : undefined,
      tag ? sql`${tag} = any(${listings.internalTags})` : undefined,
      watch
        ? or(
            sql`coalesce(jsonb_array_length(${listings.remoteDrift}), 0) > 0`,
            eq(listings.linkStatus, "remote_deleted"),
            exists(
              db
                .select({ id: sourceChanges.id })
                .from(sourceChanges)
                .where(
                  and(
                    eq(sourceChanges.workspaceId, workspaceId),
                    eq(sourceChanges.sourceItemId, listings.sourceItemId),
                    isNull(sourceChanges.appliedAt),
                  ),
                ),
            ),
            exists(
              db
                .select({ id: sourceItems.id })
                .from(sourceItems)
                .where(
                  and(
                    eq(sourceItems.id, listings.sourceItemId),
                    eq(sourceItems.availability, "delisted"),
                  ),
                ),
            ),
          )
        : undefined,
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
    // 每条刊登的未消费货源变更概览（黄标文案用）
    const itemIds = [...new Set(rows.map((r) => r.sourceItemId))];
    const pendingRows = itemIds.length
      ? await db
          .select({
            sid: sourceChanges.sourceItemId,
            n: count(),
            types: sql<string[]>`array_agg(distinct ${sourceChanges.changeType})`,
          })
          .from(sourceChanges)
          .where(
            and(
              eq(sourceChanges.workspaceId, workspaceId),
              inArray(sourceChanges.sourceItemId, itemIds),
              isNull(sourceChanges.appliedAt),
            ),
          )
          .groupBy(sourceChanges.sourceItemId)
      : [];
    const pendingByItem = new Map(
      pendingRows.map((r) => [
        r.sid,
        { pending: r.n, types: r.types as SourceChangeType[] },
      ]),
    );
    const show = await displayUrls(
      db,
      workspaceId,
      rows.map((r) => [...r.images, ...r.descImages]),
    );
    return c.json({
      items: rows.map((r) =>
        toListingDto(
          r,
          show(r.images),
          show(r.descImages),
          pendingByItem.get(r.sourceItemId),
        ),
      ),
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
    const body = c.req.valid("json");
    const { syncPolicy, ...rest } = body;
    const patch: Partial<ListingRow> = {
      ...rest,
      publishAt:
        rest.publishAt === undefined
          ? undefined
          : rest.publishAt
            ? new Date(rest.publishAt)
            : null,
    };
    if (syncPolicy) {
      const [cur] = await db
        .select({ syncPolicy: listings.syncPolicy })
        .from(listings)
        .where(
          and(
            eq(listings.id, c.req.param("id")),
            eq(listings.workspaceId, c.var.auth.workspaceId),
          ),
        );
      if (!cur) throw notFound("刊登");
      patch.syncPolicy = { ...cur.syncPolicy, ...syncPolicy };
    }
    const [row] = await db
      .update(listings)
      .set(patch)
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
   *  一次调用形成一个 publish_run + 每刊登一条 publish_attempt（含门禁失败的）；
   *  jobs 仍是执行队列，payload.attemptId 让 job handler 回写 attempt/run。
   *  发布门禁：命中店铺禁售词的刊登不排队，记为 failed attempt（可归一化 code）。 */
  r.post("/publish", zValidator("json", idsSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId, userId } = c.var.auth;
    const { ids } = c.req.valid("json");
    const { queued, blocked, runId } = await db.transaction(async (tx) => {
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
      if (!rows.length) return { queued: 0, blocked: [], runId: null };
      const blocked = rows.flatMap(({ listing: l, rules }) => {
        const hits = findBannedWords(l, rules?.bannedWords);
        return hits.length ? [{ id: l.id, title: l.title, words: hits }] : [];
      });
      const blockedIds = new Set(blocked.map((b) => b.id));
      const [run] = await tx
        .insert(publishRuns)
        .values({
          workspaceId,
          createdBy: userId,
          listingIds: rows.map((r) => r.listing.id),
          status: blocked.length === rows.length ? "failed" : "queued",
        })
        .returning({ id: publishRuns.id });
      for (const { listing: l } of rows) {
        const snapshot = toFieldsSnapshot(l);
        if (blockedIds.has(l.id)) {
          const words = blocked.find((b) => b.id === l.id)!.words;
          await tx.insert(publishAttempts).values({
            workspaceId,
            runId: run!.id,
            listingId: l.id,
            storeId: l.storeId,
            status: "failed",
            error: `发布前检查拦截：含禁售词 ${words.join("、")}`,
            errorCode: "review_rejected",
            fieldsSnapshot: snapshot,
          });
          continue;
        }
        await tx
          .update(listings)
          .set({ status: "publishing", lastError: null })
          .where(eq(listings.id, l.id));
        const [attempt] = await tx
          .insert(publishAttempts)
          .values({
            workspaceId,
            runId: run!.id,
            listingId: l.id,
            storeId: l.storeId,
            status: "queued",
            fieldsSnapshot: snapshot,
          })
          .returning({ id: publishAttempts.id });
        await enqueue(tx, PUBLISH_LISTING, { listingId: l.id, attemptId: attempt!.id }, { workspaceId });
      }
      return { queued: rows.length - blocked.length, blocked, runId: run!.id };
    });
    return c.json({ queued, skipped: ids.length - queued - blocked.length, blocked, runId });
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
    // 预览与发布共用同一份结构化校验（ChannelAdapter.validate）
    const issues = await adapterFor(store.platform).validate(c.var.deps, store, listing);
    for (const i of issues) {
      if ((i.severity ?? "block") === "block") warnings.push(i.message);
    }
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
      issues,
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

  /** 托管详情：列表 DTO 之外补远端快照/漂移/策略/最近自动动作 + 最近发布 attempts（三栏页用）。 */
  r.get("/:id/managed", async (c) => {
    const { db } = c.var.deps;
    const [row] = await db
      .select()
      .from(listings)
      .where(
        and(
          eq(listings.id, c.req.param("id")),
          eq(listings.workspaceId, c.var.auth.workspaceId),
        ),
      );
    if (!row) throw notFound("刊登");
    const attemptRows = await db
      .select()
      .from(publishAttempts)
      .where(
        and(
          eq(publishAttempts.listingId, row.id),
          eq(publishAttempts.workspaceId, c.var.auth.workspaceId),
        ),
      )
      .orderBy(desc(publishAttempts.createdAt))
      .limit(20);
    return c.json({
      listing: toListingDto(row),
      attempts: attemptRows.map(toAttemptDto),
    });
  });

  /** 审计列表（刊登维度）：发布、远端标记删除、自动库存动作等，全部留痕可查。 */
  r.get("/:id/audits", async (c) => {
    const { db } = c.var.deps;
    const [row] = await db
      .select({ id: listings.id })
      .from(listings)
      .where(
        and(
          eq(listings.id, c.req.param("id")),
          eq(listings.workspaceId, c.var.auth.workspaceId),
        ),
      );
    if (!row) throw notFound("刊登");
    return c.json({ audits: await listAudits(db, c.var.auth.workspaceId, "listing", row.id) });
  });

  /** 批量工具（fl-monitor）：价格设/乘/加、内部标签增删、同步策略、定时发布、
   *  批量开启监控（= 把勾选刊登的 stock/price 策略置 auto）。 */
  const batchSchema = z.object({
    ids: z.array(z.string().uuid()).min(1).max(200),
    ops: z
      .array(
        z.discriminatedUnion("op", [
          z.object({ op: z.literal("price_set"), value: z.number().min(0).max(1_000_000) }),
          z.object({ op: z.literal("price_mul"), value: z.number().min(0).max(1000) }),
          z.object({ op: z.literal("price_add"), value: z.number().min(-1_000_000).max(1_000_000) }),
          z.object({
            op: z.literal("internal_tag"),
            add: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
            remove: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
          }),
          z.object({
            op: z.literal("sync_policy"),
            value: z
              .object({
                stock: z.enum(["auto", "notify", "off"]),
                content: z.enum(["notify", "off"]),
                price: z.enum(["auto", "notify", "off"]),
              })
              .partial(),
          }),
          z.object({ op: z.literal("publish_at"), value: z.string().datetime().nullable() }),
          z.object({ op: z.literal("monitor_enable"), value: z.boolean().optional() }),
        ]),
      )
      .min(1)
      .max(10),
  });

  const round2 = (n: number) => Math.round(n * 100) / 100;

  r.post("/batch", zValidator("json", batchSchema), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { ids, ops } = c.req.valid("json");
    const rows = await db
      .select()
      .from(listings)
      .where(
        and(
          eq(listings.workspaceId, workspaceId),
          inArray(listings.id, ids),
          ne(listings.status, "publishing"),
        ),
      );
    let updated = 0;
    for (const l of rows) {
      const patch: Partial<ListingRow> = {};
      for (const op of ops) {
        switch (op.op) {
          case "price_set":
            patch.variants = (patch.variants ?? l.variants).map((v) => ({
              ...v,
              price: round2(op.value),
            }));
            break;
          case "price_mul":
            patch.variants = (patch.variants ?? l.variants).map((v) => ({
              ...v,
              price: round2(v.price * op.value),
            }));
            break;
          case "price_add":
            patch.variants = (patch.variants ?? l.variants).map((v) => ({
              ...v,
              price: Math.max(0, round2(v.price + op.value)),
            }));
            break;
          case "internal_tag": {
            const cur = new Set(patch.internalTags ?? l.internalTags);
            for (const t of op.add ?? []) cur.add(t);
            for (const t of op.remove ?? []) cur.delete(t);
            patch.internalTags = [...cur].sort();
            break;
          }
          case "sync_policy":
            patch.syncPolicy = { ...(patch.syncPolicy ?? l.syncPolicy), ...op.value };
            break;
          case "publish_at":
            patch.publishAt = op.value ? new Date(op.value) : null;
            break;
          case "monitor_enable": {
            const on = op.value !== false;
            const cur = patch.syncPolicy ?? l.syncPolicy;
            patch.syncPolicy = on
              ? { ...cur, stock: "auto", price: "auto" }
              : { ...cur, stock: "notify", price: "notify" };
            break;
          }
        }
      }
      if (!Object.keys(patch).length) continue;
      await db
        .update(listings)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(listings.id, l.id));
      updated++;
      await audit(db, workspaceId, {
        actor: `user:${c.var.auth.userId}`,
        action: "listing.batch",
        entityType: "listing",
        entityId: l.id,
        payload: { ops: ops.map((o) => o.op) },
      });
    }
    return c.json({ updated, skipped: ids.length - updated });
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
        .select({
          listing: listings,
          storePlatform: stores.platform,
          storeLanguage: stores.language,
          sourcePlatform: sourceItems.sourcePlatform,
        })
        .from(listings)
        .innerJoin(stores, eq(stores.id, listings.storeId))
        .innerJoin(sourceItems, eq(sourceItems.id, listings.sourceItemId))
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
          // apply + 学习钩子（类目映射/术语对/属性映射）都在 acceptSuggestion 里，
          // 与链路 autoAccept 完全同一套。
          Object.assign(
            listingPatch,
            await acceptSuggestion(tx, listing, s, {
              workspaceId,
              storePlatform: row.storePlatform,
              storeLanguage: row.storeLanguage,
              sourcePlatform: row.sourcePlatform,
              confirmedBy: "user",
              choice: d.choice,
            }),
          );
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

  /** 链路进度：手工推进（越过所有卡点/熔断；queued 时提前放行发布）。
   *  未入链路的刊登带上策略进入（链路从此刻开始）。 */
  r.post(
    "/:id/pipeline/advance",
    zValidator(
      "json",
      z
        .object({
          /** 本次推进同时覆盖 autoAccept 白名单（写进策略快照）。 */
          fields: z
            .array(
              z.enum([
                "title",
                "descriptionHtml",
                "productType",
                "tags",
                "options",
                "category",
                "attributes",
              ]),
            )
            .max(7)
            .optional(),
        })
        .optional(),
    ),
    async (c) => {
      const { db } = c.var.deps;
      const { workspaceId } = c.var.auth;
      const listingId = c.req.param("id");
      const body = c.req.valid("json") ?? {};
      const [row] = await db
        .select({ listing: listings, store: stores })
        .from(listings)
        .innerJoin(stores, eq(stores.id, listings.storeId))
        .where(and(eq(listings.id, listingId), eq(listings.workspaceId, workspaceId)));
      if (!row) throw notFound("刊登");
      const { listing, store } = row;
      if (listing.pipelineStage == null) {
        // 链外刊登：按店铺策略入场（fields 覆盖进快照）
        await enterPipeline(db, listingId, {
          ...(store.rules?.pipeline ?? {}),
          ...(body.fields ? { autoAcceptFields: body.fields } : {}),
        });
        return c.json({ ok: true, stage: "claimed" });
      }
      if (body.fields) {
        await db
          .update(listings)
          .set({
            policySnapshot: {
              ...(listing.policySnapshot ?? store.rules?.pipeline ?? {}),
              autoAcceptFields: body.fields,
            },
          })
          .where(eq(listings.id, listingId));
      }
      await enqueuePipelineAdvance(db, listingId, workspaceId, { manual: true });
      return c.json({ ok: true, stage: listing.pipelineStage });
    },
  );

  /** 链路暂停：在途自动推进停下（stage 保留在原地）；queued 时撤销排队发布。 */
  r.post("/:id/pipeline/pause", async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const listingId = c.req.param("id");
    const [listing] = await db
      .select({ id: listings.id, pipelineStage: listings.pipelineStage })
      .from(listings)
      .where(and(eq(listings.id, listingId), eq(listings.workspaceId, workspaceId)));
    if (!listing) throw notFound("刊登");
    if (!listing.pipelineStage) throw new HttpError(409, "刊登不在链路里");
    if (listing.pipelineStage === "queued") {
      // 排队发布撤回到卡点；失败态/发布态没什么好暂停的
      await dequeueQueuedPublish(db, listingId);
    }
    const [cur] = await db
      .update(listings)
      .set({
        pipelineHoldReason: "manual",
        pipelineStage: sql`case when ${listings.pipelineStage} = 'queued' then 'hold_precheck' else ${listings.pipelineStage} end`,
      })
      .where(and(eq(listings.id, listingId), ne(listings.pipelineStage, "published")))
      .returning({ pipelineStage: listings.pipelineStage });
    return c.json({ ok: true, stage: cur?.pipelineStage ?? listing.pipelineStage });
  });

  /** 退出链路：清 stage/快照/排定时间，撤销排队发布（发布中/已发布不动）。 */
  r.post("/:id/pipeline/cancel", async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const listingId = c.req.param("id");
    const [listing] = await db
      .select({ id: listings.id, pipelineStage: listings.pipelineStage })
      .from(listings)
      .where(and(eq(listings.id, listingId), eq(listings.workspaceId, workspaceId)));
    if (!listing) throw notFound("刊登");
    if (!listing.pipelineStage) throw new HttpError(409, "刊登不在链路里");
    if (listing.pipelineStage === "queued") await dequeueQueuedPublish(db, listingId);
    // publishing/published 由发布 job 收尾时自己置终态，这里只清快照
    await db
      .update(listings)
      .set({
        pipelineStage: sql`case when ${listings.pipelineStage} in ('publishing','published') then ${listings.pipelineStage} else null end`,
        pipelineHoldReason: null,
        policySnapshot: null,
        publishAt: null,
      })
      .where(eq(listings.id, listingId));
    return c.json({ ok: true });
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

  /** AI 图片编辑：对刊登的某张图生成变体（当前支持 whiteBg 白底图），
   *  完成后插在原图后面，用户可自行删除/排序。 */
  r.post(
    "/:id/ai-image",
    zValidator(
      "json",
      z.object({
        /** 用 URL 而非下标：编辑器草稿可能有未保存的删图，下标对不上服务端数组 */
        imageUrl: z.string().min(1),
        action: z.enum(["whiteBg"]).default("whiteBg"),
      }),
    ),
    async (c) => {
      const { db } = c.var.deps;
      const { workspaceId } = c.var.auth;
      const { imageUrl, action } = c.req.valid("json");
      const [listing] = await db
        .select({ id: listings.id, images: listings.images })
        .from(listings)
        .where(
          and(eq(listings.id, c.req.param("id")), eq(listings.workspaceId, workspaceId)),
        );
      if (!listing) throw notFound("刊登");
      if (!listing.images.includes(imageUrl)) {
        throw new HttpError(400, "该图片不在已保存的刊登里，请先保存图片编辑");
      }
      const queued = await enqueueAiImage(db, listing.id, workspaceId, imageUrl, action);
      return c.json({ queued });
    },
  );

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
