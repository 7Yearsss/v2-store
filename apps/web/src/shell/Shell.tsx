import {
  AppstoreOutlined,
  DownOutlined,
  LogoutOutlined,
  RocketOutlined,
  SettingOutlined,
  ShopOutlined,
  UnorderedListOutlined,
} from "@ant-design/icons";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from "react-router";
import { api } from "../api";
import { ExtensionBadge } from "../components/ExtensionBadge";
import { St } from "../ui";
import { StoreScopeProvider, useStoreScope, type StoreScopeValue } from "./storeScope";

const NAV = [
  { to: "/", label: "铺货", icon: RocketOutlined, end: true },
  { to: "/products", label: "商品", icon: AppstoreOutlined, end: false },
  { to: "/stores", label: "店铺", icon: ShopOutlined, end: false },
  { to: "/jobs", label: "任务", icon: UnorderedListOutlined, end: false },
  { to: "/settings", label: "设置", icon: SettingOutlined, end: false },
] as const;

const PAGE_META: { match: RegExp; title: string; context: string }[] = [
  { match: /^\/listings\/[^/]+/, title: "刊登编辑", context: "店稿完整字段" },
  { match: /^\/products/, title: "商品", context: "按货源聚合的各店刊登" },
  { match: /^\/stores/, title: "店铺", context: "授权与刊登设置" },
  { match: /^\/jobs/, title: "任务", context: "后台任务与失败重试" },
  { match: /^\/settings/, title: "设置", context: "映射、插件与账号" },
  { match: /^\//, title: "铺货", context: "选货源 → 店稿 → 一键铺店" },
];

function pageMeta(pathname: string) {
  return PAGE_META.find((m) => m.match.test(pathname)) ?? PAGE_META[0];
}

/** 顶栏聚合状态：在跑 = 排队+运行中任务+发布中刊登；失败 = 24h 失败任务 + 失败刊登。 */
function useShellStatus() {
  const q = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
    refetchInterval: (query) => {
      const d = query.state.data;
      return d && (d.jobs.pending + d.jobs.running + d.listings.publishing > 0) ? 3000 : false;
    },
  });
  const d = q.data;
  return {
    busy: (d?.jobs.pending ?? 0) + (d?.jobs.running ?? 0) + (d?.listings.publishing ?? 0),
    failed: (d?.jobs.failed24h ?? 0) + (d?.listings.failed ?? 0),
    attention: d?.collectBox.unclaimed ?? 0,
    raw: d,
  };
}

type ShellStatus = ReturnType<typeof useShellStatus>;

