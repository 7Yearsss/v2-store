import type { PricingRule, Store } from "@caiji/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import dayjs from "dayjs";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { api } from "../api";

const STATUS: Record<Store["status"], { label: string; color: string }> = {
  active: { label: "正常", color: "success" },
  error: { label: "异常", color: "error" },
  disconnected: { label: "已断开", color: "default" },
};

const AUTH_LABEL: Record<Store["authType"], string> = {
  oauth: "App 安装",
  client_credentials: "Dev Dashboard 应用",
  access_token: "Admin API 令牌",
};

function ConnectShopifyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [mode, setMode] = useState<"oauth" | "client_credentials" | "access_token">("oauth");
  const [form] = Form.useForm();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);

  const submit = async () => {
    const v = await form.validateFields();
    setLoading(true);
    setError(undefined);
    try {
      if (mode === "oauth") {
        const { url } = await api.shopifyInstallUrl(v.shopDomain);
        window.location.href = url;
        return;
      }
      await api.connectShopify({ authType: mode, ...v });
      message.success("店铺已连接");
      qc.invalidateQueries({ queryKey: ["stores"] });
      form.resetFields();
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal title="连接 Shopify 店铺" open={open} onCancel={onClose} onOk={submit} confirmLoading={loading} okText="连接" width={560}>
      <Tabs
        activeKey={mode}
        onChange={(k) => {
          setMode(k as typeof mode);
          setError(undefined);
        }}
        items={[
          { key: "oauth", label: "一键授权（推荐）" },
          { key: "client_credentials", label: "Dev Dashboard 应用" },
          { key: "access_token", label: "Admin API 令牌" },
        ]}
      />
      <Typography.Paragraph type="secondary">
        {mode === "oauth" && "跳转到 Shopify 授权页安装我们的应用，授权完成后自动回到这里。需要服务端已配置 Shopify App。"}
        {mode === "client_credentials" &&
          "在 Shopify Dev Dashboard 创建应用并安装到你的店铺（需勾选 write_products），把 Client ID / Secret 填在这里。令牌每 24 小时自动续期。"}
        {mode === "access_token" && "2026 年以前在店铺后台创建的旧版自定义应用的 Admin API 令牌（shpat_ 开头）。"}
      </Typography.Paragraph>
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="shopDomain" label="店铺域名" rules={[{ required: true }]}>
          <Input placeholder="your-shop.myshopify.com" addonAfter={null} />
        </Form.Item>
        {mode === "client_credentials" && (
          <>
            <Form.Item name="clientId" label="Client ID" rules={[{ required: true }]}>
              <Input />
            </Form.Item>
            <Form.Item name="clientSecret" label="Client Secret" rules={[{ required: true }]}>
              <Input.Password />
            </Form.Item>
          </>
        )}
        {mode === "access_token" && (
          <Form.Item name="accessToken" label="Admin API access token" rules={[{ required: true }]}>
            <Input.Password placeholder="shpat_..." />
          </Form.Item>
        )}
      </Form>
      {error && <Alert type="error" message={error} showIcon />}
    </Modal>
  );
}

