import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { ChannelCheck, ChannelIssue, PublishJobDetail } from "@studio/shared";
import type { Deps } from "../context.js";
import type { Db } from "../db/client.js";
import {
  products,
  publishAttempts,
  publishJobs,
  shops,
  type AttemptRow,
  type JobRow,
  type ShopRow,
} from "../db/schema.js";
import { badRequest, notFound } from "../lib/errors.js";
import { adapterFor } from "../platforms/index.js";
import { ensureDraft, getProduct } from "./draft.js";
import { audit } from "./audit.js";

// ============================================================
// child-server-core 拥有本文件实现。签名冻结，路由直接调这些函数。
// 语义（docs/studio-phase0.md 冻结）：
// - channelCheck：对每间店跑 adapter.validateDraft，聚合 ChannelCheck[]
//   （右栏对照预览的"所见=所判"数据源）
// - createPublishJob：冻结 fieldsSnapshot 为当前 draft.fields，
//   job=queued、每店一条 attempt=queued，然后异步跑 runQueuedAttempts
// - runQueuedAttempts：setInterval/定时器轮询 picks queued attempts →
//   running → adapter.validateDraft（失败即 failed+issues）→
//   adapter.publish（succeeded/review + externalId/remoteUrl）→
//   收尾更新 job.status = succeeded | partial_success | failed
// - retryAttempt：仅 status=failed 可重试；新建 attempt(retryOf=旧id)，
//   旧 attempt 保持 failed 记录可溯
// - getJob / listJobs：按创建时间倒序
// ============================================================

