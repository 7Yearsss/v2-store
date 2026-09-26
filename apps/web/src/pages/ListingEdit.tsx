import type { CategoryCandidate, Listing, ListingStatus, ListingVariant, RemoteStatus } from "@caiji/shared";
import { DeleteOutlined, HighlightOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Descriptions,
  Form,
  Image,
  Input,
  InputNumber,
  Modal,
  Row,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, type PublishPreview } from "../api";
import { acceptedPatch, AiSuggestionsCard } from "../components/AiSuggestions";

const STATUS: Record<ListingStatus, { label: string; color: string }> = {
  draft: { label: "草稿", color: "default" },
  publishing: { label: "发布中", color: "processing" },
  published: { label: "已发布", color: "success" },
  failed: { label: "发布失败", color: "error" },
};

const REMOTE: Record<RemoteStatus, { label: string; color: string }> = {
  ACTIVE: { label: "在售", color: "green" },
  DRAFT: { label: "草稿", color: "default" },
  ARCHIVED: { label: "已归档", color: "default" },
  UNLISTED: { label: "不公开", color: "default" },
  DELETED: { label: "已删除", color: "red" },
};

type PreviewVariant = NonNullable<PublishPreview["product"]>["variants"][number];

type Editable = Pick<
  Listing,
  | "title"
  | "descriptionHtml"
  | "images"
  | "options"
  | "variants"
  | "tags"
  | "productType"
  | "vendor"
  | "weightKg"
>;

const pickEditable = (l: Listing): Editable => ({
  title: l.title,
  descriptionHtml: l.descriptionHtml,
  images: l.images,
  options: l.options,
  variants: l.variants,
  tags: l.tags,
  productType: l.productType,
  vendor: l.vendor,
  weightKg: l.weightKg,
});

