import { and, count, eq, gte, inArray, isNotNull, max, sql } from "drizzle-orm";
import type { PipelinePolicy } from "@caiji/shared";
import type { StoreRow } from "../channels/types.js";
import type { Db } from "../db/client.js";
import { auditLogs, jobs, listings, publishAttempts } from "../db/schema.js";
import { audit } from "./audit.js";

/** "listing.publish" — job 类型常量在 jobs/handlers.ts，这里只用字面量避免模块环。 */
const PUBLISH_JOB = "listing.publish";

/** 认领并发布 / advance=true 的快捷策略：holdPoint/autoPublish 强制全开，其余沿用店铺配置。 */
export function advancePolicy(p?: PipelinePolicy | null): PipelinePolicy {
  return { ...p, holdPoint: "auto", autoPublish: true };
}

function dayStart(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** 当日终态发布 attempt 数（succeeded/failed 才算样本）。 */
async function circuitStats(db: Db, workspaceId: string) {
  const [row] = await db
    .select({
      total: count(),
      failed: sql<number>`count(*) filter (where ${publishAttempts.status} = 'failed')`,
    })
    .from(publishAttempts)
    .where(
      and(
        eq(publishAttempts.workspaceId, workspaceId),
        gte(publishAttempts.createdAt, dayStart()),
        inArray(publishAttempts.status, ["succeeded", "failed"]),
      ),
    );
  return { total: row?.total ?? 0, failed: Number(row?.failed ?? 0) };
}

/**
 * 熔断：当日发布失败率 >50% 且样本 >5 → 自动发布停排（advance 判定点调用）。
 * 触发当天落一条 audit（同 workspace 不重复）；返回是否处于熔断态。
 */
export async function circuitOpen(
  db: Db,
  workspaceId: string,
  listingId: string,
): Promise<boolean> {
  const s = await circuitStats(db, workspaceId);
  if (!(s.total > 5 && s.failed / s.total > 0.5)) return false;
  const [seen] = await db
    .select({ id: auditLogs.id })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.workspaceId, workspaceId),
        eq(auditLogs.action, "pipeline.circuit_open"),
        gte(auditLogs.createdAt, dayStart()),
      ),
    )
    .limit(1);
  if (!seen) {
    await audit(db, workspaceId, {
      actor: "system",
      action: "pipeline.circuit_open",
      entityType: "listing",
      entityId: listingId,
      payload: { ...s, window: "utc-day" },
    });
  }
  return true;
}

/**
 * 本次发布的释放时刻：
 * max(now, listing.publishAt | policy.publishAt, 同店最近一次发布/已排队发布 + paceMinutes)。
 * paced 只约束「相邻两件间隔」：同店没有已发布/排队发布时不顺延。
 */
export async function nextRunAt(
  db: Db,
  store: StoreRow,
  listing: typeof listings.$inferSelect,
  policy: PipelinePolicy,
): Promise<Date> {
  const now = Date.now();
  const times: number[] = [now];
  const scheduled =
    listing.publishAt?.getTime() ??
    (policy.publishAt ? Date.parse(policy.publishAt) : Number.NaN);
  if (Number.isFinite(scheduled)) times.push(scheduled);
  if (policy.publishMode === "paced" && policy.paceMinutes) {
    const paceMs = policy.paceMinutes * 60_000;
    const [lastPub, queued] = await Promise.all([
      db
        .select({ m: max(listings.publishedAt) })
        .from(listings)
        .where(
          and(
            eq(listings.storeId, store.id),
            eq(listings.status, "published"),
            isNotNull(listings.publishedAt),
          ),
        ),
      // 排队中的发布 job → 其 attempt 的 storeId（attempt 建单时即写入，jobId 跑起来才回填）
      db
        .select({ m: max(jobs.runAt) })
        .from(jobs)
        .innerJoin(
          publishAttempts,
          sql`${publishAttempts.id}::text = ${jobs.payload}->>'attemptId'`,
        )
        .where(
          and(
            eq(jobs.type, PUBLISH_JOB),
            eq(jobs.status, "queued"),
            eq(publishAttempts.storeId, store.id),
          ),
        ),
    ]);
    const last = Math.max(
      lastPub[0]?.m?.getTime() ?? 0,
      queued[0]?.m?.getTime() ?? 0,
    );
    if (last) times.push(last + paceMs);
  }
  return new Date(Math.max(...times));
}
