import { Outlet } from "react-router";
import { useJobsStatus } from "./jobsStatus.js";
import { NavRail } from "./NavRail.js";
import { ShopScopeProvider, useShopScope } from "./shopScope.js";
import { StatusBar } from "./StatusBar.js";
import "./shell.css";

function ShellBody() {
  const jobs = useJobsStatus();
  const scope = useShopScope();
  return (
    <div className="sh">
      <NavRail jobs={jobs} scope={scope} />
      <div className="sh-main">
        <StatusBar jobs={jobs} scope={scope} />
        <main className="sh-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

/** 方案 B「状态优先」壳：窄 icon 栏 + 顶栏状态条（页上下文/店铺范围/任务 pill）。 */
export function Shell() {
  return (
    <ShopScopeProvider>
      <ShellBody />
    </ShopScopeProvider>
  );
}
