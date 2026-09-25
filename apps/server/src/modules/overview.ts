import { and, count, desc, eq, gte, inArray, isNull, ne } from "drizzle-orm";
import { Hono } from "hono";
import type { AppEnv } from "../context.js";
import { jobs, listings, sourceItems } from "../db/schema.js";
import { requireAuth } from "./auth.js";

/** 工作台首页一张图：采集箱/刊登/任务概览 + 最近发布结果。
 *  全部 workspace 隔离；查询量小、直接同步出。 */
export function overviewRoutes() {
  const r = new Hono<AppEnv>();
  r.use(requireAuth);

  r.get("/", async (c) => {
    const { db } = c.var.deps;
    const { workspaceId } = c.var.auth;
    const dayAgo = new Date(Date.now() - 24 * 3600 * 1000);

    const [boxTotal, boxUnclaimed, listingRows, jobRows, recent] = await Promise.all([
      db
        .select({ n: count() })
        .from(sourceItems)
        .where(eq(sourceItems.workspaceId, workspaceId)),
      db
        .select({ n: count() })
        .from(sourceItems)
        .leftJoin(listings, eq(listings.sourceItemId, sourceItems.id))
        .where(and(eq(sourceItems.workspaceId, workspaceId), isNull(listings.id))),
      db
        .select({ status: listings.status, n: count() })
        .from(listings)
        .where(eq(listings.workspaceId, workspaceId))
        .groupBy(listings.status),
      db
        .select({ status: jobs.status, n: count() })
        .from(jobs)
        .where(
          and(
            eq(jobs.workspaceId, workspaceId),
            inArray(jobs.status, ["queued", "running"]),
          ),
        )
        .groupBy(jobs.status),
      db
        .select({
          id: listings.id,
          title: listings.title,
          status: listings.status,
          remoteStatus: listings.remoteStatus,
          lastError: listings.lastError,
          updatedAt: listings.updatedAt,
        })
        .from(listings)
        .where(
          and(
            eq(listings.workspaceId, workspaceId),
            inArray(listings.status, ["published", "failed"]),
          ),
        )
        .orderBy(desc(listings.updatedAt))
        .limit(6),
    ]);

    const failed24h = await db
      .select({ n: count() })
      .from(jobs)
      .where(
        and(
          eq(jobs.workspaceId, workspaceId),
          eq(jobs.status, "failed"),
          gte(jobs.updatedAt, dayAgo),
          ne(jobs.type, "listing.publish"), // 发布失败在刊登状态里体现
        ),
      );

    const byStatus = Object.fromEntries(listingRows.map((r) => [r.status, r.n]));
    const jobByStatus = Object.fromEntries(jobRows.map((r) => [r.status, r.n]));
    return c.json({
      collectBox: { total: boxTotal[0]?.n ?? 0, unclaimed: boxUnclaimed[0]?.n ?? 0 },
      listings: {
        draft: byStatus.draft ?? 0,
        publishing: byStatus.publishing ?? 0,
        published: byStatus.published ?? 0,
        failed: byStatus.failed ?? 0,
      },
      jobs: {
        pending: jobByStatus.queued ?? 0,
        running: jobByStatus.running ?? 0,
        failed24h: failed24h[0]?.n ?? 0,
      },
      recentResults: recent.map((r) => ({
        ...r,
        updatedAt: r.updatedAt.toISOString(),
      })),
    });
  });

  return r;
}