export function ListingEditPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const { message } = App.useApp();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["listings", "one", id],
    queryFn: () => api.listing(id),
    refetchInterval: (q) => (q.state.data?.status === "publishing" ? 2000 : false),
  });
  const stores = useQuery({ queryKey: ["stores"], queryFn: api.stores });
  const [draft, setDraft] = useState<Editable>();
  const [catOptions, setCatOptions] = useState<CategoryCandidate[]>([]);
  const [vsel, setVsel] = useState<number[]>([]);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<PublishPreview>();
  const [bulk, setBulk] = useState<{ field: "price" | "compareAtPrice"; op: "set" | "add" | "sub" | "mul" } | null>(null);
  const [bulkValue, setBulkValue] = useState<number | null>(null);
  /** AI 图片任务：pending=已入队数，merged=已合并进草稿的图数 */
  const [imgJobs, setImgJobs] = useState({ pending: 0, merged: 0 });

  const listing = query.data;
  // (re)initialize the editor when the server copy changes and we have no local edits
  const serverJson = listing ? JSON.stringify(pickEditable(listing)) : "";
  const [baseline, setBaseline] = useState("");
  useEffect(() => {
    if (!listing) return;
    if (!draft || JSON.stringify(draft) === baseline) {
      setDraft(pickEditable(listing));
      setBaseline(serverJson);
    }
  }, [serverJson]); // eslint-disable-line react-hooks/exhaustive-deps

  const dirty = draft && JSON.stringify(draft) !== baseline;

  /** AI 图片任务在跑时轮询刊登，把新生成的图合并进本地草稿（不丢用户未保存的编辑）。 */
  useEffect(() => {
    if (imgJobs.pending <= imgJobs.merged) return;
    const t = window.setInterval(
      () => qc.invalidateQueries({ queryKey: ["listings", "one", id] }),
      3000,
    );
    const giveUp = window.setTimeout(() => setImgJobs((j) => ({ ...j, pending: j.merged })), 180_000);
    return () => {
      window.clearInterval(t);
      window.clearTimeout(giveUp);
    };
  }, [imgJobs, id, qc]);
  useEffect(() => {
    if (!listing || !draft || imgJobs.pending <= imgJobs.merged) return;
    const oldBaselineImgs: string[] = baseline ? (JSON.parse(baseline) as Editable).images : [];
    const missing = listing.images.filter((u) => !oldBaselineImgs.includes(u));
    if (!missing.length) return;
    const oldBaselineSet = new Set(oldBaselineImgs);
    // 按服务端顺序合并：新图（旧基线里没有）保留，用户本地删掉的旧图不复活
    setDraft((d) => ({
      ...d!,
      images: listing.images.filter((u) => !oldBaselineSet.has(u) || d!.images.includes(u)),
    }));
    setBaseline(JSON.stringify(pickEditable(listing)));
    setImgJobs((j) => ({ ...j, merged: j.merged + missing.length }));
    message.success("AI 图片已生成并加入图片区");
  }, [listing, draft, imgJobs, baseline, message]);

  const save = useMutation({
    mutationFn: async (andPublish: boolean) => {
      let saved = listing!;
      if (dirty) saved = await api.updateListing(id, draft!);
      const pub = andPublish ? await api.publish([id]) : null;
      return { saved, andPublish, blocked: pub?.blocked?.[0] };
    },
    onSuccess: ({ saved, andPublish, blocked }) => {
      setDraft(pickEditable(saved));
      setBaseline(JSON.stringify(pickEditable(saved)));
      if (blocked) {
        message.warning(`已保存，但被发布前检查拦截：含禁售词 ${blocked.words.join("、")}`, 8);
      } else {
        message.success(andPublish ? "已提交发布" : "已保存");
      }
      qc.invalidateQueries({ queryKey: ["listings"] });
    },
    onError: (e) => message.error(e.message),
  });

  /** 手动改类目：写刊登 + 记住映射（服务端默认 remember=true）。 */
  const setCat = useMutation({
    mutationFn: (body: { channelCategoryId: string; channelCategoryName: string }) =>
      api.setListingCategory(id, body),
    onSuccess: (l) => {
      message.success("类目已更新并记住映射");
      qc.setQueryData(["listings", "one", id], l);
      qc.invalidateQueries({ queryKey: ["listings"] });
    },
    onError: (e) => message.error(e.message),
  });

  if (!listing || !draft) {
    return query.isError ? <Alert type="error" message={query.error.message} /> : <Spin />;
  }

  const aiImage = useMutation({
    mutationFn: (imageIndex: number) => api.aiImage(id, imageIndex),
    onSuccess: (r) => {
      if (r.queued) {
        setImgJobs((j) => ({ ...j, pending: j.pending + 1 }));
        message.info("AI 白底图已加入任务，完成后自动出现在图片区（约 30–90 秒）");
      } else {
        message.info("该图的 AI 任务已在队列中");
      }
    },
    onError: (e) => message.error(e.message),
  });

  const set = (patch: Partial<Editable>) => setDraft((d) => ({ ...d!, ...patch }));
  const openPreview = async () => {
    if (dirty) {
      const saved = await api.updateListing(id, draft!);
      setDraft(pickEditable(saved));
      setBaseline(JSON.stringify(pickEditable(saved)));
    }
    setPreview(await api.publishPreview(id));
    setPreviewOpen(true);
  };
  const applyBulk = () => {
    if (!bulk || bulkValue == null || !draft) return;
    const calc = (cur: number | undefined) => {
      const c = cur ?? 0;
      const v =
        bulk.op === "set" ? bulkValue : bulk.op === "add" ? c + bulkValue : bulk.op === "sub" ? c - bulkValue : c * bulkValue;
      return Math.max(0, Math.round(v * 100) / 100);
    };
    setDraft({
      ...draft,
      variants: draft.variants.map((v, i) => (vsel.includes(i) ? { ...v, [bulk.field]: calc(v[bulk.field]) } : v)),
    });
    setBulk(null);
    setBulkValue(null);
  };

  const setVariant = (i: number, patch: Partial<ListingVariant>) =>
    set({ variants: draft.variants.map((v, j) => (j === i ? { ...v, ...patch } : v)) });
  const store = stores.data?.find((s) => s.id === listing.storeId);
  const locked = listing.status === "publishing";

  return (
    <Space direction="vertical" size={16} style={{ width: "100%" }}>
      <Space>
        <Button onClick={() => navigate("/listings")}>← 返回</Button>
        <Tag color={STATUS[listing.status].color}>{STATUS[listing.status].label}</Tag>
        {listing.remoteStatus && (
          <Tag color={REMOTE[listing.remoteStatus].color}>店铺：{REMOTE[listing.remoteStatus].label}</Tag>
        )}
        <Typography.Text type="secondary">
          {store ? `${store.name}（${store.currency ?? ""}）` : ""}
        </Typography.Text>
        <Select
          size="small"
          showSearch
          allowClear
          placeholder="类目：未映射"
          status={listing.channelCategoryId ? undefined : "warning"}
          style={{ minWidth: 280 }}
          value={listing.channelCategoryName}
          filterOption={false}
          onSearch={(q) =>
            api.storeCategories(listing.storeId, q).then((r) => setCatOptions(r.items))
          }
          onFocus={() =>
            api.storeCategories(listing.storeId, "").then((r) => setCatOptions(r.items))
          }
          options={catOptions.map((cd) => ({
            value: cd.id,
            label: cd.fullName || cd.name,
          }))}
          onChange={(v, opt) => {
            if (!v || Array.isArray(opt)) return;
            setCat.mutate({
              channelCategoryId: String(v),
              channelCategoryName: String((opt as { label?: string }).label ?? v),
            });
          }}
          notFoundContent={<Typography.Text type="secondary">输入关键词搜索平台类目</Typography.Text>}
        />
        {listing.remoteUrl && (
          <a href={listing.remoteUrl} target="_blank" rel="noreferrer">
            在 Shopify 后台查看
          </a>
        )}
      </Space>
      {listing.status === "failed" && listing.lastError && (
        <Alert type="error" showIcon message="发布失败" description={listing.lastError} />
      )}
      {listing.status === "published" && listing.lastError && (
        <Alert type="warning" showIcon message="已发布，但有需要处理的问题" description={listing.lastError} />
      )}
      {listing.remoteStatus === "DELETED" && (
        <Alert type="warning" showIcon message="该商品已在店铺中被删除，再次发布会新建一个商品" />
      )}

      <AiSuggestionsCard
        listing={listing}
        onAccepted={(s) => setDraft((d) => ({ ...d!, ...acceptedPatch(s, d!.variants) }))}
      />

      <Card title="基本信息">
        <Form layout="vertical" disabled={locked}>
          <Form.Item label={`标题（${draft.title.length}/255）`} required>
            <Input value={draft.title} maxLength={255} onChange={(e) => set({ title: e.target.value })} />
          </Form.Item>
          <Row gutter={16}>
            <Col span={8}>
              <Form.Item label="品牌 / Vendor">
                <Input value={draft.vendor} onChange={(e) => set({ vendor: e.target.value })} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="商品类型 / Product type">
                <Input value={draft.productType} onChange={(e) => set({ productType: e.target.value })} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="重量（kg，发布写入变体 weight）">
                <InputNumber
                  min={0}
                  step={0.01}
                  style={{ width: "100%" }}
                  value={draft.weightKg ?? undefined}
                  onChange={(v) => set({ weightKg: v ?? null })}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item label="标签">
                <Select mode="tags" value={draft.tags} onChange={(tags) => set({ tags })} tokenSeparators={[","]} />
              </Form.Item>
            </Col>
          </Row>
          <Form.Item label="描述（HTML）">
            <Input.TextArea
              rows={6}
              value={draft.descriptionHtml}
              onChange={(e) => set({ descriptionHtml: e.target.value })}
            />
          </Form.Item>
        </Form>
      </Card>

      <Card
        title={`图片（${draft.images.length}）`}
        extra={
          <Typography.Text type="secondary">
            第一张为主图 · 点图下「AI 白底」生成白底版图
          </Typography.Text>
        }
      >
        <Image.PreviewGroup>
          <Space wrap>
            {draft.images.map((src, i) => (
              <div key={src} style={{ position: "relative" }}>
                <Image src={src} width={110} height={110} style={{ objectFit: "cover", borderRadius: 6 }} />
                {!locked && (
                  <>
                    <Button
                      size="small"
                      danger
                      icon={<DeleteOutlined />}
                      style={{ position: "absolute", top: 4, right: 4 }}
                      onClick={() => set({ images: draft.images.filter((_, j) => j !== i) })}
                    />
                    <Button
                      size="small"
                      icon={<HighlightOutlined />}
                      loading={aiImage.isPending && aiImage.variables === i}
                      style={{ position: "absolute", bottom: 4, right: 4, fontSize: 11 }}
                      onClick={() => aiImage.mutate(i)}
                    >
                      白底
                    </Button>
                  </>
                )}
              </div>
            ))}
          </Space>
        </Image.PreviewGroup>
      </Card>

      {!!listing?.descImages?.length && (
        <Card
          title={`详情图（${listing.descImages.length}）`}
          extra={<Typography.Text type="secondary">发布时追加到描述末尾</Typography.Text>}
        >
          <Image.PreviewGroup>
            <Space wrap>
              {listing.descImages.map((src) => (
                <Image key={src} src={src} width={110} style={{ borderRadius: 6 }} />
              ))}
            </Space>
          </Image.PreviewGroup>
        </Card>
      )}

      <Card
        title={`变体（${draft.variants.length}）`}
        extra={
          <Space>
            {draft.options.map((o) => (
              <Tag key={o.name}>
                {o.name}：{o.values.length} 个值
              </Tag>
            ))}
            <Button
              size="small"
              disabled={locked || !vsel.length}
              onClick={() => setBulk({ field: "price", op: "set" })}
            >
              批量修改{vsel.length ? `（${vsel.length}）` : ""}
            </Button>
          </Space>
        }
      >
        <Table<ListingVariant>
          size="small"
          rowKey={(_, i) => String(i)}
          dataSource={draft.variants}
          rowSelection={{
            selectedRowKeys: vsel.map(String),
            onChange: (k) => setVsel(k.map(Number)),
          }}
          pagination={draft.variants.length > 50 ? { pageSize: 50 } : false}
          columns={[
            {
              title: "图",
              width: 56,
              render: (_, v: ListingVariant) =>
                v.image ? (
                  <Image src={v.image} fallback="/placeholder.svg" width={40} height={40} style={{ objectFit: "cover" }} />
                ) : (
                  "—"
                ),
            },
            ...draft.options.map((o, idx) => ({
              title: o.name,
              render: (_: unknown, v: ListingVariant) => v.optionValues[idx],
            })),
            {
              title: "SKU",
              width: 180,
              render: (_, v, i) => (
                <Input size="small" disabled={locked} value={v.sku} onChange={(e) => setVariant(i, { sku: e.target.value })} />
              ),
            },
            { title: "成本 ¥", width: 90, render: (_, v) => v.costCny ?? "—" },
            {
              title: `售价 ${store?.currency ?? ""}`,
              width: 130,
              render: (_, v, i) => (
                <InputNumber
                  size="small"
                  min={0}
                  step={0.01}
                  disabled={locked}
                  status={v.price > 0 ? undefined : "error"}
                  value={v.price}
                  onChange={(p) => setVariant(i, { price: Number(p ?? 0) })}
                />
              ),
            },
            {
              title: "划线价",
              width: 130,
              render: (_, v, i) => (
                <InputNumber
                  size="small"
                  min={0}
                  step={0.01}
                  disabled={locked}
                  value={v.compareAtPrice}
                  onChange={(p) => setVariant(i, { compareAtPrice: p ?? undefined })}
                />
              ),
            },
            { title: "货源库存", width: 90, render: (_, v) => v.stock ?? "—" },
          ]}
        />
      </Card>

      <div
        style={{
          position: "sticky",
          bottom: 0,
          zIndex: 10,
          marginTop: -8,
          padding: "12px 16px",
          background: "rgba(11,12,14,0.92)",
          backdropFilter: "blur(8px)",
          borderTop: "1px solid var(--border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Button disabled={!dirty || locked} loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>
          保存
        </Button>
        <Button disabled={locked} onClick={() => openPreview().catch((e) => message.error(e.message))}>
          发布预览
        </Button>
        <Button type="primary" disabled={locked} loading={save.isPending && save.variables} onClick={() => save.mutate(true)}>
          {listing.status === "published" ? "保存并同步到店铺" : "保存并发布"}
        </Button>
        {dirty && (
          <Typography.Text type="warning" style={{ fontSize: 12 }}>
            有未保存的修改
          </Typography.Text>
        )}
        <Link to={`/`} style={{ marginLeft: "auto" }}>
          <Typography.Text type="secondary">返回铺货工作台</Typography.Text>
        </Link>
      </div>

      <Modal
        title="发布预览"
        open={previewOpen}
        onCancel={() => setPreviewOpen(false)}
        footer={
          <Space>
            <Button onClick={() => setPreviewOpen(false)}>关闭</Button>
            <Button
              type="primary"
              disabled={locked || !!preview?.warnings.some((w) => w.includes("拦截") || w.includes("不含"))}
              onClick={() => {
                setPreviewOpen(false);
                save.mutate(true);
              }}
            >
              发布
            </Button>
          </Space>
        }
        width={720}
      >
        {!preview ? (
          <Spin />
        ) : (
          <Space direction="vertical" size={12} style={{ width: "100%" }}>
            {preview.warnings.map((w) => (
              <Alert key={w} type="warning" showIcon message={w} />
            ))}
            {preview.product && (
              <>
                <Descriptions size="small" column={2} bordered>
                  <Descriptions.Item label="标题" span={2}>{preview.product.title}</Descriptions.Item>
                  <Descriptions.Item label="店铺状态">{preview.product.status}</Descriptions.Item>
                  <Descriptions.Item label="库存">{preview.product.trackStock ? "同步货源库存" : "不追踪（无限可售）"}</Descriptions.Item>
                  <Descriptions.Item label="类目">{preview.product.categoryName || "未映射"}</Descriptions.Item>
                  <Descriptions.Item label="品牌">{preview.product.vendor || "—"}</Descriptions.Item>
                  <Descriptions.Item label="类型">{preview.product.productType || "—"}</Descriptions.Item>
                  <Descriptions.Item label="标签">{preview.product.tags.join("、") || "—"}</Descriptions.Item>
                  <Descriptions.Item label="图片">{preview.product.imageCount} 张（含详情图）</Descriptions.Item>
                  <Descriptions.Item label="SEO 标题" span={2}>{preview.product.seo.title}</Descriptions.Item>
                </Descriptions>
                {!!preview.product.attributes.length && (
                  <div>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>类目属性</Typography.Text>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                      {preview.product.attributes.map((a) => (
                        <Tag key={a.name}>{a.name}: {a.value}</Tag>
                      ))}
                    </div>
                  </div>
                )}
                <Table<PreviewVariant>
                  size="small"
                  rowKey={(_, i) => String(i)}
                  dataSource={preview.product.variants}
                  pagination={preview.product.variants.length > 20 ? { pageSize: 20 } : false}
                  columns={[
                    ...preview.product.options.map((o, i) => ({
                      title: o.name,
                      render: (_: unknown, v: PreviewVariant) => v.optionValues[i],
                    })),
                    { title: "SKU", dataIndex: "sku" },
                    { title: "售价", dataIndex: "price", width: 90 },
                    { title: "划线价", dataIndex: "compareAtPrice", width: 90 },
                    { title: "成本", dataIndex: "cost", width: 80 },
                  ]}
                />
              </>
            )}
          </Space>
        )}
      </Modal>

      <Modal
        title={`批量修改 ${vsel.length} 个变体`}
        open={!!bulk}
        onCancel={() => setBulk(null)}
        onOk={applyBulk}
        okText="应用"
        okButtonProps={{ disabled: bulkValue == null }}
      >
        <Space direction="vertical" style={{ width: "100%" }} size={12}>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>字段</Typography.Text>
            <Select
              style={{ width: "100%" }}
              value={bulk?.field}
              onChange={(f) => bulk && setBulk({ ...bulk, field: f })}
              options={[
                { value: "price", label: "售价" },
                { value: "compareAtPrice", label: "划线价" },
              ]}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>方式</Typography.Text>
            <Select
              style={{ width: "100%" }}
              value={bulk?.op}
              onChange={(op) => bulk && setBulk({ ...bulk, op })}
              options={[
                { value: "set", label: "统一设为" },
                { value: "add", label: "统一加上" },
                { value: "sub", label: "统一减去" },
                { value: "mul", label: "统一乘以" },
              ]}
            />
          </div>
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>数值</Typography.Text>
            <InputNumber
              style={{ width: "100%" }}
              min={bulk?.op === "mul" ? 0.01 : undefined}
              step={bulk?.op === "mul" ? 0.05 : 0.1}
              value={bulkValue}
              onChange={(v) => setBulkValue(v)}
              placeholder={bulk?.op === "mul" ? "例如 1.1 表示整体上调 10%" : "例如 9.99"}
            />
          </div>
        </Space>
      </Modal>
    </Space>
  );
}
