import { ListChecks, Package, Rocket, Settings, Store } from "lucide-react";
import { NavLink } from "react-router";
import type { JobsStatus } from "./jobsStatus.js";
import type { ShopScopeValue } from "./shopScope.js";

const ITEMS = [
  { to: "/publish", label: "铺货", icon: Rocket, end: false },
  { to: "/products", label: "商品", icon: Package, end: false },
  { to: "/shops", label: "店铺", icon: Store, end: false },
  { to: "/tasks", label: "任务", icon: ListChecks, end: false },
  { to: "/settings", label: "设置", icon: Settings, end: false },
] as const;

/** 方案 B 窄状态栏（~68px）：icon + 短标签，状态徽标直接压在导航项上。 */
export function NavRail({
  jobs,
  scope,
}: {
  jobs: JobsStatus;
  scope: ShopScopeValue;
}) {
  const badgesFor = (to: string): { count: number; kind: "accent" | "alert" }[] => {
    if (to === "/tasks") {
      const b: { count: number; kind: "accent" | "alert" }[] = [];
      if (jobs.failed > 0) b.push({ count: jobs.failed, kind: "alert" });
      if (jobs.busy) b.push({ count: jobs.running + jobs.queued, kind: "accent" });
      return b;
    }
    if (to === "/shops" && scope.expiredCount > 0)
      return [{ count: scope.expiredCount, kind: "alert" }];
    return [];
  };

  return (
    <nav className="sh-rail" aria-label="主导航">
      <div className="sh-logo" aria-hidden>
        <span className="sh-logo-mark" />
      </div>
      {ITEMS.map(({ to, label, icon: Icon, end }) => {
        const badges = badgesFor(to);
        return (
          <NavLink
            key={to}
            to={to}
            end={end}
            className={({ isActive }) =>
              `sh-navitem${isActive ? " active" : ""}`
            }
          >
            <span className="sh-navitem-icon">
              <Icon size={18} strokeWidth={1.8} />
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