function NavRail({ status, scope }: { status: ShellStatus; scope: StoreScopeValue }) {
  const badgesFor = (to: string): { count: number; kind: "accent" | "alert" }[] => {
    if (to === "/jobs") {
      const b: { count: number; kind: "accent" | "alert" }[] = [];
      if (status.failed > 0) b.push({ count: status.failed, kind: "alert" });
      if (status.busy > 0) b.push({ count: status.busy, kind: "accent" });
      return b;
    }
    if (to === "/stores" && scope.errorCount > 0)
      return [{ count: scope.errorCount, kind: "alert" }];
    if (to === "/" && status.attention > 0)
      return [{ count: status.attention, kind: "accent" }];
    return [];
  };
  return (
    <nav className="sh-rail" aria-label="主导航">
      <div className="sh-logo" aria-hidden>
        <span className="sh-logo-mark" />
      </div>
      {NAV.map(({ to, label, icon: Icon, end }) => {
        const badges = badgesFor(to);
        return (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => `sh-navitem${isActive ? " active" : ""}`}>
            <span className="sh-navitem-icon">
              <Icon style={{ fontSize: 18 }} />
              {badges.length > 0 && (
                <span className="sh-badges">
                  {badges.map((b) => (
                    <span key={b.kind} className="sh-badge" data-kind={b.kind}>
                      {b.count > 9 ? "9+" : b.count}
                    </span>
                  ))}
                </span>
              )}
            </span>
            <span className="sh-navlabel">{label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}

function storeDot(s: { status: string } | null): string | undefined {
  if (!s) return undefined;
  return s.status === "active" ? "success" : "failed";
}

function ScopeSelect({ scope }: { scope: StoreScopeValue }) {
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

  const current = scope.store;
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
          data-st={current ? storeDot(current) : scope.errorCount > 0 ? "failed" : "success"}
        />
        <span className="sh-scope-name">{current ? current.name : "全部店铺"}</span>
        <span className="sh-scope-meta">
          {current ? current.shopDomain : `${scope.stores.length} 店`}
        </span>
        <DownOutlined className="sh-scope-caret" data-open={open} style={{ fontSize: 10 }} />
      </button>
      {open && (
        <div className="sh-scope-menu" role="listbox" aria-label="店铺范围">
          <button
            type="button"
            role="option"
            aria-selected={scope.storeId === null}
            className={`sh-scope-item${scope.storeId === null ? " active" : ""}`}
            onClick={() => {
              scope.setStoreId(null);
              setOpen(false);
            }}
          >
            <span className="st-dot" data-st={scope.errorCount > 0 ? "failed" : "success"} />
            <span>全部店铺</span>
            <span className="sh-scope-meta">{scope.stores.length} 店</span>
          </button>
          {scope.stores.map((s) => (
            <button
              key={s.id}
              type="button"
              role="option"
              aria-selected={scope.storeId === s.id}
              className={`sh-scope-item${scope.storeId === s.id ? " active" : ""}`}
              onClick={() => {
                scope.setStoreId(s.id);
                setOpen(false);
              }}
            >
              <span className="st-dot" data-st={storeDot(s)} />
              <span>{s.name}</span>
              <span className="sh-scope-meta">
                {s.platform} · {s.status === "active" ? "正常" : s.status === "error" ? "异常" : "已断开"}
              </span>
            </button>
          ))}
          {scope.errorCount > 0 && <div className="sh-scope-foot">{scope.errorCount} 家店连接异常</div>}
        </div>
      )}
    </div>
  );
}

function JobsPill({ status }: { status: ShellStatus }) {
  const seg: ReactNode[] = [];
  if (status.busy > 0) {
    seg.push(
      <span key="busy" className="sh-jobs-seg">
        <span className="st-dot" data-st="running" />
        <b>{status.busy}</b> 在跑
      </span>,
    );
  }
  if (status.failed > 0) {
    seg.push(
      <span key="fail" className="sh-jobs-seg sh-jobs-fail">
        <span className="st-dot" data-st="failed" />
        <b>{status.failed}</b> 失败
      </span>,
    );
  }
  if (status.attention > 0) {
    seg.push(
      <span key="att" className="sh-jobs-seg">
        <span className="st-dot" data-st="ready" />
        <b>{status.attention}</b> 待认领
      </span>,
    );
  }
  if (seg.length === 0) {
    seg.push(
      <span key="idle" className="sh-jobs-seg sh-jobs-idle">
        <span className="st-dot" />
        无待处理任务
      </span>,
    );
  }
  return (
    <Link to="/jobs" className="sh-jobs" data-busy={status.busy > 0} title="查看任务队列">
      {seg.reduce<ReactNode[]>(
        (acc, node, i) => (i === 0 ? [node] : [...acc, <span key={`sep${i}`} className="sh-jobs-sep" />, node]),
        [],
      )}
    </Link>
  );
}

function StatusBar({ status, scope }: { status: ShellStatus; scope: StoreScopeValue }) {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { message } = App.useApp();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const meta = pageMeta(pathname);
  return (
    <header className="sh-topbar">
      <h1 className="sh-title">{meta.title}</h1>
      <span className="sh-context">{meta.context}</span>
      <span className="sh-divider" />
      <ScopeSelect scope={scope} />
      <span className="sh-spacer" />
      <ExtensionBadge />
      <JobsPill status={status} />
      <button
        type="button"
        className="btn ghost sm sh-user"
        title="退出登录"
        onClick={async () => {
          try {
            await api.logout();
          } catch {
            /* 已失效的会话也照常清缓存回登录页 */
          }
          qc.clear();
          navigate("/login");
        }}
      >
        {me.data ? (
          <>
            <b>{me.data.user.name}</b> · {me.data.workspace.name} <LogoutOutlined />
          </>
        ) : (
          "…"
        )}
      </button>
    </header>
  );
}

function ShellBody() {
  const status = useShellStatus();
  const scope = useStoreScope();
  const { pathname } = useLocation();
  const me = useQuery({ queryKey: ["me"], queryFn: api.me, retry: false });
  if (me.isLoading) {
    return (
      <div className="sh" style={{ display: "grid", placeItems: "center" }}>
        <span className="st-dot" data-st="running" />
      </div>
    );
  }
  if (me.isError) {
    return <Navigate to={`/login?next=${encodeURIComponent(pathname)}`} replace />;
  }
  return (
    <div className="sh">
      <NavRail status={status} scope={scope} />
      <div className="sh-main">
        <StatusBar status={status} scope={scope} />
        <main className="sh-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

export function Shell() {
  return (
    <StoreScopeProvider>
      <ShellBody />
    </StoreScopeProvider>
  );
}

/** 供页面读取当前店铺 scope（过滤列表用）。 */
export { useStoreScope };

/** St 组件的统一导出，页面从这里拿状态点。 */
export { St };
