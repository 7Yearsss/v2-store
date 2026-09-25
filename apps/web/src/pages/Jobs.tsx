import type { Job, JobStatus } from "@caiji/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Card, Empty, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";

export const JOB_LABELS: Record<string, string> = {
  "listing.publish": "刊登发布",
  "media.fetchMissing": "图片转存",
  "store.syncListings": "店铺状态同步",
  "listing.aiEnhance": "AI 产线",
  "listing.categorySuggest": "类目推荐",
  "store.syncCategories": "类目树同步",
};

const JOB_STATUS: Record<JobStatus, { label: string; color: string }> = {
  queued: { label: "排队中", color: "default" },
  running: { label: "运行中", color: "processing" },
  succeeded: { label: "成功", color: "success" },
  failed: { label: "失败", color: "error" },
};

export function JobsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [status, setStatus] = useState<JobStatus | "all">("all");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);

  const list = useQuery({
    queryKey: ["jobs", status, page, pageSize],
    queryFn: () => api.jobs({ status: status === "all" ? undefined : status, page, pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: (q) =>
      q.state.data?.items.some((j) => j.status === "queued" || j.status === "running") ? 2000 : false,
  });

  const retry = useMutation({
    mutationFn: api.retryJob,
    onSuccess: () => {
      message.success("已重新排队");
      qc.invalidateQueries({ queryKey: ["jobs"] });
    },
    onError: (e) => message.error(e.message),
  });

  return (
    <Card title="任务中心" extra={<Typography.Text type="secondary">发布、同步、AI 等后台任务的执行记录</Typography.Text>}>
      <Tabs
        activeKey={status}
        onChange={(k) => {
          setStatus(k as JobStatus | "all");
          setPage(1);
        }}
        items={[
          { key: "all", label: "全部" },
          { key: "failed", label: "失败" },
          { key: "running", label: "运行中" },
          { key: "queued", label: "排队中" },
          { key: "succeeded", label: "成功" },
        ]}
      />
      <Table<Job>
        rowKey="id"
        loading={list.isFetching && !list.data}
        dataSource={list.data?.items}
        locale={{ emptyText: <Empty description={status === "failed" ? "没有失败的任务" : "还没有任务记录"} /> }}
        pagination={{
          current: page,
          pageSize,
          total: list.data?.total,
          showSizeChanger: true,
          showTotal: (t) => `共 ${t} 条`,
          onChange: (p, s) => {
            setPage(p);
            setPageSize(s);
          },
        }}
        columns={[
          {
            title: "任务",
            dataIndex: "type",
            render: (t: string, j) => (
              <Space direction="vertical" size={0}>
                <span>{JOB_LABELS[t] ?? t}</span>
                {(j.listingId || j.storeId) && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {j.listingId && <Link to={`/listings/${j.listingId}`}>刊登</Link>}
                    {j.storeId && <Link to="/stores">店铺</Link>}
                  </Typography.Text>
                )}
              </Space>
            ),
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 110,
            render: (s: JobStatus, j) => {
              const tag = <Tag color={JOB_STATUS[s].color}>{JOB_STATUS[s].label}</Tag>;
              return j.lastError && s === "failed" ? <Tooltip title={j.lastError}>{tag}</Tooltip> : tag;
            },
          },
          {
            title: "尝试",
            width: 90,
            render: (_, j) => `${j.attempts}/${j.maxAttempts}`,
          },
          {
            title: "创建时间",
            dataIndex: "createdAt",
            width: 140,
            render: (t: string) => dayjs(t).format("MM-DD HH:mm:ss"),
          },
          {
            title: "最后更新",
            dataIndex: "updatedAt",
            width: 140,
            render: (t: string) => dayjs(t).format("MM-DD HH:mm:ss"),
          },
          {
            title: "操作",
            width: 100,
            render: (_, j) =>
              j.status === "failed" ? (
                <Typography.Link onClick={() => retry.mutate(j.id)}>重试</Typography.Link>
              ) : null,
          },
        ]}
      />
    </Card>
  );
}
