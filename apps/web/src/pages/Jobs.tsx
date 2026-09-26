import type { Job, JobStatus } from "@caiji/shared";
import { RedoOutlined } from "@ant-design/icons";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import dayjs from "dayjs";
import { useState } from "react";
import { Link } from "react-router";
import { api, ApiError } from "../api";
import { useStoreScope } from "../shell/storeScope";
import { EmptyState, Err, Loading, St } from "../ui";

export const JOB_LABELS: Record<string, string> = {
  "listing.publish": "刊登发布",
  "listing.delist": "刊登下架",
  "media.fetchMissing": "图片转存",
  "store.syncListings": "店铺状态同步",
  "listing.aiEnhance": "AI 产线",
  "listing.categorySuggest": "类目推荐",
  "store.syncCategories": "类目树同步",
};

const JSTATUS: Record<JobStatus, { st: string; label: string }> = {
  queued: { st: "queued", label: "排队中" },
  running: { st: "running", label: "运行中" },
  succeeded: { st: "success", label: "成功" },
  failed: { st: "failed", label: "失败" },
};

/** 预留：若服务端上线 publishRuns（一次铺店 = 一次 run，逐店 attempt），
 *  此区块自动出现；接口 404 时静默不渲染，不伪造数据。 */
interface PublishRunAttempt {
  id: string;
  storeId: string;
  status: string;
  error?: string | null;
  remoteUrl?: string | null;
}
interface PublishRun {
  id: string;
  status: string;
  createdAt: string;
  attempts?: PublishRunAttempt[];
}

function PublishRunsSection() {
  const scope = useStoreScope();
  const runs = useQuery({
    queryKey: ["publish-runs"],
    queryFn: async () => {
      try {
        return await api.raw<unknown>("/publish-runs");
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return null;
        throw e;
      }
    },
    staleTime: 15_000,
    retry: 0,
  });
  if (!runs.data) return null;
  const items = (runs.data as { items?: PublishRun[] }).items ?? (runs.data as PublishRun[]);
  if (!Array.isArray(items) || items.length === 0) return null;
  const storeName = (id: string) => scope.stores.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  return (
    <div className="fld">
      <div className="fld-label">铺货批次</div>
      {items.map((r) => (
        <div key={r.id} className="job-card" style={{ flexDirection: "column", alignItems: "stretch" }}>
          <div className="rowline">
            <St st={r.status}>{r.status}</St>
            <span className="job-sub">{dayjs(r.createdAt).format("MM-DD HH:mm:ss")}</span>
          </div>
          {(r.attempts ?? []).map((a) => (
            <div key={a.id} className="rowline" style={{ paddingLeft: 12 }}>
              <span className="att-shop">{storeName(a.storeId)}</span>
              <St st={a.status}>{a.status}</St>
              {a.error && <span className="job-err">{a.error}</span>}
              {a.remoteUrl && (
                <a href={a.remoteUrl} target="_blank" rel="noreferrer">
                  店铺 ↗
                </a>
              )}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

export function JobsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const scope = useStoreScope();
  const [status, setStatus] = useState<JobStatus | "all">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [retrying, setRetrying] = useState<string | null>(null);

  const list = useQuery({
    queryKey: ["jobs", status, scope.storeId, page, pageSize],
    queryFn: () => api.jobs({ status: status === "all" ? undefined : status, page, pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) =>
      q.state.data?.items.some((j) => j.status === "queued" || j.status === "running") ? 2000 : false,
  });
  const items = (list.data?.items ?? []).filter((j) => !scope.storeId || j.storeId === scope.storeId || !j.storeId);

  const retry = async (id: string) => {
    setRetrying(id);
    try {
      await api.retryJob(id);
      message.success("已重新排队");
      qc.invalidateQueries({ queryKey: ["jobs"] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRetrying(null);
    }
  };

  const storeName = (id: string | null) =>
    id ? (scope.stores.find((s) => s.id === id)?.name ?? "店铺") : null;

  return (
    <div className="pg">
      <div className="pg-head">
        <h2>任务</h2>
        <span className="pg-sub">发布、同步、AI 等后台任务的执行记录{scope.store ? ` · 仅 ${scope.store.name}` : ""}</span>
        <div className="pg-spacer" />
        <div className="seg" style={{ flex: "none" }}>
          {(["all", "failed", "running", "queued", "succeeded"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={status === s ? "active" : ""}
              onClick={() => {
                setStatus(s);
                setPage(1);
              }}
            >
              {s === "all" ? "全部" : JSTATUS[s].label}
            </button>
          ))}
        </div>
      </div>

      <PublishRunsSection />

      {list.isLoading ? (
        <Loading />
      ) : list.isError ? (
        <Err error={list.error} onRetry={() => list.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState>{status === "failed" ? "没有失败的任务" : "还没有任务记录"}</EmptyState>
      ) : (
        items.map((j) => (
          <div className="job-card" key={j.id}>
            <St st={JSTATUS[j.status].st}>{JSTATUS[j.status].label}</St>
            <span style={{ minWidth: 0 }}>
              <div className="job-title">{JOB_LABELS[j.type] ?? j.type}</div>
              <div className="job-sub">
                {storeName(j.storeId) && <span>{storeName(j.storeId)} · </span>}
                {j.listingId && <Link to={`/listings/${j.listingId}`}>刊登 ↗</Link>}{" "}
                尝试 {j.attempts}/{j.maxAttempts} · {dayjs(j.createdAt).format("MM-DD HH:mm:ss")}
              </div>
              {j.status === "failed" && j.lastError && <div className="job-err">{j.lastError}</div>}
            </span>
            <span className="job-right">
              {j.status === "failed" && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={retrying === j.id}
                  onClick={() => retry(j.id)}
                >
                  <RedoOutlined /> {retrying === j.id ? "排队中…" : "重试"}
                </button>
              )}
              <span className="job-sub">{dayjs(j.updatedAt).format("MM-DD HH:mm")}</span>
            </span>
          </div>
        ))
      )}

      {(list.data?.total ?? 0) > pageSize && (
        <div className="rowline" style={{ justifyContent: "center" }}>
          <button type="button" className="btn sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>
            上一页
          </button>
          <span className="job-sub">
            {page} / {Math.ceil((list.data?.total ?? 0) / pageSize)} 页 · 共 {list.data?.total} 条
          </span>
          <button
            type="button"
            className="btn sm"
            disabled={page * pageSize >= (list.data?.total ?? 0)}
            onClick={() => setPage(page + 1)}
          >
            下一页
          </button>
          <select
            className="inp sm"
            style={{ width: 90 }}
            value={pageSize}
            onChange={(e) => {
              setPageSize(Number(e.target.value));
              setPage(1);
            }}
          >
            {[20, 50, 100].map((n) => (
              <option key={n} value={n}>
                {n}/页
              </option>
            ))}
          </select>
        </div>
      )}
    </div>
  );
}
