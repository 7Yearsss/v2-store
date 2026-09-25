import type { Deps } from "../context.js";
import type { ChannelCheck, PublishJobDetail } from "@studio/shared";
import type { AttemptRow, JobRow } from "../db/schema.js";

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

export declare function toJob(r: JobRow): PublishJobDetail["job"];
export declare function toAttempt(r: AttemptRow): PublishJobDetail["attempts"][number];

export declare function channelCheck(
  deps: Deps,
  input: { productId: string; shopIds?: string[] },
): Promise<ChannelCheck[]>;

export declare function createPublishJob(
  deps: Deps,
  input: { productId: string; shopIds: string[] },
): Promise<PublishJobDetail>;

export declare function getJob(deps: Deps, id: string): Promise<PublishJobDetail>;
export declare function listJobs(
  deps: Deps,
  page: number,
): Promise<{ items: PublishJobDetail[]; total: number }>;

export declare function retryAttempt(deps: Deps, attemptId: string): Promise<PublishJobDetail>;

export declare function startPublishRunner(deps: Deps): () => void;
