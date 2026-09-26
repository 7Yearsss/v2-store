import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, ilike, inArray, notExists } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { SourceItem, SourcePlatform } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import { listings, sourceItems, stores } from "../db/schema.js";
import { claimItems } from "../lib/claim.js";
import { HttpError, notFound } from "../lib/errors.js";
import { advancePolicy } from "../lib/pipeline.js";
import {
  enqueueAiEnhance,
  enqueuePipelineAdvance,
  enterPipeline,
} from "../jobs/handlers.js";
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
  /** 认领并发布：以「策略全开」快照进入链路（holdPoint/autoPublish 强制全开，其余沿用店铺配置）。 */
  advance: z.boolean().optional(),
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
    const { ids, storeIds, advance } = c.req.valid("json");

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

    const created = await claimItems(db, workspaceId, items, targetStores);
    // 认领即入 AI 产线（店铺设置可关、服务端需配 AI）；aiEnhance job 是 stage 注册表入口，
    // enhance 与类目建议都由它按序跑。建议出现在刊登编辑页，接受前不改草稿。
    if (c.var.deps.config.ai) {
      const aiStoreIds = new Set(
        targetStores.filter((s) => s.aiEnhance === "on").map((s) => s.id),
      );
      await enqueueAiEnhance(
        db,
        created.filter((l) => aiStoreIds.has(l.storeId)).map((l) => l.id),
        workspaceId,
      );
    }
    // 认领并发布：新建刊登进入链路（策略全开快照）；已有刊登推进或补入场
    if (advance) {
      for (const store of targetStores) {
        const policy = advancePolicy(store.rules?.pipeline);
        for (const item of items) {
          const createdRow = created.find(
            (l) => l.storeId === store.id && l.sourceItemId === item.id,
          );
          if (createdRow) {
            await enterPipeline(db, createdRow.id, policy);
            continue;
          }
          const [l] = await db
            .select({ id: listings.id, pipelineStage: listings.pipelineStage })
            .from(listings)
            .where(
              and(eq(listings.storeId, store.id), eq(listings.sourceItemId, item.id)),
            );
          if (!l) continue; // 被认领规则过滤掉：没刊登可发
          if (l.pipelineStage) {
            // 已在链路：等同人工推进（暂停/卡点放行）
            await enqueuePipelineAdvance(db, l.id, workspaceId, { manual: true });
          } else {
            await enterPipeline(db, l.id, policy);
          }
        }
      }
    }
    return c.json({
      created: created.length,
      // 应建数（item×store 全组合）- 实建数：含已认领冲突与规则过滤掉的。
      skipped: targetStores.length * items.length - created.length,
    });
  });

  return r;
}
