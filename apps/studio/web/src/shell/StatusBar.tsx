import { ChevronDown } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useLocation } from "react-router";
import type { Shop } from "@studio/shared";
import type { JobsStatus } from "./jobsStatus.js";
import type { ShopScopeValue } from "./shopScope.js";

const PAGE_META: { match: RegExp; title: string; context: string }[] = [
  { match: /^\/publish/, title: "铺货", context: "选品 → 主稿 → 一键铺店" },
  { match: /^\/products/, title: "商品", context: "货源主数据" },
  { match: /^\/shops/, title: "店铺", context: "授权与站点" },
  { match: /^\/tasks\/[^/]+/, title: "任务详情", context: "逐店发布结果" },
  { match: /^\/tasks/, title: "任务", context: "发布队列" },
  { match: /^\/settings/, title: "设置", context: "工作台设置" },
  { match: /^\/__demo/, title: "壳演示", context: "方案 B · 状态优先向" },
];

function pageMeta(pathname: string) {
  return PAGE_META.find((m) => m.match.test(pathname)) ?? PAGE_META[0];
}

function shopSt(shop: Shop | null): string | undefined {
  if (!shop) return undefined;
  return shop.authStatus === "expired" ? "failed" : "success";
}

function ScopeSelect({ scope }: { scope: ShopScopeValue }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const current = scope.shop;
  return (
    <div className="sh-scope" ref={ref}>
      <button
        type="button"
        className="sh-scope-btn"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="listbox"
      >
        <span
          className="st-dot"
          data-st={current ? shopSt(current) : scope.expiredCount > 0 ? "failed" : "success"}
        />
        <span className="sh-scope-name">
          {current ? current.name : "全部店铺"}
        </span>
        <span className="sh-scope-meta">
          {current
            ? `${current.platform} · ${current.site}`
            : `${scope.shops.length} 店`}
        </span>
        <ChevronDown size={14} className="sh-scope-caret" data-open={open} />
      </button>
      {open && (
        <div className="sh-scope-menu" role="listbox" aria-label="店铺范围">
          <button
            type="button"
            role="option"
            aria-selected={scope.shopId === null}
            className={`sh-scope-item${scope.shopId === null ? " active" : ""}`}
            onClick={() => {
              scope.setShopId(null);
              setOpen(false);
            }}
          >
            <span
              className="st-dot"
              data-st={scope.expiredCount > 0 ? "failed" : "success"}
            />
            <span>全部店铺</span>
            <span className="sh-scope-meta">{scope.shops.length} 店</span>
          </button>
          {scope.shops.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={scope.shopId === s.id}
              className={`sh-scope-item${scope.shopId === s.id ? " active" : ""}`}
              onClick={() => {
                scope.setShopId(s.id);
                setOpen(false);
              }}
            >
              <span className="st-dot" data-st={shopSt(s)} />
              <span>{s.name}</span>
              <span className="sh-scope-meta">
                {s.platform} · {s.site}
                {s.authStatus === "expired" ? " · 授权过期" : ""}
              </span>
            </button>
          ))}
          {scope.expiredCount > 0 && (
            <div className="sh-scope-foot">
              {scope.expiredCount} 家店授权过期
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function JobsPill({ jobs }: { jobs: JobsStatus }) {
  const seg: ReactNode[] = [];
  if (jobs.busy) {
    seg.push(
      <span key="busy" className="sh-jobs-seg">
        <span className="st-dot" data-st="running" />
        <b>{jobs.running + jobs.queued}</b> 在跑
        {jobs.queued > 0 ? ` · ${jobs.queued} 排队` : ""}
      </span>,
    );
  }
  if (jobs.failed > 0) {
    seg.push(
      <span key="fail" className="sh-jobs-seg sh-jobs-fail">
        <span className="st-dot" data-st="failed" />
        <b>{jobs.failed}</b> 失败
      </span>,
    );
  }
  if (seg.length === 0) {
    seg.push(
      <span key="idle" className="sh-jobs-seg sh-jobs-idle">
        <span className="st-dot" />
        无在跑任务
      </span>,
    );
  }
  return (
    <Link to="/tasks" className="sh-jobs" data-busy={jobs.busy} title="查看任务队列">
      {seg.reduce<ReactNode[]>(
        (acc, node, i) => (i === 0 ? [node] : [...acc, <span key={`sep${i}`} className="sh-jobs-sep" />, node]),
        [],
      )}
    </Link>
  );
}

/** 方案 B 顶栏 = 一条状态栏：页上下文 | 店铺范围 | 全局任务状态。 */
export function StatusBar({
  jobs,
  scope,
}: {
  jobs: JobsStatus;
  scope: ShopScopeValue;
}) {
  const { pathname } = useLocation();
  const meta = pageMeta(pathname);
  return (
    <header className="sh-topbar">
      <h1 className="sh-title">{meta.title}</h1>
      <span className="sh-context">{meta.context}</span>
      <span className="sh-divider" />
      <ScopeSelect scope={scope} />
      <span className="sh-spacer" />
      <JobsPill jobs={jobs} />
    </header>
  );
}
