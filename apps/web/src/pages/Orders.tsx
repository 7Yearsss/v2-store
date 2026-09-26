import {
  CheckOutlined,
  CloudSyncOutlined,
  CopyOutlined,
  LinkOutlined,
  ReloadOutlined,
  SendOutlined,
  ShoppingOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import type {
  Order,
  OrderItem,
  OrderStatus,
  ProcureStatus,
  SourceItem,
} from "@caiji/shared";
import { api } from "../api";
import { procureViaExtension } from "../extensionBridge";
import { useStoreScope } from "../shell/storeScope";
import { EmptyState, Err, Loading, St } from "../ui";

const OSTATUS: Record<OrderStatus, { st: string; label: string }> = {
  new: { st: "draft", label: "新订单" },
  to_procure: { st: "running", label: "待采购" },
  procuring: { st: "running", label: "采购中" },
  to_ship: { st: "running", label: "待发货" },
  shipped: { st: "success", label: "已发货" },
  done: { st: "success", label: "已完成" },
  cancelled: { st: "draft", label: "已取消" },
  exception: { st: "failed", label: "异常" },
};

const MAPPING_TAG: Record<OrderItem["mapping"], { color: string; label: string }> = {
  matched: { color: "green", label: "已匹配" },
  partial: { color: "gold", label: "缺规格" },
  unmatched: { color: "red", label: "未匹配" },
};

const PROCURE_TAG: Record<ProcureStatus, { color: string; label: string }> = {
  none: { color: "default", label: "—" },
  queued: { color: "blue", label: "已入采购单" },
  placed: { color: "geekblue", label: "已下单" },
  shipped: { color: "purple", label: "发货中" },
  done: { color: "green", label: "已到货" },
  failed: { color: "red", label: "采购异常" },
};

function BindModal({
  open,
  order,
  item,
  sources,
  onClose,
}: {
  open: boolean;
  order: Order;
  item: OrderItem | null;
  sources: SourceItem[];
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ sourceItemId: string; sourceSkuId?: string }>();
  const sourceItemId = Form.useWatch("sourceItemId", form);
  const src = sources.find((s) => s.id === sourceItemId);

  const bind = useMutation({
    mutationFn: (v: { sourceItemId: string; sourceSkuId?: string }) =>
      api.bindOrderItem(order.id, item!.id, v),
    onSuccess: () => {
      message.success("已绑定货源");
      qc.invalidateQueries({ queryKey: ["orders"] });
      onClose();
      form.resetFields();
    },
    onError: (e) => message.error(e.message),
  });

  return (
    <Modal
      title={item ? `绑定货源：${item.title.slice(0, 30)}` : "绑定货源"}
      open={open}
      onCancel={onClose}
      onOk={() => form.submit()}
      confirmLoading={bind.isPending}
      okText="绑定"
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={(v) => bind.mutate(v)} preserve={false}>
        <Form.Item name="sourceItemId" label="货源（采集箱）" rules={[{ required: true }]}>
          <Select
            showSearch
            optionFilterProp="label"
            options={sources.map((s) => ({
              value: s.id,
              label: `${s.title.slice(0, 40)} · ${s.sourceItemId}`,
            }))}
            placeholder="选择 1688 货源"
          />
        </Form.Item>
        <Form.Item name="sourceSkuId" label="规格（sku）">
          <Select
            allowClear
            options={(src?.skus ?? []).map((s) => ({
              value: s.skuId,
              label: `${s.spec}${s.priceCny != null ? ` · ¥${s.priceCny}` : ""}`,
            }))}
            placeholder={src ? "选择规格" : "先选货源"}
            disabled={!src}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function FulfillModal({
  open,
  order,
  onClose,
}: {
  open: boolean;
  order: Order;
  onClose: () => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ trackingNo: string; carrier?: string; trackingUrl?: string }>();
  const [retryId, setRetryId] = useState<string | null>(null);
  const retryShipment = retryId ? order.shipments?.find((s) => s.id === retryId) : undefined;

  const fulfill = useMutation({
    mutationFn: (v: { trackingNo: string; carrier?: string; trackingUrl?: string }) =>
      api.fulfillOrder(order.id, { ...v, shipmentId: retryId ?? undefined }),
    onSuccess: () => {
      message.success("已提交履约回传");
      qc.invalidateQueries({ queryKey: ["orders"] });
      onClose();
      setRetryId(null);
      form.resetFields();
    },
    onError: (e) => message.error(e.message),
  });

  return (
    <Modal
      title={`录运单：${order.name ?? order.remoteId}`}
      open={open}
      onCancel={() => {
        onClose();
        setRetryId(null);
      }}
      onOk={() => form.submit()}
      confirmLoading={fulfill.isPending}
      okText={retryId ? "重推" : "发货"}
      destroyOnHidden
    >
      {order.shipments?.length ? (
        <Descriptions size="small" column={1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="已有运单">
            <Space direction="vertical" size={4} style={{ width: "100%" }}>
              {order.shipments.map((s) => (
                <Space key={s.id} size={8}>
                  <Tag color={s.status === "pushed" ? "green" : s.status === "failed" ? "red" : "blue"}>
                    {s.status === "pushed" ? "已回传" : s.status === "failed" ? "失败" : "待推送"}
                  </Tag>
                  <Typography.Text copyable={{ text: s.trackingNo ?? "" }}>
                    {s.carrier ?? ""} {s.trackingNo ?? "—"}
                  </Typography.Text>
                  {s.status === "failed" && (
                    <Button
                      size="small"
                      type="link"
                      onClick={() => {
                        setRetryId(s.id);
                        form.setFieldsValue({
                          trackingNo: s.trackingNo ?? "",
                          carrier: s.carrier ?? undefined,
                          trackingUrl: s.trackingUrl ?? undefined,
                        });
                      }}
                    >
                      重推
                    </Button>
                  )}
                </Space>
              ))}
            </Space>
          </Descriptions.Item>
        </Descriptions>
      ) : null}
      <Form form={form} layout="vertical" onFinish={(v) => fulfill.mutate(v)} preserve={false}>
        <Form.Item name="trackingNo" label="运单号" rules={[{ required: true }]}>
          <Input placeholder="国际段运单号" />
        </Form.Item>
        <Form.Item name="carrier" label="承运商">
          <Input placeholder="如 4PX / YunExpress / DHL" />
        </Form.Item>
        <Form.Item name="trackingUrl" label="轨迹链接">
          <Input placeholder="可选" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function OrdersPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const scope = useStoreScope();
  const [status, setStatus] = useState<OrderStatus | "all">("all");
  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [bindFor, setBindFor] = useState<{ order: Order; item: OrderItem } | null>(null);
  const [fulfillFor, setFulfillFor] = useState<Order | null>(null);
  const [pendingItems, setPendingItems] = useState<string[]>([]);

  const list = useQuery({
    queryKey: ["orders", status, scope.storeId, q, page],
    queryFn: () =>
      api.orders({
        status: status === "all" ? undefined : status,
        storeId: scope.storeId ?? undefined,
        q: q || undefined,
        page,
        pageSize: 20,
      }),
    refetchInterval: 15_000,
  });
  const counts = useQuery({ queryKey: ["order-counts"], queryFn: api.orderCounts });
  const sources = useQuery({
    queryKey: ["source-items", "all"],
    queryFn: async () => {
      const first = await api.sourceItems({ page: 1, pageSize: 100 });
      const pages = Math.ceil(first.total / 100);
      if (pages <= 1) return first.items;
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) => api.sourceItems({ page: i + 2, pageSize: 100 })),
      );
      return [first.items, ...rest.map((r) => r.items)].flat();
    },
    staleTime: 30_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["orders"] });
    qc.invalidateQueries({ queryKey: ["order-counts"] });
  };
  const review = useMutation({
    mutationFn: (id: string) => api.reviewOrder(id),
    onSuccess: () => {
      message.success("已审核，可采购");
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });
  const syncNow = useMutation({
    mutationFn: (id: string) => api.syncOrder(id),
    onSuccess: () => {
      message.success("已入队同步");
      setTimeout(invalidate, 3000);
    },
    onError: (e) => message.error(e.message),
  });
  const syncStore = useMutation({
    mutationFn: () => {
      const sid = scope.storeId ?? scope.stores[0]?.id;
      if (!sid) return Promise.reject(new Error("请先选择店铺"));
      return api.syncStoreOrders(sid);
    },
    onSuccess: () => {
      message.success("已入队全量订单同步");
      setTimeout(invalidate, 3000);
    },
    onError: (e) => message.error(e.message),
  });
  const procure = useMutation({
    mutationFn: async (o: Order) => {
      const payload = await api.procureOrder(o.id);
      await procureViaExtension(payload);
      return payload;
    },
    onSuccess: (p) =>
      message.success(`已把 ${p.offers.length} 个货源发给插件，去打开的 1688 详情页看采购卡`),
    onError: (e) =>
      message.error(
        e.message.includes("插件") ? "未检测到插件或插件未授权，请先在设置页授权" : e.message,
      ),
  });
  const makePo = useMutation({
    mutationFn: (ids: string[]) => api.createPurchaseOrders({ orderItemIds: ids }),
    onSuccess: (r) => {
      message.success(`已生成 ${r.total} 张采购单`);
      setPendingItems([]);
      invalidate();
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
    },
    onError: (e) => message.error(e.message),
  });

  const copyAddress = async (o: Order) => {
    try {
      const { address } = await api.orderAddress(o.id);
      const text = [
        address.recipient,
        address.phone,
        [address.country, address.province, address.city].filter(Boolean).join(" "),
        address.address1,
        address.address2,
        address.postcode,
      ]
        .filter(Boolean)
        .join("，");
      await navigator.clipboard.writeText(text);
      message.success("已复制收货地址");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "复制失败");
    }
  };

  const items = useMemo(() => list.data?.items ?? [], [list.data]);
  const matchedItems = items
    .flatMap((o) => o.items ?? [])
    .filter((i) => i.mapping !== "unmatched" && i.procureStatus === "none");

  if (list.isLoading) return <Loading />;
  if (list.isError) return <Err error={list.error} onRetry={() => list.refetch()} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <Tabs
        activeKey={status}
        onChange={(k) => {
          setStatus(k as OrderStatus | "all");
          setPage(1);
        }}
        items={[
          { key: "all", label: `全部 ${Object.values(counts.data ?? {}).reduce((a, b) => a + (b ?? 0), 0)}` },
          ...Object.entries(OSTATUS).map(([k, v]) => ({
            key: k,
            label: `${v.label} ${counts.data?.[k as OrderStatus] ?? 0}`,
          })),
        ]}
      />
      <Space wrap>
        <Input.Search
          placeholder="订单号 / 远端 ID"
          allowClear
          onSearch={(v) => {
            setQ(v);
            setPage(1);
          }}
          style={{ width: 240 }}
        />
        <Tooltip title="手动补拉订单（webhook 未达时的兜底）">
          <Button icon={<CloudSyncOutlined />} onClick={() => syncStore.mutate()} loading={syncStore.isPending}>
            同步订单
          </Button>
        </Tooltip>
        {pendingItems.length > 0 && (
          <Button type="primary" icon={<ShoppingOutlined />} onClick={() => makePo.mutate(pendingItems)}>
            生成采购单（{pendingItems.length} 行）
          </Button>
        )}
      </Space>
      <Table<Order>
        rowKey="id"
        size="middle"
        dataSource={items}
        locale={{ emptyText: <EmptyState>暂无订单</EmptyState> }}
        pagination={{
          current: page,
          pageSize: 20,
          total: list.data?.total ?? 0,
          onChange: setPage,
          showSizeChanger: false,
        }}
        expandable={{
          expandedRowRender: (o) => (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <Space size={16} wrap>
                <Typography.Text type="secondary">
                  收货：{o.shippingAddressMasked ?? "—"}
                </Typography.Text>
                <Button size="small" icon={<CopyOutlined />} onClick={() => copyAddress(o)}>
                  复制地址
                </Button>
                {o.profit && (
                  <Typography.Text type="secondary">
                    成本 ¥{o.profit.costCny.toFixed(2)} · 毛利 ≈ ¥{(o.profit.grossCny - o.profit.costCny).toFixed(2)}
                  </Typography.Text>
                )}
              </Space>
              <Table<OrderItem>
                rowKey="id"
                size="small"
                dataSource={o.items ?? []}
                pagination={false}
                rowSelection={{
                  selectedRowKeys: pendingItems,
                  onChange: (keys) =>
                    setPendingItems([...pendingItems.filter((k) => !(o.items ?? []).some((i) => i.id === k)), ...(keys as string[])]),
                  getCheckboxProps: (i) => ({
                    disabled: i.mapping === "unmatched" || i.procureStatus !== "none",
                  }),
                }}
                columns={[
                  {
                    title: "行项",
                    render: (_, i) => (
                      <Space direction="vertical" size={0}>
                        <span>{i.title}</span>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          SKU {i.sku ?? "—"} · ¥{i.unitPrice?.toFixed(2) ?? "—"} × {i.qty}
                        </Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: "映射",
                    width: 90,
                    render: (_, i) => (
                      <Tag color={MAPPING_TAG[i.mapping].color}>{MAPPING_TAG[i.mapping].label}</Tag>
                    ),
                  },
                  {
                    title: "货源",
                    render: (_, i) =>
                      i.offerId ? (
                        <Space direction="vertical" size={0}>
                          <a
                            href={`https://detail.1688.com/offer/${i.offerId}.html`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {i.sourceTitle ?? i.offerId} <LinkOutlined />
                          </a>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            {i.specText ?? "未选规格"}
                            {i.costCny != null ? ` · ¥${i.costCny}` : ""}
                          </Typography.Text>
                        </Space>
                      ) : (
                        <Button size="small" onClick={() => setBindFor({ order: o, item: i })}>
                          绑定货源
                        </Button>
                      ),
                  },
                  {
                    title: "采购",
                    render: (_, i) => (
                      <Space size={4} wrap>
                        <Tag color={PROCURE_TAG[i.procureStatus].color}>
                          {PROCURE_TAG[i.procureStatus].label}
                        </Tag>
                        {(i.purchaseOrders ?? []).map((p) => (
                          <Tooltip key={p.id} title={`采购单 ${p.sourceOrderId ?? p.id.slice(0, 8)}`}>
                            <Tag>PO {p.sourceOrderId ?? "—"}</Tag>
                          </Tooltip>
                        ))}
                        {i.mapping !== "unmatched" && i.procureStatus === "none" && null}
                      </Space>
                    ),
                  },
                ]}
              />
            </div>
          ),
        }}
        columns={[
          {
            title: "订单",
            render: (_, o) => (
              <Space direction="vertical" size={0}>
                <b>{o.name ?? o.remoteId}</b>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {o.storeName ?? ""} · {o.itemsCount} 项
                </Typography.Text>
              </Space>
            ),
          },
          {
            title: "买家",
            render: (_, o) => o.customer?.name ?? "—",
          },
          {
            title: "金额",
            render: (_, o) => `${o.currency ?? ""} ${o.total?.toFixed(2) ?? "—"}`,
          },
          {
            title: "付款/发货",
            render: (_, o) => (
              <Space size={4}>
                <Tag>{o.financialStatus ?? "—"}</Tag>
                <Tag>{o.fulfillmentStatus ?? "—"}</Tag>
              </Space>
            ),
          },
          {
            title: "下单时间",
            render: (_, o) => (o.placedAt ? dayjs(o.placedAt).format("MM-DD HH:mm") : "—"),
          },
          {
            title: "状态",
            render: (_, o) => <St st={OSTATUS[o.status].st}>{OSTATUS[o.status].label}</St>,
          },
          {
            title: "操作",
            render: (_, o) => (
              <Space size={4} wrap>
                {o.status === "new" && (
                  <Button size="small" icon={<CheckOutlined />} onClick={() => review.mutate(o.id)}>
                    审核
                  </Button>
                )}
                {["to_procure", "procuring"].includes(o.status) && (
                  <Button size="small" icon={<ShoppingOutlined />} onClick={() => procure.mutate(o)}>
                    去采购
                  </Button>
                )}
                {["to_ship", "shipped", "procuring", "done", "exception"].includes(o.status) && (
                  <Button size="small" icon={<SendOutlined />} onClick={() => setFulfillFor(o)}>
                    录运单
                  </Button>
                )}
                <Button size="small" icon={<ReloadOutlined />} onClick={() => syncNow.mutate(o.id)} />
              </Space>
            ),
          },
        ]}
      />
      {bindFor && (
        <BindModal
          open
          order={bindFor.order}
          item={bindFor.item}
          sources={sources.data ?? []}
          onClose={() => setBindFor(null)}
        />
      )}
      {fulfillFor && <FulfillModal open order={fulfillFor} onClose={() => setFulfillFor(null)} />}
    </div>
  );
}
