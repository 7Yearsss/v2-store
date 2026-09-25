import type { PricingRule, Store, StoreRules, StoreSettingsPayload } from "@caiji/shared";
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
  Switch,
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

/** Mirrors applyPricing on the server so the preview matches real prices. */
function previewPrice(costCny: number, p: Partial<PricingRule> & { endingOn?: boolean }) {
  if (!p.exchangeRate || !p.markup) return null;
  const converted = (costCny + (p.extraCostCny ?? 0)) * p.exchangeRate * p.markup;
  const raw = Math.max(converted, p.minPrice ?? 0);
  if (!p.endingOn) return raw.toFixed(2);
  const v = Math.floor(raw) + (p.priceEnding ?? 0.99);
  return (v < raw ? v + 1 : v).toFixed(2);
}

type SettingsForm = PricingRule & {
  endingOn: boolean;
  vendor: string;
  aiEnhance: boolean;
  language: string;
  titlePrefix?: string;
  titleSuffix?: string;
  replacementsText?: string;
  priceMinCny?: number;
  priceMaxCny?: number;
  maxImages?: number;
  bannedWords?: string[];
  publishStatus?: "active" | "draft";
  trackStock?: boolean;
  defaultTags?: string[];
  defaultProductType?: string;
};

const rulesToText = (rules?: StoreRules["replacements"]) =>
  (rules ?? []).map((r) => `${r.from} => ${r.to}`).join("\n");
const textToRules = (text?: string) =>
  (text ?? "")
    .split("\n")
    .map((line) => line.split("=>"))
    .filter(([f]) => f?.trim())
    .map(([f, to]) => ({ from: f!.trim(), to: (to ?? "").trim() }));

/** 表单值 ↔ 店铺设置载荷（刊登模板与保存共用同一份转换）。 */
function formToPayload(v: SettingsForm): StoreSettingsPayload {
  return {
    vendor: v.vendor ?? "",
    aiEnhance: v.aiEnhance ?? true,
    language: v.language ?? "en",
    rules: {
      titlePrefix: v.titlePrefix?.trim() || undefined,
      titleSuffix: v.titleSuffix?.trim() || undefined,
      replacements: textToRules(v.replacementsText),
      priceMinCny: v.priceMinCny ?? null,
      priceMaxCny: v.priceMaxCny ?? null,
      maxImages: v.maxImages ?? null,
      bannedWords: v.bannedWords ?? [],
      publishStatus: v.publishStatus ?? "active",
      trackStock: v.trackStock ?? false,
      defaultTags: v.defaultTags ?? [],
      defaultProductType: v.defaultProductType?.trim() || undefined,
    },
    pricing: {
      exchangeRate: v.exchangeRate,
      markup: v.markup,
      priceEnding: v.endingOn ? (v.priceEnding ?? 0.99) : null,
      extraCostCny: v.extraCostCny ?? 0,
      minPrice: v.minPrice ?? null,
    },
  };
}

function payloadToForm(p: StoreSettingsPayload): SettingsForm {
  return {
    ...p.pricing,
    endingOn: p.pricing.priceEnding != null,
    vendor: p.vendor,
    aiEnhance: p.aiEnhance,
    language: p.language,
    titlePrefix: p.rules.titlePrefix,
    titleSuffix: p.rules.titleSuffix,
    replacementsText: rulesToText(p.rules.replacements),
    priceMinCny: p.rules.priceMinCny ?? undefined,
    priceMaxCny: p.rules.priceMaxCny ?? undefined,
    maxImages: p.rules.maxImages ?? undefined,
    bannedWords: p.rules.bannedWords ?? [],
    publishStatus: p.rules.publishStatus ?? "active",
    trackStock: p.rules.trackStock ?? false,
    defaultTags: p.rules.defaultTags ?? [],
    defaultProductType: p.rules.defaultProductType,
  };
}

