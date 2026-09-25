import { Outlet } from "react-router";
import { ShopScopeProvider } from "./ShopScope.js";
import { SideNav } from "./SideNav.js";
import { TopBar } from "./TopBar.js";
import "./shell.css";

/**
 * 方案 A：Linear 严格派壳层。
 * 208px 左导航（5 项）+ 48px 顶栏（页标题 / 店铺范围切换 / 任务 pill）+ 内容区。
 * 嵌套路由经 <Outlet> 渲染，切页不重建壳，ShopScope 选择随之保留。
 */
export function Shell() {
  return (
    <ShopScopeProvider>
      <div className="shell-root">
        <SideNav />
        <div className="shell-main">
          <TopBar />
          <main className="shell-content">
            <Outlet />
          </main>
        </div>
      </div>
    </ShopScopeProvider>
  );
}