export function toJob(r: JobRow): PublishJobDetail["job"] {
  return {
    id: r.id,
    productId: r.productId,
    draftId: r.draftId,
    status: r.status,
    fieldsSnapshot: r.fieldsSnapshot,
    shopIds: r.shopIds,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

export function toAttempt(r: AttemptRow): PublishJobDetail["attempts"][number] {
  return {
    id: r.id,
    jobId: r.jobId,
    shopId: r.shopId,
    status: r.status,
    error: r.error,
    issues: r.issues,
    externalId: r.externalId,
    remoteUrl: r.remoteUrl,
    retryOf: r.retryOf,
    fieldsSnapshot: r.fieldsSnapshot,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/** 每个 db 实例挂一个 drain 触发器——createPublishJob/retryAttempt 建完队列
 *  立即唤醒 runner，不用等下一个 tick（测试里 publishDelayMs=0 也即刻跑）。 */
const drainTriggers = new WeakMap<Db, () => void>();
function triggerDrain(db: Db) {
  drainTriggers.get(db)?.();
}

/** 阻塞性问题（severity 缺省=block）；warn 只是平台建议，不挡发布。 */
const blocking = (issues: ChannelIssue[]) =>
  issues.filter((i) => (i.severity ?? "block") === "block");

export async function channelCheck(
  deps: Deps,
  input: { productId: string; shopIds?: string[] },
): Promise<ChannelCheck[]> {
  const product = await getProduct(deps.db, input.productId);
  const draft = await ensureDraft(deps.db, input.productId);

  let shopRows: ShopRow[];
  if (input.shopIds?.length) {
    const ids = [...new Set(input.shopIds)];
    const found = await deps.db.query.shops.findMany({
      where: and(inArray(shops.id, ids), isNull(shops.archivedAt)),
    });
    const byId = new Map(found.map((s) => [s.id, s]));
    // 预览宽容：不存在的 shopId 直接跳过；顺序跟随请求
    shopRows = ids.map((id) => byId.get(id)).filter((s): s is ShopRow => !!s);
  } else {
    // 缺省=全部店铺（授权+过期都列，过期店出 auth_expired）
    shopRows = await deps.db.query.shops.findMany({
      where: isNull(shops.archivedAt),
      orderBy: asc(shops.createdAt),
    });
  }

  return shopRows.map((shop) => {
    const issues = adapterFor(shop.platform).validateDraft({
      product,
      fields: draft.fields,
      shop,
    });
    return {
      shopId: shop.id,
      platform: shop.platform,
      site: shop.site,
      shopName: shop.name,
      ok: blocking(issues).length === 0,
      issues,
    };
  });
}

export async function createPublishJob(
  deps: Deps,
  input: { productId: string; shopIds: string[] },
): Promise<PublishJobDetail> {
  const ids = [...new Set(input.shopIds)];
  if (!ids.length) throw badRequest("请选择至少一间店铺");

  const product = await getProduct(deps.db, input.productId);
  const draft = await ensureDraft(deps.db, input.productId);

  const found = await deps.db.query.shops.findMany({
    where: and(inArray(shops.id, ids), isNull(shops.archivedAt)),
  });
  if (found.length !== ids.length) throw badRequest("存在无效店铺");

  // 冻结当版主稿文案进快照——之后改稿不影响本次发布（审计/回放依据）
  const [job] = await deps.db
    .insert(publishJobs)
    .values({
      productId: product.id,
      draftId: draft.id,
      status: "queued",
      fieldsSnapshot: draft.fields,
      shopIds: ids,
    })
    .returning();
  // 首跑 attempt 的快照 = job 冻结快照：排队期间改主稿不改本次发布内容
  await deps.db.insert(publishAttempts).values(
    ids.map((shopId) => ({
      jobId: job.id,
      shopId,
      status: "queued" as const,
      fieldsSnapshot: draft.fields,
    })),
  );

  triggerDrain(deps.db);
  return getJob(deps, job.id);
}

export async function getJob(deps: Deps, id: string): Promise<PublishJobDetail> {
  const job = await deps.db.query.publishJobs.findFirst({ where: eq(publishJobs.id, id) });
  if (!job) throw notFound("任务");
  const rows = await deps.db.query.publishAttempts.findMany({
    where: eq(publishAttempts.jobId, id),
    orderBy: asc(publishAttempts.createdAt),
  });
  return { job: toJob(job), attempts: rows.map(toAttempt) };
}

export async function listJobs(
  deps: Deps,
  page: number,
): Promise<{ items: PublishJobDetail[]; total: number }> {
  const [{ count }] = await deps.db
    .select({ count: sql<number>`count(*)::int` })
    .from(publishJobs);
  const rows = await deps.db.query.publishJobs.findMany({
    orderBy: desc(publishJobs.createdAt),
    limit: 20,
    offset: Math.max(0, page - 1) * 20,
  });
  const items = await Promise.all(rows.map((j) => getJob(deps, j.id)));
  return { items, total: count };
}

export async function retryAttempt(deps: Deps, attemptId: string): Promise<PublishJobDetail> {
  const old = await deps.db.query.publishAttempts.findFirst({
    where: eq(publishAttempts.id, attemptId),
  });
  if (!old) throw notFound("发布记录");
  if (old.status !== "failed") throw badRequest("仅失败的发布记录可重试");

  // 只允许重试该店最新一条：旧 failed 留档可溯，但不能把已完成的 job 拖回 running
  const latest = await deps.db.query.publishAttempts.findFirst({
    where: and(eq(publishAttempts.jobId, old.jobId), eq(publishAttempts.shopId, old.shopId)),
    orderBy: desc(publishAttempts.createdAt),
  });
  if (latest && latest.id !== old.id) {
    throw badRequest("该店铺已有更新的发布记录，请重试最新一条");
  }

  const job = await deps.db.query.publishJobs.findFirst({
    where: eq(publishJobs.id, old.jobId),
  });
  if (!job) throw notFound("任务");
  // 重试快照取当前主稿——用户在失败行上补完字段再发，本条 attempt 记它实际用的版本
  const draft = await ensureDraft(deps.db, job.productId);
  await deps.db.insert(publishAttempts).values({
    jobId: old.jobId,
    shopId: old.shopId,
    status: "queued",
    retryOf: old.id,
    fieldsSnapshot: draft.fields,
  });
  await deps.db
    .update(publishJobs)
    .set({ status: "running", updatedAt: new Date() })
    .where(eq(publishJobs.id, old.jobId));

  triggerDrain(deps.db);
  return getJob(deps, old.jobId);
}

// ---------- runner ----------

/** 每店只看最新一条 attempt（重试留档的旧记录不参与聚合）。 */
async function aggregateJob(deps: Deps, jobId: string) {
  const all = await deps.db.query.publishAttempts.findMany({
    where: eq(publishAttempts.jobId, jobId),
    orderBy: asc(publishAttempts.createdAt),
  });
  const latest = new Map<string, AttemptRow>();
  for (const a of all) latest.set(a.shopId, a);
  const cur = [...latest.values()];
  if (!cur.length) return;

  let status: JobRow["status"];
  if (cur.some((a) => a.status === "queued" || a.status === "running")) {
    status = "running";
  } else if (cur.every((a) => a.status === "failed")) {
    status = "failed";
  } else if (cur.some((a) => a.status === "failed")) {
    status = "partial_success";
  } else {
    status = "succeeded";
  }
  await deps.db
    .update(publishJobs)
    .set({ status, updatedAt: new Date() })
    .where(eq(publishJobs.id, jobId));
}

async function finishAttempt(
  deps: Deps,
  attemptId: string,
  patch: {
    status: AttemptRow["status"];
    error?: string | null;
    issues?: ChannelIssue[];
    externalId?: string | null;
    remoteUrl?: string | null;
  },
) {
  await deps.db
    .update(publishAttempts)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(publishAttempts.id, attemptId));
  await audit(deps.db, deps.actor, {
    action: "attempt.finish",
    entityType: "attempt",
    entityId: attemptId,
    payload: {
      status: patch.status,
      error: patch.error ?? null,
      externalId: patch.externalId ?? null,
    },
  });
}

async function runAttempt(deps: Deps, attempt: AttemptRow) {
  // 只翻 queued → running：重复 drain/并发触发不会重复执行
  const [claimed] = await deps.db
    .update(publishAttempts)
    .set({ status: "running", updatedAt: new Date() })
    .where(and(eq(publishAttempts.id, attempt.id), eq(publishAttempts.status, "queued")))
    .returning();
  if (!claimed) return;

  const job = await deps.db.query.publishJobs.findFirst({
    where: eq(publishJobs.id, attempt.jobId),
  });
  if (!job) {
    await finishAttempt(deps, attempt.id, {
      status: "failed",
      error: "所属任务已删除",
      issues: [{ code: "invalid_value", field: "job", message: "所属任务已删除", fixable: false }],
    });
    return;
  }
  if (job.status === "queued") {
    await deps.db
      .update(publishJobs)
      .set({ status: "running", updatedAt: new Date() })
      .where(eq(publishJobs.id, job.id));
  }

  const [product, shop] = await Promise.all([
    deps.db.query.products.findFirst({ where: eq(products.id, job.productId) }),
    deps.db.query.shops.findFirst({ where: eq(shops.id, attempt.shopId) }),
  ]);
  if (!product || !shop) {
    await finishAttempt(deps, attempt.id, {
      status: "failed",
      error: "店铺或商品已删除",
      issues: [{ code: "invalid_value", field: "shop", message: "店铺或商品已删除", fixable: false }],
    });
    return;
  }

  // 发布内容 = 本条 attempt 自己的快照：首跑是 job 冻结版，重试是补完字段的重试版。
  // 排队/运行期间改主稿不影响在跑的 attempt。
  const fields = attempt.fieldsSnapshot;
  const adapter = adapterFor(shop.platform);
  // 校验与预览共用同一套规则（所见=所判）；warn 建议项不阻塞
  const issues = adapter.validateDraft({ product, fields, shop });
  const blockingIssues = blocking(issues);
  if (blockingIssues.length) {
    await finishAttempt(deps, attempt.id, {
      status: "failed",
      error: blockingIssues[0]!.message,
      issues,
    });
    return;
  }

  try {
    const res = await adapter.publish(deps, { product, fields, shop });
    await finishAttempt(deps, attempt.id, {
      status: res.status,
      externalId: res.externalId,
      remoteUrl: res.remoteUrl,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "平台异常";
    // HttpError(422) 是"平台拒绝"的演示语义；其他异常也按平台侧失败落库
    await finishAttempt(deps, attempt.id, {
      status: "failed",
      error: message,
      issues: [{ code: "platform_rejected", field: "platform", message, fixable: false }],
    });
  }
}

/** 崩溃恢复：进程重启时残留的 running attempt 一律退回 queued 重跑；
 *  顺带聚合卡在非终态的 job（attempts 已全部终态但没落 status 的）。 */
async function recoverStale(deps: Deps) {
  await deps.db
    .update(publishAttempts)
    .set({ status: "queued", updatedAt: new Date() })
    .where(eq(publishAttempts.status, "running"));
  const open = await deps.db.query.publishJobs.findMany({
    where: inArray(publishJobs.status, ["queued", "running"]),
  });
  for (const j of open) await aggregateJob(deps, j.id);
}

export function startPublishRunner(deps: Deps): () => void {
  const intervalMs = Math.max(deps.config.mock.publishDelayMs / 4, 50);
  let draining = false;
  let stopped = false;

  const drain = async () => {
    if (draining || stopped) return;
    draining = true;
    try {
      const queued = await deps.db.query.publishAttempts.findMany({
        where: eq(publishAttempts.status, "queued"),
        orderBy: asc(publishAttempts.createdAt),
      });
      const touched = new Set<string>();
      for (const attempt of queued) {
        touched.add(attempt.jobId);
        try {
          await runAttempt(deps, attempt);
        } catch (e) {
          // runner 内部异常只记 attempt 失败，绝不上抛弄垮定时器/进程
          console.error("[studio] publish attempt runner error", e);
          await finishAttempt(deps, attempt.id, {
            status: "failed",
            error: e instanceof Error ? e.message : "执行异常",
            issues: [
              {
                code: "platform_rejected",
                field: "platform",
                message: e instanceof Error ? e.message : "执行异常",
                fixable: false,
              },
            ],
          });
        }
      }
      for (const jobId of touched) await aggregateJob(deps, jobId);
    } catch (e) {
      console.error("[studio] publish drain error", e);
    } finally {
      draining = false;
    }
  };

  // 首次 drain 前做一次崩溃恢复
  void (async () => {
    try {
      await recoverStale(deps);
    } catch (e) {
      console.error("[studio] publish recovery error", e);
    }
    await drain();
  })();

  drainTriggers.set(deps.db, () => {
    void drain();
  });
  const timer = setInterval(() => {
    void drain();
  }, intervalMs);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
    if (drainTriggers.get(deps.db)) drainTriggers.delete(deps.db);
  };
}
