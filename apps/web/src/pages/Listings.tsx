import type { Listing, ListingStatus, RemoteStatus } from "@caiji/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Empty, Image, Input, Popconfirm, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from "antd";
import dayjs from "dayjs";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";

export const STATUS: Record<ListingStatus, { label: string; color: string }> = {
  draft: { label: "草稿", color: "default" },
  publishing: { label: "发布中", color: "processing" },
  published: { label: "已发布", color: "success" },
  failed: { label: "发布失败", color: "error" },
};

/** Product status on the channel (synced back from the store). */
export const REMOTE: Record<RemoteStatus, { label: string; color: string }> = {
  ACTIVE: { label: "在售", color: "green" },
  DRAFT: { label: "草稿", color: "default" },
  ARCHIVED: { label: "已归档", color: "default" },
  UNLISTED: { label: "不公开", color: "default" },
  DELETED: { label: "已删除", color: "red" },
};

export function ListingsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [status, setStatus] = useState<ListingStatus | "all">("draft");
  const [storeId, setStoreId] = useState<string>();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState<string[]>([]);

  // poll both queries while anything is being published
  const counts = useQuery({
    queryKey: ["listings", "counts"],
    queryFn: api.listingCounts,
    refetchInterval: (query) => ((query.state.data?.publishing ?? 0) > 0 ? 2000 : false),
  });
  const publishing = (counts.data?.publishing ?? 0) > 0;
  const stores = useQuery({ queryKey: ["stores"], queryFn: api.stores });
  const list = useQuery({
    queryKey: ["listings", status, storeId, q, page, pageSize],
    queryFn: () =>
      api.listings({ status: status === "all" ? undefined : status, storeId, q, page, pageSize }),
    placeholderData: keepPreviousData,
    refetchInterval: publishing ? 2000 : false,
  });
  // final refresh once the last publish job settles
  const wasPublishing = useRef(false);
  useEffect(() => {
    if (wasPublishing.current && !publishing) list.refetch();
    wasPublishing.current = publishing;
  }, [publishing]); // eslint-disable-line react-hooks/exhaustive-deps

  const invalidate = () => qc.invalidateQueries({ queryKey: ["listings"] });
  const syncAll = useMutation({
    mutationFn: async () => {
      const all = stores.data ?? [];
      await Promise.all(all.filter((s) => s.status === "active").map((s) => api.syncStore(s.id)));
      // the worker picks the job up within a second or two
      await new Promise((r) => setTimeout(r, 3000));
    },
    onSuccess: () => {
      message.success("已从店铺同步最新状态");
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });
  const publish = useMutation({
    mutationFn: (ids: string[]) => api.publish(ids),
    onSuccess: (r) => {
      if (r.queued) message.success(`已提交发布 ${r.queued} 条`);
      for (const b of r.blocked ?? []) {
        message.warning(`「${b.title.slice(0, 30)}」被发布前检查拦截：含禁售词 ${b.words.join("、")}`, 8);
      }
      setSelected([]);
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });
  const del = useMutation({
    mutationFn: () => api.deleteListings(selected),
    onSuccess: (r) => {
      message.success(`已删除 ${r.deleted} 条`);
      setSelected([]);
      invalidate();
    },
  });

  const storeName = (id: string) => stores.data?.find((s) => s.id === id)?.name ?? "—";
  const tabLabel = (s: ListingStatus) => `${STATUS[s].label} ${counts.data?.[s] ?? 0}`;

  return (
    <Card title="刊登管理">
      <Tabs
        activeKey={status}
        onChange={(k) => {
          setStatus(k as ListingStatus | "all");
          setPage(1);
          setSelected([]);
        }}
        items={[
          ...(["draft", "publishing", "published", "failed"] as const).map((s) => ({ key: s, label: tabLabel(s) })),
          { key: "all", label: "全部" },
        ]}
      />
      <Space wrap style={{ marginBottom: 16 }}>
        <Select
          allowClear
          placeholder="全部店铺"
          style={{ width: 200 }}
          value={storeId}
          onChange={(v) => {
            setStoreId(v);
            setPage(1);
          }}
          options={stores.data?.map((s) => ({ value: s.id, label: s.name }))}
        />
        <Input.Search
          placeholder="搜索标题"
          allowClear
          style={{ width: 240 }}
          onSearch={(v) => {
            setQ(v);
            setPage(1);
          }}
        />
        <Button type="primary" disabled={!selected.length} loading={publish.isPending} onClick={() => publish.mutate(selected)}>
          发布{status === "published" ? "（同步更新）" : ""} {selected.length ? `(${selected.length})` : ""}
        </Button>
        <Button loading={syncAll.isPending} onClick={() => syncAll.mutate()}>
          同步店铺状态
        </Button>
        <Popconfirm
          title="删除选中的刊登草稿？"
          description="只删除本平台记录，已发布到店铺的商品不会被删除"
          onConfirm={() => del.mutate()}
          disabled={!selected.length}
        >
          <Button danger disabled={!selected.length}>
            删除
          </Button>
        </Popconfirm>
      </Space>
      <Table<Listing>
        rowKey="id"
        loading={list.isFetching && !list.data}
        dataSource={list.data?.items}
        rowSelection={{
          selectedRowKeys: selected,
          onChange: (k) => setSelected(k as string[]),
          getCheckboxProps: (r) => ({ disabled: r.status === "publishing" }),
        }}
        locale={{
          emptyText: (
            <Empty
              description={
                status === "draft" && !q ? (
                  <span>
                    还没有草稿。去<Link to="/collect-box">采集箱</Link>把商品认领到店铺，或切换上方状态查看。
                  </span>
                ) : status === "failed" ? (
                  "没有发布失败的刊登"
                ) : (
                  "暂无记录"
                )
              }
            />
          ),
        }}
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
            title: "图片",
            dataIndex: "images",
            width: 80,
            render: (imgs: string[]) => (
              <Image
                src={imgs[0] || "/placeholder.svg"}
                fallback="/placeholder.svg"
                width={56}
                height={56}
                style={{ objectFit: "cover" }}
                preview={!!imgs[0]}
              />
            ),
          },
          {
            title: "标题",
            dataIndex: "title",
            render: (t: string, r) => (
              <Space direction="vertical" size={0}>
                <Link to={`/listings/${r.id}`}>{t}</Link>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {storeName(r.storeId)} · {r.variants.length} 个变体
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: "售价",
            width: 130,
            render: (_, r) => {
              const prices = r.variants.map((v) => v.price);
              const min = Math.min(...prices);
              const max = Math.max(...prices);
              return min === max ? min.toFixed(2) : `${min.toFixed(2)} - ${max.toFixed(2)}`;
            },
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 120,
            render: (s: ListingStatus, r) => {
              // published with a warning (e.g. images, sales channel) → orange
              const warn = s === "published" && r.lastError;
              const tag = <Tag color={warn ? "warning" : STATUS[s].color}>{STATUS[s].label}{warn ? " ⚠" : ""}</Tag>;
              return r.lastError ? <Tooltip title={r.lastError}>{tag}</Tooltip> : tag;
            },
          },
          {
            title: "店铺状态",
            width: 110,
            render: (_, r) =>
              r.remoteStatus ? (
                <Tooltip title={r.syncedAt ? `同步于 ${dayjs(r.syncedAt).format("MM-DD HH:mm")}` : undefined}>
                  <Tag color={REMOTE[r.remoteStatus].color}>{REMOTE[r.remoteStatus].label}</Tag>
                </Tooltip>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
          },
          { title: "更新时间", dataIndex: "updatedAt", width: 130, render: (t: string) => dayjs(t).format("MM-DD HH:mm") },
          {
            title: "操作",
            width: 170,
            render: (_, r) => (
              <Space>
                <Link to={`/listings/${r.id}`}>编辑</Link>
                {r.status === "failed" && (
                  <Typography.Link onClick={() => publish.mutate([r.id])}>重发</Typography.Link>
                )}
                {r.remoteUrl && (
                  <a href={r.remoteUrl} target="_blank" rel="noreferrer">
                    店铺后台
                  </a>
                )}
              </Space>
            ),
          },
        ]}
      />
    </Card>
  );
}
