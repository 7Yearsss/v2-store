import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import type { PurchaseOrder, PurchaseOrderStatus, TrackingEntry } from "@caiji/shared";
import { api } from "../api";
import { EmptyState, Err, Loading, St } from "../ui";

const POSTATUS: Record<PurchaseOrderStatus, { st: string; label: string }> = {
  draft: { st: "draft", label: "草稿" },
  placed: { st: "running", label: "已下单" },
  paid: { st: "running", label: "已付款" },
  domestic_shipped: { st: "running", label: "国内段发货" },
  intl_shipped: { st: "running", label: "国际段发货" },
  done: { st: "success", label: "已完成" },
  exception: { st: "failed", label: "异常" },
};

const NEXT: Partial<Record<PurchaseOrderStatus, PurchaseOrderStatus>> = {
  draft: "placed",
  placed: "paid",
  paid: "domestic_shipped",
  domestic_shipped: "intl_shipped",
  intl_shipped: "done",
};

function TrackingModal({
  open,
  po,
  field,
  onClose,
}: {
  open: boolean;
  po: PurchaseOrder;
  field: "domesticTracking" | "intlTracking";
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ carrier?: string; no: string; url?: string }>();
  const save = useMutation({
    mutationFn: async (v: { carrier?: string; no: string; url?: string }) => {
      const list = [...(po[field] ?? []), { carrier: v.carrier, no: v.no, url: v.url }];
      return api.updatePurchaseOrder(po.id, { [field]: list } as never);
    },
    onSuccess: () => {
      message.success("轨迹已录入");
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      onClose();
      form.resetFields();
    },
    onError: (e) => message.error(e.message),
  });
  return (
    <Modal
      title={field === "domesticTracking" ? "国内段轨迹" : "国际段轨迹"}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={save.isPending}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={(v) => save.mutate(v)} preserve={false}>
        <Form.Item name="carrier" label="承运商">
          <Input placeholder="如 中通 / 4PX" />
        </Form.Item>
        <Form.Item name="no" label="单号" rules={[{ required: true }]}>
          <Input />
        </Form.Item>
        <Form.Item name="url" label="轨迹链接">
          <Input placeholder="可选" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function PurchaseOrdersPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [trackFor, setTrackFor] = useState<{ po: PurchaseOrder; field: "domesticTracking" | "intlTracking" } | null>(null);
  const [editFor, setEditFor] = useState<PurchaseOrder | null>(null);
  const [editForm] = Form.useForm<{ sourceOrderId?: string; costTotalCny?: number; forwarderId?: string; note?: string }>();

  const list = useQuery({ queryKey: ["purchase-orders"], queryFn: () => api.purchaseOrders() });
  const forwarders = useQuery({ queryKey: ["freight-forwarders"], queryFn: api.freightForwarders });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["order-counts"] });
  };
  const patch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Parameters<typeof api.updatePurchaseOrder>[1] }) =>
      api.updatePurchaseOrder(id, body),
    onSuccess: () => {
      message.success("已更新");
      invalidate();
      setEditFor(null);
    },
    onError: (e) => message.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deletePurchaseOrder(id),
    onSuccess: () => {
      message.success("已删除草稿");
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });
  const removeItem = useMutation({
    mutationFn: ({ poId, itemId }: { poId: string; itemId: string }) =>
      api.updatePurchaseOrder(poId, { removeItemIds: [itemId] }),
    onSuccess: invalidate,
    onError: (e) => message.error(e.message),
  });

  const groups = useMemo(() => {
    const by = new Map<string, PurchaseOrder[]>();
    for (const p of list.data?.items ?? []) {
      const k = p.sourceSeller ?? "未指定供应商";
      by.set(k, [...(by.get(k) ?? []), p]);
    }
    return [...by.entries()].sort(
      (a, b) =>
        Math.max(...b[1].map((p) => Date.parse(p.updatedAt))) -
        Math.max(...a[1].map((p) => Date.parse(p.updatedAt))),
    );
  }, [list.data]);

  if (list.isLoading) return <Loading />;
  if (list.isError) return <Err error={list.error} onRetry={() => list.refetch()} />;

  const fmtTrack = (ts: TrackingEntry[] | null) =>
    ts?.length ? ts.map((t) => `${t.carrier ?? ""} ${t.no}`.trim()).join("；") : "—";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      {!groups.length && <EmptyState>暂无采购单——在订单页勾选已匹配行项生成</EmptyState>}
      {groups.map(([seller, pos]) => (
        <Card key={seller} title={seller} size="small">
          <Table<PurchaseOrder>
            rowKey="id"
            size="small"
            dataSource={pos}
            pagination={false}
            expandable={{
              expandedRowRender: (p) => (
                <Table
                  rowKey="orderItemId"
                  size="small"
                  dataSource={p.items}
                  pagination={false}
                  columns={[
                    {
                      title: "订单行",
                      render: (_, i) => (
                        <Space direction="vertical" size={0}>
                          <span>{i.orderItem?.orderName ?? "—"} · {i.orderItem?.title ?? "—"}</span>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {i.orderItem?.specText ?? "未选规格"} × {i.qty}
                            {i.unitPriceCny != null ? ` · ¥${i.unitPriceCny}` : ""}
                          </Typography.Text>
                        </Space>
                      ),
                    },
                    {
                      title: "1688",
                      width: 120,
                      render: (_, i) =>
                        i.orderItem?.offerId ? (
                          <a
                            href={`https://detail.1688.com/offer/${i.orderItem.offerId}.html`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {i.orderItem.offerId}
                          </a>
                        ) : (
                          "—"
                        ),
                    },
                    {
                      title: "",
                      width: 60,
                      render: (_, i) =>
                        p.status === "draft" && (
                          <Popconfirm
                            title="从采购单移除该行？"
                            onConfirm={() => removeItem.mutate({ poId: p.id, itemId: i.orderItemId })}
                          >
                            <Button size="small" danger type="link">
                              移除
                            </Button>
                          </Popconfirm>
                        ),
                    },
                  ]}
                />
              ),
            }}
            columns={[
              {
                title: "采购单",
                render: (_, p) => (
                  <Space direction="vertical" size={0}>
                    <b>{p.sourceOrderId ?? `本地单 ${p.id.slice(0, 8)}`}</b>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      {dayjs(p.createdAt).format("MM-DD HH:mm")} · {p.items.length} 行 ·{" "}
                      {p.kind === "source_order" ? "插件回填" : "手工创建"}
                    </Typography.Text>
                  </Space>
                ),
              },
              { title: "成本(¥)", width: 90, render: (_, p) => p.costTotalCny?.toFixed(2) ?? "—" },
              { title: "国内轨迹", render: (_, p) => fmtTrack(p.domesticTracking) },
              { title: "国际轨迹", render: (_, p) => fmtTrack(p.intlTracking) },
              {
                title: "货代",
                width: 140,
                render: (_, p) => p.forwarder?.name ?? "—",
              },
              {
                title: "状态",
                width: 100,
                render: (_, p) => <St st={POSTATUS[p.status].st}>{POSTATUS[p.status].label}</St>,
              },
              {
                title: "操作",
                width: 300,
                render: (_, p) => (
                  <Space size={4} wrap>
                    {NEXT[p.status] && (
                      <Button
                        size="small"
                        type="primary"
                        onClick={() => patch.mutate({ id: p.id, body: { status: NEXT[p.status]! } })}
                      >
                        → {POSTATUS[NEXT[p.status]!].label}
                      </Button>
                    )}
                    {p.status !== "done" && (
                      <Button size="small" onClick={() => patch.mutate({ id: p.id, body: { status: "exception" } })}>
                        异常
                      </Button>
                    )}
                    <Button size="small" onClick={() => setTrackFor({ po: p, field: "domesticTracking" })}>
                      国内轨迹
                    </Button>
                    <Button size="small" onClick={() => setTrackFor({ po: p, field: "intlTracking" })}>
                      国际轨迹
                    </Button>
                    <Button
                      size="small"
                      onClick={() => {
                        setEditFor(p);
                        editForm.setFieldsValue({
                          sourceOrderId: p.sourceOrderId ?? undefined,
                          costTotalCny: p.costTotalCny ?? undefined,
                          forwarderId: p.forwarderId ?? undefined,
                          note: p.note ?? undefined,
                        });
                      }}
                    >
                      编辑
                    </Button>
                    {p.status === "draft" && (
                      <Popconfirm title="删除草稿采购单？" onConfirm={() => del.mutate(p.id)}>
                        <Button size="small" danger>
                          删除
                        </Button>
                      </Popconfirm>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        </Card>
      ))}
      {trackFor && <TrackingModal open po={trackFor.po} field={trackFor.field} onClose={() => setTrackFor(null)} />}
      <Modal
        title="编辑采购单"
        open={!!editFor}
        onCancel={() => setEditFor(null)}
        onOk={() => editForm.submit()}
        confirmLoading={patch.isPending}
        destroyOnHidden
      >
        <Form
          form={editForm}
          layout="vertical"
          preserve={false}
          onFinish={(v) => editFor && patch.mutate({ id: editFor.id, body: v })}
        >
          <Form.Item name="sourceOrderId" label="1688 采购单号">
            <Input placeholder="下单后回填" />
          </Form.Item>
          <Form.Item name="costTotalCny" label="成本合计（¥）">
            <InputNumber min={0} style={{ width: "100%" }} />
          </Form.Item>
          <Form.Item name="forwarderId" label="收货货代">
            <Select
              allowClear
              options={(forwarders.data?.items ?? []).map((f) => ({
                value: f.id,
                label: f.name,
              }))}
              placeholder="未设货代则发买家地址"
            />
          </Form.Item>
          <Form.Item name="note" label="备注">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