function ListingSettingsModal({ store, onClose }: { store?: Store; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<SettingsForm>();
  useEffect(() => {
    if (store) {
      form.setFieldsValue(
        payloadToForm({
          pricing: store.pricing,
          vendor: store.vendor,
          aiEnhance: store.aiEnhance,
          language: store.language,
          rules: store.rules,
        }),
      );
    }
  }, [store, form]);
  const save = useMutation({
    mutationFn: (body: StoreSettingsPayload) => api.updateStore(store!.id, body),
    onSuccess: () => {
      message.success("已保存，对之后认领的商品生效");
      qc.invalidateQueries({ queryKey: ["stores"] });
      onClose();
    },
    onError: (e) => message.error(e.message),
  });
  const [tplId, setTplId] = useState<string>();
  // 切换店铺/关闭重开时清空选中，避免显示的模板与表单内容不符
  useEffect(() => setTplId(undefined), [store]);
  const tplQ = useQuery({ queryKey: ["templates"], queryFn: api.templates });
  const saveTpl = useMutation({
    mutationFn: api.saveTemplate,
    onSuccess: (res) => {
      message.success(`模板「${res.item.name}」已保存`);
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e) => message.error(e.message),
  });
  const delTpl = useMutation({
    mutationFn: api.deleteTemplate,
    onSuccess: () => {
      setTplId(undefined);
      qc.invalidateQueries({ queryKey: ["templates"] });
    },
    onError: (e) => message.error(e.message),
  });
  const watched = Form.useWatch([], form);
  const cur = store?.currency ?? "";
  return (
    <Modal
      title={`刊登设置 · ${store?.name ?? ""}`}
      open={!!store}
      onCancel={onClose}
      confirmLoading={save.isPending}
      onOk={async () => {
        const v = await form.validateFields();
        save.mutate(formToPayload(v));
      }}
    >
      <Space size={8} style={{ marginBottom: 8 }} wrap>
        <Select
          value={tplId}
          allowClear
          showSearch
          optionFilterProp="label"
          placeholder="套用刊登模板"
          style={{ minWidth: 200 }}
          options={(tplQ.data?.items ?? []).map((tpl) => ({ value: tpl.id, label: tpl.name }))}
          onChange={(id) => {
            setTplId(id);
            const tpl = tplQ.data?.items.find((x) => x.id === id);
            if (tpl) {
              form.setFieldsValue(payloadToForm(tpl.payload));
              message.success(`已套用「${tpl.name}」，确认保存后生效`);
            }
          }}
        />
        <Button
          onClick={() => {
            let name = "";
            Modal.confirm({
              title: "存为模板",
              content: (
                <Input
                  placeholder="模板名（同名覆盖）"
                  maxLength={100}
                  onChange={(e) => {
                    name = e.target.value;
                  }}
                />
              ),
              okText: "保存",
              cancelText: "取消",
              onOk: async () => {
                if (!name.trim()) throw new Error("模板名不能为空");
                const v = await form.validateFields();
                await saveTpl.mutateAsync({ name: name.trim(), payload: formToPayload(v) });
              },
            });
          }}
        >
          存为模板
        </Button>
        {tplId && (
          <Popconfirm title="删除该模板？" onConfirm={() => delTpl.mutate(tplId)}>
            <Button danger size="small" loading={delTpl.isPending}>
              删除模板
            </Button>
          </Popconfirm>
        )}
      </Space>
      <Form form={form} layout="vertical">
        <Typography.Title level={5}>定价</Typography.Title>
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item name="exchangeRate" label={`汇率（1 人民币 = ? ${cur}）`} rules={[{ required: true }]}>
            <InputNumber min={0.0001} step={0.01} style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="markup" label="加价倍数" rules={[{ required: true }]}>
            <InputNumber min={0.1} step={0.1} style={{ width: 120 }} />
          </Form.Item>
        </Space>
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item name="extraCostCny" label="固定费用 ¥（运费、包装等，先加到成本上）">
            <InputNumber min={0} step={1} style={{ width: 170 }} />
          </Form.Item>
          <Form.Item name="minPrice" label={`最低售价 ${cur}`}>
            <InputNumber min={0} step={1} placeholder="不限" style={{ width: 120 }} />
          </Form.Item>
        </Space>
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item name="endingOn" label="价格尾数">
            <Select
              style={{ width: 170 }}
              options={[
                { value: true, label: "统一尾数" },
                { value: false, label: "保留两位小数" },
              ]}
            />
          </Form.Item>
          {watched?.endingOn && (
            <Form.Item name="priceEnding" label="尾数">
              <InputNumber min={0} max={0.99} step={0.01} style={{ width: 120 }} />
            </Form.Item>
          )}
        </Space>
        <Typography.Paragraph type="secondary">
          示例：成本 ¥2 → {previewPrice(2, watched ?? {}) ?? "—"} {cur}；成本 ¥10 →{" "}
          {previewPrice(10, watched ?? {}) ?? "—"} {cur}；成本 ¥50 → {previewPrice(50, watched ?? {}) ?? "—"} {cur}
        </Typography.Paragraph>
        <Typography.Title level={5}>商品信息</Typography.Title>
        <Form.Item
          name="vendor"
          label="品牌（Vendor）"
          extra="显示在商品上的品牌名。留空则不填，不会使用 1688 供应商名。"
        >
          <Input placeholder="你的品牌名" maxLength={255} />
        </Form.Item>
        <Typography.Title level={5}>发布与默认项</Typography.Title>
        <Space size={12} style={{ display: "flex" }} wrap>
          <Form.Item
            name="publishStatus"
            label="发布后状态"
            extra="草稿适合先人工复查再在 Shopify 上架"
          >
            <Select
              style={{ width: 170 }}
              options={[
                { value: "active", label: "直接上架" },
                { value: "draft", label: "发布为草稿" },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="trackStock"
            label="库存"
            valuePropName="checked"
            extra="打开后按 1688 库存发布并追踪，售罄自动停售；关闭则不限量可售"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="defaultProductType" label="默认商品类型">
            <Input placeholder="如 Women's Clothing" style={{ width: 200 }} maxLength={255} />
          </Form.Item>
          <Form.Item name="defaultTags" label="默认标签（认领时填入）">
            <Select
              mode="tags"
              tokenSeparators={[",", "，"]}
              open={false}
              style={{ width: 260 }}
              placeholder="输入标签后回车"
            />
          </Form.Item>
        </Space>
        <Typography.Title level={5}>AI 产线</Typography.Title>
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item
            name="aiEnhance"
            label="认领后自动生成 AI 建议"
            extra="翻译标题/描述/选项、生成卖点描述，在刊登编辑页逐条审核"
            valuePropName="checked"
          >
            <Switch />
          </Form.Item>
          <Form.Item name="language" label="刊登语言" rules={[{ required: true }]}>
            <Select
              style={{ width: 170 }}
              options={[
                { value: "en", label: "English" },
                { value: "zh-CN", label: "简体中文" },
                { value: "zh-TW", label: "繁體中文" },
                { value: "ja", label: "日本語" },
                { value: "ko", label: "한국어" },
                { value: "de", label: "Deutsch" },
                { value: "fr", label: "Français" },
                { value: "es", label: "Español" },
                { value: "pt", label: "Português" },
                { value: "th", label: "ไทย" },
                { value: "vi", label: "Tiếng Việt" },
                { value: "id", label: "Bahasa Indonesia" },
              ]}
            />
          </Form.Item>
        </Space>
        <Typography.Title level={5}>采集预处理</Typography.Title>
        <Space size={12} style={{ display: "flex" }} wrap>
          <Form.Item name="titlePrefix" label="标题前缀">
            <Input placeholder="如 [Hot]" style={{ width: 150 }} maxLength={100} />
          </Form.Item>
          <Form.Item name="titleSuffix" label="标题后缀">
            <Input placeholder="如 Free Shipping" style={{ width: 150 }} maxLength={100} />
          </Form.Item>
          <Form.Item name="maxImages" label="图片数量上限">
            <InputNumber min={1} max={20} placeholder="20" style={{ width: 110 }} />
          </Form.Item>
        </Space>
        <Form.Item
          name="replacementsText"
          label="替换词（每行一条：旧词 => 新词；应用到标题与属性）"
        >
          <Input.TextArea
            rows={3}
            placeholder={"厂家直销 => \n【定制联系客服】 => "}
            style={{ fontFamily: "monospace" }}
          />
        </Form.Item>
        <Space size={12} style={{ display: "flex" }}>
          <Form.Item name="priceMinCny" label="成本价下限 ¥">
            <InputNumber min={0} step={1} placeholder="不限" style={{ width: 120 }} />
          </Form.Item>
          <Form.Item
            name="priceMaxCny"
            label="成本价上限 ¥"
            extra="区间外的 SKU 不生成变体；全部在区间外则不建刊登"
          >
            <InputNumber min={0} step={1} placeholder="不限" style={{ width: 120 }} />
          </Form.Item>
        </Space>
        <Typography.Title level={5}>发布前检查</Typography.Title>
        <Form.Item
          name="bannedWords"
          label="禁售词（品牌词 / 敏感词 / 平台禁售词）"
          extra="标题、描述、标签、选项命中任一词时拦截发布，回车添加"
        >
          <Select mode="tags" tokenSeparators={[",", "，"]} open={false} placeholder="输入词后回车" />
        </Form.Item>
      </Form>
    </Modal>
  );
}

export function StoresPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [params, setParams] = useSearchParams();
  const [connectOpen, setConnectOpen] = useState(false);
  const [settingsStore, setSettingsStore] = useState<Store>();
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
  const syncCategories = useMutation({
    mutationFn: api.syncStoreCategories,
    onSuccess: () => message.success("已排队同步类目树"),
    onError: (e) => message.error(e.message),
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
            title: "定价 / 品牌",
            width: 220,
            render: (_, s) => {
              const p = s.pricing;
              const parts = [
                `(成本${p.extraCostCny ? `+¥${p.extraCostCny}` : ""}) ×${p.exchangeRate} ×${p.markup}`,
                p.minPrice ? `最低 ${p.minPrice}` : null,
                p.priceEnding != null ? `尾数 ${p.priceEnding}` : null,
              ].filter(Boolean);
              return (
                <Space direction="vertical" size={0}>
                  <span>{parts.join(" · ")}</span>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    品牌：{s.vendor || "未设置"}
                  </Typography.Text>
                </Space>
              );
            },
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
            width: 290,
            render: (_, s) => (
              <Space>
                <a onClick={() => setSettingsStore(s)}>刊登设置</a>
                <a onClick={() => verify.mutate(s.id)}>检测连接</a>
                <a onClick={() => syncCategories.mutate(s.id)}>同步类目</a>
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
      <ListingSettingsModal store={settingsStore} onClose={() => setSettingsStore(undefined)} />
    </Card>
  );
}
