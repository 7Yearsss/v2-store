import {
  ArrowRightOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CloudUploadOutlined,
  InboxOutlined,
  ShopOutlined,
} from "@ant-design/icons";
import { useQuery } from "@tanstack/react-query";
import { Alert, Card, List, Skeleton, Tag, Typography } from "antd";
import dayjs from "dayjs";
import type { ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api";
import { useExtension } from "../layout/AppLayout";
import { REMOTE, STATUS } from "./Listings";

function Stage({
  icon,
  label,
  count,
  hint,
  to,
}: {
  icon?: ReactNode;
  label: string;
  count?: number;
  hint?: string;
  to?: string;
}) {
  const nav = useNavigate();
  const inner = (
    <div
      onClick={to ? () => nav(to) : undefined}
      style={{
        cursor: to ? "pointer" : "default",
        padding: "14px 18px",
        border: "1px solid #f0f0f0",
        borderRadius: 8,
        minWidth: 150,
        background: "#fff",
      }}
    >
      <Typography.Text type="secondary" style={{ fontSize: 13 }}>
        {icon} {label}
      </Typography.Text>
      <div style={{ fontSize: 28, fontWeight: 600, lineHeight: 1.3 }}>{count ?? "—"}</div>
      {hint && (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {hint}
        </Typography.Text>
      )}
    </div>
  );
  return inner;
}

export function DashboardPage() {
  const overview = useQuery({
    queryKey: ["overview"],
    queryFn: api.overview,
    refetchInterval: (q) =>
      (q.state.data?.listings.publishing ?? 0) > 0 || (q.state.data?.jobs.running ?? 0) > 0 ? 3000 : false,
  });
  const ext = useExtension();
  const d = overview.data;
  const unclaimed = d?.collectBox.unclaimed ?? 0;
  const busy = (d?.jobs.pending ?? 0) + (d?.jobs.running ?? 0) + (d?.listings.publishing ?? 0);

  return (
    <div style={{ maxWidth: 960 }}>
      <Typography.Title level={3} style={{ marginTop: 0 }}>
        工作台
      </Typography.Title>

      {ext.data && !ext.data.authorized && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="采集插件未授权"
          description="点右上角「授权插件」把插件绑到当前团队，才能采集 1688 商品和定时回扫货源。"
        />
      )}

      <Card
        title="采集 → 发布"
        loading={!d}
        extra={
          busy > 0 ? (
            <Tag color="processing">
              {[d?.jobs.pending ? `${d.jobs.pending} 任务排队` : "", d?.listings.publishing ? `${d.listings.publishing} 条发布中` : ""]
                .filter(Boolean)
                .join("，")}
            </Tag>
          ) : undefined
        }
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <Stage
            icon={<InboxOutlined />}
            label="采集箱"
            count={d?.collectBox.total}
            hint={unclaimed ? `${unclaimed} 条未认领` : undefined}
            to="/collect-box"
          />
          <ArrowRightOutlined style={{ color: "#bfbfbf" }} />
          <Stage icon={<ShopOutlined />} label="草稿" count={d?.listings.draft} to="/listings" />
          <ArrowRightOutlined style={{ color: "#bfbfbf" }} />
          <Stage icon={<CloudUploadOutlined />} label="已发布" count={d?.listings.published} to="/listings" />
          {(d?.listings.failed ?? 0) > 0 && (
            <>
              <ArrowRightOutlined style={{ color: "#bfbfbf" }} />
              <Stage label="发布失败" count={d?.listings.failed} to="/listings" />
            </>
          )}
        </div>
        {(d?.jobs.failed24h ?? 0) > 0 && (
          <Alert
            type="error"
            showIcon
            style={{ marginTop: 16 }}
            message={`最近 24 小时有 ${d?.jobs.failed24h} 个后台任务失败（同步/采集等，不含发布）`}
          />
        )}
      </Card>

      <Card title="最近发布结果" style={{ marginTop: 16 }}>
        {!d ? (
          <Skeleton active />
        ) : d.recentResults.length === 0 ? (
          <Typography.Text type="secondary">
            还没有发布记录。去<Link to="/collect-box">采集箱</Link>认领一条试试。
          </Typography.Text>
        ) : (
          <List
            size="small"
            dataSource={d.recentResults}
            renderItem={(r) => (
              <List.Item
                extra={<Typography.Text type="secondary">{dayjs(r.updatedAt).format("MM-DD HH:mm")}</Typography.Text>}
              >
                <List.Item.Meta
                  avatar={
                    r.status === "published" ? (
                      <CheckCircleFilled style={{ color: "#52c41a", fontSize: 18 }} />
                    ) : (
                      <CloseCircleFilled style={{ color: "#ff4d4f", fontSize: 18 }} />
                    )
                  }
                  title={
                    <span>
                      <Link to={`/listings/${r.id}`}>{r.title}</Link>{" "}
                      <Tag color={STATUS[r.status].color} style={{ marginLeft: 4 }}>
                        {STATUS[r.status].label}
                      </Tag>
                      {r.remoteStatus && (
                        <Tag color={REMOTE[r.remoteStatus].color}>{REMOTE[r.remoteStatus].label}</Tag>
                      )}
                    </span>
                  }
                  description={
                    r.lastError ? (
                      <Typography.Text type="danger" style={{ fontSize: 12 }}>
                        {r.lastError}
                      </Typography.Text>
                    ) : undefined
                  }
                />
              </List.Item>
            )}
          />
        )}
      </Card>
    </div>
  );
}
