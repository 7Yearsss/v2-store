import { useQuery } from "@tanstack/react-query";
import type { PublishJobDetail } from "@studio/shared";
import { api } from "../api.js";

export interface JobsStatus {
  running: number;
  queued: number;
  /** 近一页任务里失败 attempt 总数（含 partial_success 里的失败店） */
  failed: number;
  /** 有进行中/排队任务 */
  busy: boolean;
  items: PublishJobDetail[];
}

export function summarizeJobs(items: PublishJobDetail[]): JobsStatus {
  let running = 0;
  let queued = 0;
  let failed = 0;
  for (const d of items) {
    if (d.job.status === "running") running++;
    else if (d.job.status === "queued") queued++;
    failed += d.attempts.filter((a) => a.status === "failed").length;
  }
  return { running, queued, failed, busy: running + queued > 0, items };
}

const EMPTY: JobsStatus = { running: 0, queued: 0, failed: 0, busy: false, items: [] };

/** 全局任务状态轮询：导航徽标与顶栏 pill 共用一份数据。 */
export function useJobsStatus(): JobsStatus {
  const { data } = useQuery({
    queryKey: ["jobs", "status"],
    queryFn: () => api.jobs(1),
    refetchInterval: 2_000,
    placeholderData: (prev) => prev,
  });
  return data ? summarizeJobs(data.items) : EMPTY;
}
