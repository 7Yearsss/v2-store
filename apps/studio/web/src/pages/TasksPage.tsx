import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, ExternalLink, ListChecks, RefreshCw } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import type {
  ChannelIssue,
  Product,
  PublishAttempt,
  PublishJobDetail,
  Shop,
} from "@studio/shared";
import { api } from "../api.js";
import {
  ATTEMPT_TEXT,
  Empty,
  Err,
  JOB_TEXT,
  Loading,
  PLATFORM_NAME,
  PlatformBadge,
  St,
  fmtTime,
} from "../components/ui.js";
import { useShopScope } from "../shell/shopScope.js";

const ACTIVE_JOB = new Set(["queued", "running"]);
const ACTIVE_ATTEMPT = new Set(["queued", "running"]);

function isTerminal(status: string) {
  return !ACTIVE_JOB.has(status);
}

function latestPerShop(attempts: PublishAttempt[]): PublishAttempt[] {
  const byShop = new Map<string, PublishAttempt>();
  for (const a of attempts) byShop.set(a.shopId, a);
  return [...byShop.values()];
}

function attemptCounts(attempts: PublishAttempt[]) {
  const latest = latestPerShop(attempts);
  const done = latest.filter((a) => !ACTIVE_ATTEMPT.has(a.status)).length;
  return { done, total: latest.length };
}

/** /tasks 列表 + /tasks/:id 详情共用本页（参数有无区分）。 */
export function TasksPage() {
  const { id } = useParams();
  return id ? <JobDetail id={id} /> : <JobList />;
}

/* ================= 列表 ================= */
function JobList() {
  const scope = useShopScope();
  const jobsQ = useQuery({
    queryKey: ["jobs", "list"],
    queryFn: () => api.jobs(1),
    refetchInterval: 2_000,
    placeholderData: (p) => p,
  });
  const productsQ = useQuery({ queryKey: ["products"], queryFn: () => api.products() });
  const productMap = useMemo(() => {
    const m = new Map<string, Product>();
    for (const p of productsQ.data?.items ?? []) m.set(p.id, p);
    return m;
  }, [productsQ.data]);

  const items = useMemo(() => {
    const all = jobsQ.data?.items ?? [];
    if (!scope.shopId) return all;
    return all.filter((d) => d.job.shopIds.includes(scope.shopId!));
  }, [jobsQ.data, scope.shopId]);

  return (
    <div className="pg">
      <div className="pg-head">
        <span className="pg-sub">
          {jobsQ.data ? `共 ${jobsQ.data.total} 个任务` : ""}
          {scope.shop ? ` · 只看「${scope.shop.name}」` : ""}
        </span>
      </div>
      {jobsQ.isPending ? (
        <Loading />
      ) : jobsQ.isError ? (
        <Err error={jobsQ.error} onRetry={() => jobsQ.refetch()} />
      ) : items.length === 0 ? (
        <Empty icon={<ListChecks size={20} />}>
          {scope.shop ? "这家店铺还没有发布任务。" : "还没有发布任务。去「铺货」页选个商品发出去。"}
        </Empty>
      ) : (
        items.map((d) => (
          <JobRow key={d.job.id} d={d} product={productMap.get(d.job.productId)} />
        ))
      )}
    </div>
  );
}

function JobRow({ d, product }: { d: PublishJobDetail; product: Product | undefined }) {
  const { done, total } = attemptCounts(d.attempts);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const tone =
    d.job.status === "succeeded"
      ? "done"
      : d.job.status === "partial_success"
        ? "partial"
        : d.job.status === "failed"
          ? "failed"
          : undefined;
  return (
    <Link to={`/tasks/${d.job.id}`} className="job-card">
      <div style={{ minWidth: 0 }}>
        <div className="job-title">{product?.title ?? "（商品已删除）"}</div>
        <div className="job-sub">
          {total} 家店 · {fmtTime(d.job.createdAt)}
        </div>
      </div>
      <div className="job-right">
        <span className="prog" data-tone={tone}>
          <i style={{ width: `${pct}%` }} />
        </span>
        <span className="job-sub" style={{ width: 48, textAlign: "right" }}>
          {done}/{total}
        </span>
        <St st={d.job.status}>{JOB_TEXT[d.job.status]}</St>
      </div>
    </Link>
  );
}

