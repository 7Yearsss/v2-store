import type { SourceItem } from "@caiji/shared";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Checkbox,
  Empty,
  Image,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import dayjs from "dayjs";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { collectOfferById } from "../extensionBridge";
import { useExtension } from "../layout/AppLayout";

function extractOfferId(input: string): string | null {
  const t = input.trim();
  return (
    t.match(/offer\/(\d+)/)?.[1] ?? t.match(/[?&]offerId=(\d+)/)?.[1] ?? (/^\d{6,}$/.test(t) ? t : null)
  );
}

function LinkCollect({ onDone }: { onDone: () => void }) {
  const { message } = App.useApp();
  const ext = useExtension();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !!ext.data?.authorized;

  const run = async () => {
    const ids = [...new Set(value.split(/\s+/).map(extractOfferId).filter((v): v is string => !!v))];
    if (!ids.length) {
      message.warning("请粘贴 1688 商品链接或 offerId，多个用空格/换行分隔");
      return;
    }
    setBusy(true);
    let ok = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await collectOfferById(id);
        ok++;
      } catch (e) {
        errors.push(`${id}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    onDone();
    if (errors.length) message.error(`成功 ${ok}，失败 ${errors.length}：${errors[0]}`);
    else {
      message.success(`采集成功 ${ok} 个`);
      setValue("");
    }
  };

  return (
    <Space.Compact style={{ width: "100%" }}>
      <Input
        placeholder={ready ? "粘贴 1688 链接或 offerId（多个用空格分隔），通过插件采集" : "需要先安装并授权插件"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onPressEnter={run}
        disabled={!ready}
      />
      <Button type="primary" loading={busy} disabled={!ready} onClick={run}>
        链接采集
      </Button>
    </Space.Compact>
  );
}

function ClaimModal({ ids, open, onClose }: { ids: string[]; open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const stores = useQuery({ queryKey: ["stores"], queryFn: api.stores, enabled: open });
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const claim = useMutation({
    mutationFn: () => api.claim(ids, storeIds),
    onSuccess: (r) => {
      message.success(`已认领 ${r.created} 条${r.skipped ? `，跳过已认领 ${r.skipped} 条` : ""}`);
      qc.invalidateQueries({ queryKey: ["source-items"] });
      qc.invalidateQueries({ queryKey: ["listings"] });
      setStoreIds([]);
      onClose();
    },
    onError: (e) => message.error(e.message),
  });
  const active = stores.data?.filter((s) => s.status === "active") ?? [];
  return (
    <Modal
      title={`认领 ${ids.length} 个商品到店铺`}
      open={open}
      onCancel={onClose}
      onOk={() => claim.mutate()}
      okButtonProps={{ disabled: !storeIds.length, loading: claim.isPending }}
      okText="认领"
    >
      {stores.data && !active.length ? (
        <Empty description={<span>还没有可用店铺，<Link to="/stores">去授权</Link></span>} />
      ) : (
        <Checkbox.Group
          style={{ display: "flex", flexDirection: "column", gap: 8 }}
          value={storeIds}
          onChange={(v) => setStoreIds(v as string[])}
          options={active.map((s) => ({ value: s.id, label: `${s.name}（${s.shopDomain}）` }))}
        />
      )}
      <Typography.Paragraph type="secondary" style={{ marginTop: 16, marginBottom: 0 }}>
        认领后按店铺的定价规则生成刊登草稿，可在「刊登管理」里编辑后发布。
      </Typography.Paragraph>
    </Modal>
  );
}

export function CollectBoxPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [selected, setSelected] = useState<string[]>([]);
  const [claimOpen, setClaimOpen] = useState(false);

  const list = useQuery({
    queryKey: ["source-items", q, page, pageSize],
    queryFn: () => api.sourceItems({ q, page, pageSize }),
    placeholderData: keepPreviousData,
  });
  const stores = useQuery({ queryKey: ["stores"], queryFn: api.stores });
  const storeName = (id: string) => stores.data?.find((s) => s.id === id)?.name ?? "店铺";

  const del = useMutation({
    mutationFn: () => api.deleteSourceItems(selected),
    onSuccess: (r) => {
      message.success(`已删除 ${r.deleted} 条`);
      setSelected([]);
      qc.invalidateQueries({ queryKey: ["source-items"] });
    },
  });

  return (
    <Card title="采集箱" extra={<Typography.Text type="secondary">插件采集的货源原料，认领到店铺后进入刊登</Typography.Text>}>
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        <LinkCollect onDone={() => qc.invalidateQueries({ queryKey: ["source-items"] })} />
        <Space wrap>
          <Input.Search
            placeholder="搜索标题"
            allowClear
            onSearch={(v) => {
              setQ(v);
              setPage(1);
            }}
            style={{ width: 260 }}
          />
          <Button type="primary" disabled={!selected.length} onClick={() => setClaimOpen(true)}>
            认领到店铺 {selected.length ? `(${selected.length})` : ""}
          </Button>
          <Popconfirm title={`删除选中的 ${selected.length} 条？`} onConfirm={() => del.mutate()} disabled={!selected.length}>
            <Button danger disabled={!selected.length}>
              删除
            </Button>
          </Popconfirm>
        </Space>
        <Table<SourceItem>
          rowKey="id"
          loading={list.isFetching}
          dataSource={list.data?.items}
          rowSelection={{ selectedRowKeys: selected, onChange: (k) => setSelected(k as string[]), preserveSelectedRowKeys: true }}
          locale={{
            emptyText: (
              <Empty
                description={
                  q ? (
                    "没有匹配的商品"
                  ) : (
                    <span>
                      采集箱是空的。在 1688 商品页点「加入采集箱」，或在上方粘贴商品链接/offerId 批量采集。
                    </span>
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
                  <a href={r.sourceUrl} target="_blank" rel="noreferrer">
                    {t}
                  </a>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {r.sourcePlatform} · {r.sourceItemId} {r.sellerName ? `· ${r.sellerName}` : ""}
                  </Typography.Text>
                </Space>
              ),
            },
            { title: "价格", dataIndex: "priceText", width: 110, render: (p, r) => p ?? (r.skus[0]?.priceCny ? `¥${r.skus[0].priceCny}` : "—") },
            { title: "SKU", width: 70, render: (_, r) => r.skus.length },
            {
              title: "已认领",
              dataIndex: "claimedStoreIds",
              width: 180,
              render: (ids: string[]) =>
                ids.length ? ids.map((id) => <Tag key={id}>{storeName(id)}</Tag>) : <Typography.Text type="secondary">未认领</Typography.Text>,
            },
            { title: "采集时间", dataIndex: "collectedAt", width: 150, render: (t: string) => dayjs(t).format("MM-DD HH:mm") },
          ]}
        />
      </Space>
      <ClaimModal ids={selected} open={claimOpen} onClose={() => setClaimOpen(false)} />
    </Card>
  );
}
