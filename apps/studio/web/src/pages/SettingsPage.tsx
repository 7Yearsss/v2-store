import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { api } from "../api.js";
import { Empty, Err, Loading, fmtTime } from "../components/ui.js";

/** /settings —— 薄页面：API 地址 + 审计日志只读列表 + 关于 */
export function SettingsPage() {
  const auditQ = useQuery({
    queryKey: ["audit-logs"],
    queryFn: () => api.auditLogs(),
  });
  const logs = (auditQ.data?.items ?? []).slice(0, 50);

  return (
    <div className="pg">
      <div className="pg-head">
        <h2>工作台设置</h2>
      </div>

      <div className="snap">
        <div className="snap-kv">
          <span className="snap-k">API 地址</span>
          <span>
            <code>/api</code>（Vite 代理 → http://127.0.0.1:3100）
          </span>
        </div>
        <div className="snap-kv">
          <span className="snap-k">授权模式</span>
          <span>mock —— 建店即授权；真实 OAuth 未接入</span>
        </div>
        <div className="snap-kv">
          <span className="snap-k">平台发布</span>
          <span>确定性模拟：Shopee → 成功；TikTok → 审核中；校验失败 → 失败</span>
        </div>
      </div>

      <div className="pg-head" style={{ marginTop: 8 }}>
        <h2 style={{ fontSize: "var(--fs)" }}>操作日志</h2>
        <span className="pg-sub">最近 50 条</span>
      </div>

      {auditQ.isPending ? (
        <Loading />
      ) : auditQ.isError ? (
        <Err error={auditQ.error} onRetry={() => auditQ.refetch()} />
      ) : logs.length === 0 ? (
        <Empty icon={<ScrollText size={20} />}>还没有操作记录。</Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>时间</th>
                <th>动作</th>
                <th>实体</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((l) => (
                <tr key={l.id}>
                  <td style={{ color: "var(--text-tertiary)", whiteSpace: "nowrap" }}>
                    {fmtTime(l.createdAt)}
                  </td>
                  <td>
                    <span className="tag">{l.action}</span>
                  </td>
                  <td style={{ color: "var(--text-secondary)", whiteSpace: "nowrap" }}>
                    {l.entityType} · {l.entityId.slice(0, 8)}
                  </td>
                  <td style={{ maxWidth: 0 }}>
                    <div
                      style={{
                        maxWidth: 520,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        color: "var(--text-tertiary)",
                      }}
                      title={JSON.stringify(l.payload)}
                    >
                      {JSON.stringify(l.payload)}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="snap" style={{ marginTop: 8 }}>
        <div className="snap-kv">
          <span className="snap-k">关于</span>
          <span>铺货工作台 · Phase 0 —— 选品 → AI 主稿 → 渠道对照 → 一键铺店</span>
        </div>
      </div>
    </div>
  );
}
