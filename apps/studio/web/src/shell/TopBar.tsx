import { useQuery } from "@tanstack/react-query";
import { Check, ChevronDown, Globe, Store } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { api } from "../api.js";
import { useShopScope } from "./ShopScope.js";

function titleFor(pathname: string): string {
  if (pathname.startsWith("/products")) return "商品";
  if (pathname.startsWith("/shops")) return "店铺";
  if (pathname.startsWith("/tasks")) return "任务";
  if (pathname.startsWith("/settings")) return "设置";
  if (pathname.startsWith("/__demo")) return "壳演示";
  return "铺货";
}

function ShopScopeSwitcher() {
  const { shopId, setShopId, shops } = useShopScope();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const current = shops.find((s) => s.id === shopId);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        btnRef.current?.focus();
      }
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const onMenuKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>(".shell-menu-item"),
    );
    const idx = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      e.key === "ArrowDown"
        ? items[(idx + 1) % items.length]
        : items[(idx - 1 + items.length) % items.length];
    next?.focus();
  };

  const pick = (id: string | null) => {
    setShopId(id);
    setOpen(false);
    btnRef.current?.focus();
  };

  return (
    <div className="shell-scope" ref={rootRef}>
      <button
        ref={btnRef}
        type="button"
        className="shell-scope-btn"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Store size={13} strokeWidth={1.8} aria-hidden />
        <span className="shell-scope-btn-label">
          {current ? current.name : "全部店铺"}
        </span>
        <ChevronDown size={13} strokeWidth={1.8} aria-hidden />
      </button>
      {open && (
        <div className="shell-menu" role="menu" onKeyDown={onMenuKey}>
          <button
            type="button"
            role="menuitem"
            className="shell-menu-item"
            onClick={() => pick(null)}
          >
            <span className="check">{shopId === null && <Check size={13} />}</span>
            <Globe size={14} strokeWidth={1.8} aria-hidden />
            全部店铺
          </button>
          {shops.length > 0 && <div className="shell-menu-sep" />}
          {shops.map((s) => (
            <button
              key={s.id}
              type="button"
              role="menuitem"
              className="shell-menu-item"
              onClick={() => pick(s.id)}
            >
              <span className="check">{shopId === s.id && <Check size={13} />}</span>
              {s.name}
              <span className="meta">
                {s.platform} · {s.site}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function JobsPill() {
  const navigate = useNavigate();
  const { data } = useQuery({
    queryKey: ["jobs-active"],
    queryFn: () => api.jobs(1),
    refetchInterval: 5000,
  });
  const active =
    data?.items.filter((j) => j.job.status === "queued" || j.job.status === "running")
      .length ?? 0;
  if (active === 0) return null;
  return (
    <button
      type="button"
      className="shell-pill"
      onClick={() => navigate("/tasks")}
      title="查看任务"
    >
      <span className="st-dot" data-st="running" aria-hidden />
      {active} 个任务进行中
    </button>
  );
}

export function TopBar() {
  const { pathname } = useLocation();
  return (
    <header className="shell-topbar">
      <div className="shell-title">{titleFor(pathname)}</div>
      <div className="shell-topbar-right">
        <ShopScopeSwitcher />
        <JobsPill />
      </div>
    </header>
  );
}
