import { and, count, desc, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { AppEnv } from "../context.js";
import { jobs } from "../db/schema.js";
import { notFound } from "../lib/errors.js";
import { requireAuth } from "./auth.js";

const JOB_LABELS: Record<string, string> = {
  "listing.publish": "刊登发布",
  "media.fetchMissing": "图片转存",
  "store.syncListings": "店铺状态同步",
  "listing.aiEnhance": "AI 产线",
  "listing.categorySuggest": "类目推荐",
  "listing.aiImage": "AI 图片",
  "listing.claim": "链路认领",
  "pipeline.advance": "链路推进",
  "store.syncCategories": "类目树同步",
  "listing.pushStock": "库存推送",
  "listing.pushPrice": "价格推送",
  "listing.delist": "刊登下架",
  "inventory.reconcile": "库存兜底重算",
  "order.sync": "订单同步",
  "order.map": "订单映射",
  "fulfill.push": "履约回传",
  "selection.score": "选品打分",
};

function toDto(j: typeof jobs.$inferSelect) {
  return {
    id: j.id,
    type: j.type,
    status: j.status,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    lastError: j.lastError,
    runAt: j.runAt.toISOString(),
    createdAt: j.createdAt.toISOString(),
    updatedAt: j.updatedAt.toISOString(),
    listingId: (j.payload.listingId as string | undefined) ?? null,
    storeId: (j.payload.storeId as string | undefined) ?? null,
    attemptId: (j.payload.attemptId as string | undefined) ?? null,
  };
}

export function jobRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", async (c) => {
    const q = z
      .object({
        status: z.enum(["queued", "running", "succeeded", "failed"]).optional(),
        page: z.coerce.number().min(1).default(1),
        pageSize: z.coerce.number().min(1).max(100).default(20),
      })
      .parse(c.req.query());
    const { workspaceId } = c.var.auth;
    const where = and(
      eq(jobs.workspaceId, workspaceId),
      q.status ? eq(jobs.status, q.status) : undefined,
    );
    const [items, total] = await Promise.all([
      c.var.deps.db
        .select()
        .from(jobs)
        .where(where)
        .orderBy(desc(jobs.createdAt))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize),
      c.var.deps.db.select({ n: count() }).from(jobs).where(where),
    ]);
    return c.json({ items: items.map(toDto), total: total[0].n, page: q.page, pageSize: q.pageSize });
  });

  /** 失败任务重新排队：复位 attempts/lock，立即进入下一轮。 */
  r.post("/:id/retry", async (c) => {
    const { workspaceId } = c.var.auth;
    const [row] = await c.var.deps.db
      .update(jobs)
      .set({
        status: "queued",
        attempts: 0,
        lockedAt: null,
        runAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(jobs.id, c.req.param("id")),
          eq(jobs.workspaceId, workspaceId),
          eq(jobs.status, "failed"),
        ),
      )
      .returning();
    if (!row) throw notFound("任务");
    return c.json(toDto(row));
  });

  r.get("/labels", async (c) => c.json(JOB_LABELS));
  return r;
}