function PricingModal({ store, onClose }: { store?: Store; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<PricingRule & { endingOn: boolean }>();
  useEffect(() => {
    if (store) {
      form.setFieldsValue({ ...store.pricing, endingOn: store.pricing.priceEnding != null });
    }
  }, [store, form]);
  const save = useMutation({
    mutationFn: (pricing: PricingRule) => api.updateStore(store!.id, { pricing }),
    onSuccess: () => {
      message.success("定价规则已保存，新认领的商品生效");
      qc.invalidateQueries({ queryKey: ["stores"] });
      onClose();
    },
    onError: (e) => message.error(e.message),
  });
  const watched = Form.useWatch([], form);
  const preview =
    watched?.exchangeRate && watched?.markup
      ? (() => {
          const raw = 10 * watched.exchangeRate * watched.markup;
          if (!watched.endingOn) return raw.toFixed(2);
          const p = Math.floor(raw) + (watched.priceEnding ?? 0.99);
          return (p < raw ? p + 1 : p).toFixed(2);
        })()
      : "—";
  return (
    <Modal
      title={`定价规则 · ${store?.name ?? ""}`}
      open={!!store}
      onCancel={onClose}
      confirmLoading={save.isPending}
      onOk={async () => {
        const v = await form.validateFields();
        save.mutate({
          exchangeRate: v.exchangeRate,
          markup: v.markup,
          priceEnding: v.endingOn ? (v.priceEnding ?? 0.99) : null,
        });
      }}
    >
      <Form form={form} layout="vertical">
        <Form.Item name="exchangeRate" label={`汇率（1 人民币 = ? ${store?.currency ?? ""}）`} rules={[{ required: true }]}>
          <InputNumber min={0.0001} step={0.01} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="markup" label="加价倍数" rules={[{ required: true }]}>
          <InputNumber min={0.1} step={0.1} style={{ width: "100%" }} />
        </Form.Item>
        <Form.Item name="endingOn" label="价格尾数">
          <Select
            options={[
              { value: true, label: "统一尾数" },
              { value: false, label: "保留两位小数" },
            ]}
          />
        </Form.Item>
        {watched?.endingOn && (
          <Form.Item name="priceEnding" label="尾数">
            <InputNumber min={0} max={0.99} step={0.01} style={{ width: "100%" }} />
          </Form.Item>
        )}
      </Form>
      <Typography.Text type="secondary">
        示例：成本 ¥10 → 售价 {preview} {store?.currency}
      </Typography.Text>
    </Modal>
  );
}

export function StoresPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [connectOpen, setConnectOpen] = useState(false);
  const [pricingStore, setPricingStore] = useState<Store>();
  const stores = useQuery({ queryKey: ["stores"], queryFn: api.stores });

  useEffect(() => {
    const connected = params.get("connected");
    if (connected) {
      message.success(`${connected} 已授权`);
      setParams({}, { replace: true });
    }
  }, [params, setParams, message]);

  const verify = useMutation({
    mutationFn: api.verifyStore,
    onSuccess: (s) => {
      if (s.status === "active") message.success("连接正常");
      else message.error(s.lastError ?? "连接异常");
      qc.invalidateQueries({ queryKey: ["stores"] });
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteStore,
    onSuccess: () => {
      message.success("已删除");
      qc.invalidateQueries({ queryKey: ["stores"] });
      qc.invalidateQueries({ queryKey: ["listings"] });
    },
  });

  return (
    <Card
      title="店铺授权"
      extra={
        <Button type="primary" onClick={() => setConnectOpen(true)}>
          连接 Shopify 店铺
        </Button>
      }
    >
      <Table<Store>
        rowKey="id"
        loading={stores.isLoading}
        dataSource={stores.data}
        pagination={false}
        columns={[
          {
            title: "店铺",
            render: (_, s) => (
              <Space direction="vertical" size={0}>
                <span>{s.name}</span>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {s.shopDomain}
                </Typography.Text>
              </Space>
            ),
          },
          { title: "平台", dataIndex: "platform", width: 100, render: () => <Tag color="green">Shopify</Tag> },
          { title: "授权方式", dataIndex: "authType", width: 160, render: (t: Store["authType"]) => AUTH_LABEL[t] },
          { title: "币种", dataIndex: "currency", width: 80 },
          {
            title: "定价",
            width: 170,
            render: (_, s) =>
              `×${s.pricing.exchangeRate} ×${s.pricing.markup}${s.pricing.priceEnding != null ? ` 尾数 ${s.pricing.priceEnding}` : ""}`,
          },
          {
            title: "状态",
            dataIndex: "status",
            width: 100,
            render: (st: Store["status"], s) => {
              const tag = <Tag color={STATUS[st].color}>{STATUS[st].label}</Tag>;
              return s.lastError ? <Tooltip title={s.lastError}>{tag}</Tooltip> : tag;
            },
          },
          { title: "授权时间", dataIndex: "createdAt", width: 120, render: (t: string) => dayjs(t).format("YYYY-MM-DD") },
          {
            title: "操作",
            width: 220,
            render: (_, s) => (
              <Space>
                <a onClick={() => setPricingStore(s)}>定价规则</a>
                <a onClick={() => verify.mutate(s.id)}>检测连接</a>
                <Popconfirm
                  title="删除店铺授权？"
                  description="该店铺下的所有刊登草稿也会被删除（店铺上已发布的商品不受影响）"
                  onConfirm={() => remove.mutate(s.id)}
                >
                  <a style={{ color: "#ff4d4f" }}>删除</a>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <ConnectShopifyModal open={connectOpen} onClose={() => setConnectOpen(false)} />
      <PricingModal store={pricingStore} onClose={() => setPricingStore(undefined)} />
    </Card>
  );
}
