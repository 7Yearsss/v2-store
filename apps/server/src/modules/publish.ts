import { zValidator } from "@hono/zod-validator";
import { and, count, desc, eq, inArray } from "drizzle-orm";
import { Hono } from "hono";
import { z } from "zod";
import type { PublishAttempt, PublishRun } from "@caiji/shared";
import type { AppEnv } from "../context.js";
import { listings, publishAttempts, publishRuns } from "../db/schema.js";
import { HttpError, notFound } from "../lib/errors.js";
import { PUBLISH_LISTING } from "../jobs/handlers.js";
import { enqueue } from "../jobs/queue.js";
import { requireAuth } from "./auth.js";

type RunRow = typeof publishRuns.$inferSelect;
type AttemptRow = typeof publishAttempts.$inferSelect;

export function toRunDto(r: RunRow, counts?: { total: number; queued: number; running: number; succeeded: number; failed: number }): PublishRun {
  return {
    id: r.id,
    status: r.status,
    listingIds: r.listingIds,
    counts: counts ?? null,
    createdBy: r.createdBy,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toAttemptDto(a: AttemptRow): PublishAttempt {
  return {
    id: a.id,
    runId: a.runId,
    listingId: a.listingId,
    storeId: a.storeId,
    status: a.status,
    fieldsSnapshot: a.fieldsSnapshot,
    error: a.error,
    errorCode: a.errorCode,
    remoteId: a.remoteId,
    remoteUrl: a.remoteUrl,
    retryOf: a.retryOf,
    jobId: a.jobId,
    createdAt: a.createdAt.toISOString(),
    updatedAt: a.updatedAt.toISOString(),
  };
}

const listQuery = z.object({
  status: z.string().max(50).optional(),
  listingId: z.string().uuid().optional(),
});

/** 发布任务管理读 API：run/attempt 列表（任务页）+ 只重试失败 attempt。全部按 workspace 隔离。 */
export function publishRoutes() {
  const r = new Hono<AppEnv>();
  r.use("*", requireAuth);

  /** 发布 run 列表：聚合每 run 的 attempt 状态计数。 */
  r.get("/runs", zValidator("query", listQuery), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const { status } = c.req.valid("query");
    const conds = [eq(publishRuns.workspaceId, workspaceId)];
    if (status) conds.push(eq(publishRuns.status, status as RunRow["status"]));
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(publishRuns)
        .where(and(...conds))
        .orderBy(desc(publishRuns.createdAt))
        .limit(100),
      db.select({ total: count() }).from(publishRuns).where(and(...conds)),
    ]);
    // 单查询聚合：每个 attempt status 计数按 runId 分组
    const runIds = rows.map((r) => r.id);
    const countsByRun = new Map<string, { total: number; queued: number; running: number; succeeded: number; failed: number }>();
    if (runIds.length) {
      const grouped = await db
        .select({
          runId: publishAttempts.runId,
          status: publishAttempts.status,
          n: count(),
        })
        .from(publishAttempts)
        .where(and(eq(publishAttempts.workspaceId, workspaceId), inArray(publishAttempts.runId, runIds)))
        .groupBy(publishAttempts.runId, publishAttempts.status);
      for (const g of grouped) {
        const c0 = countsByRun.get(g.runId) ?? { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0 };
        c0.total += g.n;
        c0[g.status as keyof Omit<typeof c0, "total">] += g.n;
        countsByRun.set(g.runId, c0);
      }
    }
    return c.json({
      items: rows.map((row) => toRunDto(row, countsByRun.get(row.id))),
      total,
    });
  });

  /** 单个 run 详情 + 其 attempts。 */
  r.get("/runs/:id", async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const [run] = await db
      .select()
      .from(publishRuns)
      .where(and(eq(publishRuns.id, c.req.param("id")), eq(publishRuns.workspaceId, workspaceId)));
    if (!run) throw notFound("发布任务");
    const attempts = await db
      .select()
      .from(publishAttempts)
      .where(and(eq(publishAttempts.runId, run.id), eq(publishAttempts.workspaceId, workspaceId)))
      .orderBy(desc(publishAttempts.createdAt));
    return c.json({ run: toRunDto(run), attempts: attempts.map(toAttemptDto) });
  });

  /** attempt 列表：按 runId / listingId / status 过滤（任务页表格）。 */
  r.get("/attempts", zValidator("query", listQuery.extend({ runId: z.string().uuid().optional() })), async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const q = c.req.valid("query");
    const conds = [eq(publishAttempts.workspaceId, workspaceId)];
    if (q.runId) conds.push(eq(publishAttempts.runId, q.runId));
    if (q.listingId) conds.push(eq(publishAttempts.listingId, q.listingId));
    if (q.status) conds.push(eq(publishAttempts.status, q.status as AttemptRow["status"]));
    const [rows, [{ total }]] = await Promise.all([
      db
        .select()
        .from(publishAttempts)
        .where(and(...conds))
        .orderBy(desc(publishAttempts.createdAt))
        .limit(100),
      db.select({ total: count() }).from(publishAttempts).where(and(...conds)),
    ]);
    return c.json({ items: rows.map(toAttemptDto), total });
  });

  /** 只重试失败的 attempt：新建 retryOf 指回原 attempt 的行，刊登回 publishing，重新排队。
   *  只处理该 run 内 status=failed 的 attempt；成功/进行中的不动（partial success 重试语义）。 */
  r.post("/runs/:id/retry", async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const runId = c.req.param("id");
    const retried = await db.transaction(async (tx) => {
      const [run] = await tx
        .select({ id: publishRuns.id, status: publishRuns.status })
        .from(publishRuns)
        .where(and(eq(publishRuns.id, runId), eq(publishRuns.workspaceId, workspaceId)));
      if (!run) throw notFound("发布任务");
      if (run.status === "queued" || run.status === "running") {
        throw new HttpError(409, "任务仍在进行中，不能重试");
      }
      const failed = await tx
        .select()
        .from(publishAttempts)
        .where(
          and(
            eq(publishAttempts.runId, runId),
            eq(publishAttempts.workspaceId, workspaceId),
            eq(publishAttempts.status, "failed"),
          ),
        );
      for (const a of failed) {
        // 已被更新的重试 attempt 取代过的失败行不再重试（取每刊登最新 attempt）
        const [newer] = await tx
          .select({ id: publishAttempts.id })
          .from(publishAttempts)
          .where(
            and(
              eq(publishAttempts.listingId, a.listingId),
              eq(publishAttempts.workspaceId, workspaceId),
            ),
          )
          .orderBy(desc(publishAttempts.createdAt))
          .limit(1);
        if (newer && newer.id !== a.id) continue;
        const [next] = await tx
          .insert(publishAttempts)
          .values({
            workspaceId,
            runId,
            listingId: a.listingId,
            storeId: a.storeId,
            status: "queued",
            fieldsSnapshot: a.fieldsSnapshot,
            retryOf: a.id,
          })
          .returning({ id: publishAttempts.id });
        await tx
          .update(listings)
          .set({ status: "publishing", lastError: null })
          .where(
            and(
              eq(listings.id, a.listingId),
              eq(listings.workspaceId, workspaceId),
            ),
          );
        await enqueue(tx, PUBLISH_LISTING, { listingId: a.listingId, attemptId: next!.id }, { workspaceId });
      }
      if (failed.length) {
        await tx
          .update(publishRuns)
          .set({ status: "running", updatedAt: new Date() })
          .where(eq(publishRuns.id, runId));
      }
      return failed.length;
    });
    return c.json({ retried });
  });

  return r;
}
