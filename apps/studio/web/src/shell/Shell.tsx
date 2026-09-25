import { Outlet } from "react-router";

// TODO(shell-A / shell-B 竞赛): Linear 风壳层——左侧导航(5 项)、顶栏(店铺范围切换
// + 全局任务状态)、内容区。当前为可编译占位，竞赛赢家整体替换本文件。
export function Shell() {
  return (
    <div style={{ padding: 24 }}>
      <p style={{ color: "var(--text-secondary)" }}>shell placeholder — awaiting competition winner</p>
      <Outlet />
    </div>
  );
}