/* ================= 详情 ================= */
function JobDetail({ id }: { id: string }) {
  const scope = useShopScope();
  const queryClient = useQueryClient();

  const jobQ = useQuery({
    queryKey: ["job", id],
    queryFn: () => api.job(id),
    refetchInterval: (q) =>
      q.state.data && isTerminal(q.state.data.job.status) ? false : 1_500,
  });
  const productsQ = useQuery({ queryKey: ["products"], queryFn: () => api.products() });
  const product = productsQ.data?.items.find((p) => p.id === jobQ.data?.job.productId);

  const shopMap = useMemo(() => {
    const m = new Map<string, Shop>();
    for (const s of scope.shops) m.set(s.id, s);
    return m;
  }, [scope.shops]);

  const retry = useMutation({
    mutationFn: (attemptId: string) => api.retryAttempt(attemptId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["job", id] });
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
    },
  });

  if (jobQ.isPending) return <Loading />;
  if (jobQ.isError || !jobQ.data)
    return <Err error={jobQ.error} onRetry={() => jobQ.refetch()} />;

  const { job, attempts } = jobQ.data;
  const latest = latestPerShop(attempts);
  const latestIds = new Set(latest.map((a) => a.id));
  const snap = job.fieldsSnapshot;
  const { done, total } = attemptCounts(attempts);

  return (
    <div className="pg">
      <div className="pg-head">
        <St st={job.status}>{JOB_TEXT[job.status]}</St>
        <span className="pg-sub">
          {done}/{total} 家完成 · 创建于 {fmtTime(job.createdAt)}
        </span>
        <span className="pg-spacer" />
        <Link className="t-link" to="/tasks">
          ← 返回任务列表
        </Link>
      </div>

      {/* 发布时冻结的主稿快照（只读） */}
      <div className="snap">
        <div className="snap-kv">
          <span className="snap-k">商品</span>
          <span style={{ color: "var(--text)" }}>{product?.title ?? job.productId}</span>
        </div>
        <div className="snap-kv">
          <span className="snap-k">快照标题</span>
          <span>{snap.title || "—"}</span>
        </div>
        <div className="snap-kv">
          <span className="snap-k">快照价格</span>
          <span>
            {snap.price}
            {snap.compareAtPrice != null ? `（划线 ${snap.compareAtPrice}）` : ""}
            {snap.category ? ` · ${snap.category}` : ""}
          </span>
        </div>
      </div>

      <div className="tbl-wrap">
        {attempts.map((a) => (
          <AttemptRow
            key={a.id}
            a={a}
            shop={shopMap.get(a.shopId)}
            isLatest={latestIds.has(a.id)}
            onRetry={() => retry.mutate(a.id)}
            retryBusy={retry.isPending}
          />
        ))}
      </div>
    </div>
  );
}

function AttemptRow({
  a,
  shop,
  isLatest,
  onRetry,
  retryBusy,
}: {
  a: PublishAttempt;
  shop: Shop | undefined;
  isLatest: boolean;
  onRetry: () => void;
  retryBusy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const name = shop?.name ?? "（店铺已删除）";
  return (
    <div className="att">
      <div className="att-row">
        {shop && <PlatformBadge id={shop.platform} />}
        <span className="att-shop">{name}</span>
        {shop && (
          <span className="att-meta">
            {PLATFORM_NAME[shop.platform]} · {shop.site}
          </span>
        )}
        {!isLatest && <span className="att-old">旧记录</span>}
        <span className="pg-spacer" />
        {a.remoteUrl && (
          <a
            className="t-link"
            href={a.remoteUrl}
            target="_blank"
            rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: "var(--fs-dense)" }}
          >
            {a.externalId ?? "店铺链接"} <ExternalLink size={11} />
          </a>
        )}
        {a.status === "failed" && isLatest && (
          <button
            type="button"
            className="btn sm"
            disabled={retryBusy}
            onClick={onRetry}
          >
            <RefreshCw size={12} /> 重试
          </button>
        )}
        <St st={a.status}>{ATTEMPT_TEXT[a.status]}</St>
      </div>
      {a.status === "failed" && (
        <div className="att-err">
          {a.error ?? "发布失败"}
          {a.issues.length > 0 && (
            <button type="button" className="chk-toggle" style={{ marginLeft: 8 }} onClick={() => setOpen((o) => !o)}>
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
              {a.issues.length} 个问题
            </button>
          )}
        </div>
      )}
      {open && a.issues.length > 0 && (
        <div className="chk-issues">
          {a.issues.map((i: ChannelIssue, idx) => (
            <div key={idx} className="chk-issue">
              <span className="chk-issue-f">{i.field}</span>
              <span>{i.message}</span>
            </div>
          ))}
        </div>
      )}
      <div className="att-meta">
        {fmtTime(a.createdAt)}
        {a.retryOf ? " · 重试" : ""}
        {a.externalId && !a.remoteUrl ? ` · ${a.externalId}` : ""}
      </div>
    </div>
  );
}
