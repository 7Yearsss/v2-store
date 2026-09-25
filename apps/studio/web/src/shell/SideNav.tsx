import { ListChecks, Package, Rocket, Settings, Store } from "lucide-react";
import { NavLink } from "react-router";

/** 冻结一级导航：恰好 5 项，默认落「铺货」。 */
const NAV_ITEMS = [
  { to: "/publish", label: "铺货", Icon: Rocket },
  { to: "/products", label: "商品", Icon: Package },
  { to: "/shops", label: "店铺", Icon: Store },
  { to: "/tasks", label: "任务", Icon: ListChecks },
  { to: "/settings", label: "设置", Icon: Settings },
] as const;

export function SideNav() {
  return (
    <nav className="shell-nav" aria-label="主导航">
      <div className="shell-brand">
        <span className="shell-brand-mark" aria-hidden />
        <span className="shell-brand-name">Reizo</span>
        <span className="shell-brand-sub">铺货工作台</span>
      </div>
      <div className="shell-nav-items">
        {NAV_ITEMS.map(({ to, label, Icon }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              isActive ? "shell-nav-item active" : "shell-nav-item"
            }
          >
            <Icon size={15} strokeWidth={1.8} aria-hidden />
            {label}
          </NavLink>
        ))}
      </div>
      <div className="shell-nav-user">
        <span className="shell-avatar" aria-hidden>
          D
        </span>
        <span className="shell-user-name">demo@reizo</span>
      </div>
    </nav>
  );
}
