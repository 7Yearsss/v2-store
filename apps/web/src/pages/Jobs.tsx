import type { Job, JobStatus, PublishRun } from "@caiji/shared";
import { RedoOutlined } from "@ant-design/icons";
import { keepPreviousData, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import dayjs from "dayjs";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
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

const RUN_STATUS: Record<PublishRun["status"], string> = {
  queued: "排队中",
  running: "进行中",
  partial_success: "部分成功",
  succeeded: "成功",
  failed: "失败",
};

const ATTEMPT_STATUS: Record<string, { st: string; label: string }> = {
  queued: { st: "queued", label: "排队中" },
  running: { st: "running", label: "发布中" },
  succeeded: { st: "success", label: "成功" },
  failed: { st: "failed", label: "失败" },
};

/** 单个 run 展开：每店一条 attempt（失败原因 + 店铺链接 + 刊登跳转）。 */
function RunAttempts({ runId }: { runId: string }) {
  const scope = useStoreScope();
  const detail = useQuery({
    queryKey: ["publish-run", runId],
    queryFn: () => api.publishRun(runId),
    refetchInterval: (q) =>
      q.state.data?.attempts.some((a) => a.status === "queued" || a.status === "running") ? 2000 : false,
  });
  const storeName = (id: string) => scope.stores.find((s) => s.id === id)?.name ?? id.slice(0, 8);
  if (detail.isLoading) return <Loading />;
  if (detail.isError) return <Err error={detail.error} onRetry={() => detail.refetch()} />;
  return (
    <>
      {(detail.data?.attempts ?? []).map((a) => (
        <div key={a.id} className="rowline" style={{ paddingLeft: 12 }}>
          <span className="att-shop">{storeName(a.storeId)}</span>
          <St st={ATTEMPT_STATUS[a.status]?.st ?? a.status}>
            {ATTEMPT_STATUS[a.status]?.label ?? a.status}
          </St>
          <Link to={`/listings/${a.listingId}`} className="t-link">
            刊登 ↗
          </Link>
          {a.retryOf && <span className="job-sub">重试</span>}
          {a.error && <span className="job-err">{a.error}</span>}
          {a.remoteUrl && (
            <a href={a.remoteUrl} target="_blank" rel="noreferrer">
              店铺 ↗
            </a>
          )}
        </div>
      ))}
    </>
  );
}

/** 铺货批次：一次「铺到 N 家店」= 一个 run，逐店 attempt。失败可整批只重试失败店。 */
function PublishRunsSection() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const [open, setOpen] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const runs = useQuery({
    queryKey: ["publish-runs"],
    queryFn: () => api.publishRuns(),
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => r.status === "queued" || r.status === "running") ? 2000 : false,
  });
  const items = runs.data?.items ?? [];
  if (!runs.isLoading && items.length === 0) return null;

  const retry = async (id: string) => {
    setRetrying(id);
    try {
      const r = await api.retryPublishRun(id);
      message.success(r.retried ? `已重试 ${r.retried} 个失败店铺` : "没有失败的店铺需要重试");
      qc.invalidateQueries({ queryKey: ["publish-runs"] });
      qc.invalidateQueries({ queryKey: ["publish-run", id] });
      qc.invalidateQueries({ queryKey: ["listings"] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setRetrying(null);
    }
  };

  return (
    <div className="fld">
      <div className="fld-label">铺货批次</div>
      {runs.isLoading ? (
        <Loading />
      ) : (
        items.map((r) => {
          const c = r.counts;
          return (
            <div key={r.id} className="job-card" style={{ flexDirection: "column", alignItems: "stretch" }}>
              <div className="rowline">
                <St st={r.status}>{RUN_STATUS[r.status] ?? r.status}</St>
                <span className="job-sub">
                  {c ? `${c.succeeded}/${c.total} 店成功${c.failed ? ` · ${c.failed} 失败` : ""}${c.queued + c.running ? ` · ${c.queued + c.running} 进行中` : ""}` : ""}
                  {dayjs(r.createdAt).format(" MM-DD HH:mm")}
                </span>
                <span style={{ marginLeft: "auto" }} className="rowline">
                  {c && c.failed > 0 && r.status !== "running" && r.status !== "queued" && (
                    <button
                      type="button"
                      className="btn sm"
                      disabled={retrying === r.id}
                      onClick={() => retry(r.id)}
                    >
                      <RedoOutlined /> {retrying === r.id ? "排队中…" : "重试失败店"}
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn sm ghost"
                    onClick={() => setOpen(open === r.id ? null : r.id)}
                  >
                    {open === r.id ? "收起" : "逐店明细"}
                  </button>
                </span>
              </div>
              {open === r.id && <RunAttempts runId={r.id} />}
            </div>
          );
        })
      )}
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
