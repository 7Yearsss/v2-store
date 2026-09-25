import type { Listing, ListingVariant } from "@caiji/shared";
import { DeleteOutlined } from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Form,
  Image,
  Input,
  InputNumber,
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
import { api } from "../api";
import { acceptedPatch, AiSuggestionsCard } from "../components/AiSuggestions";
import { REMOTE, STATUS } from "./Listings";

type Editable = Pick<
  Listing,
  "title" | "descriptionHtml" | "images" | "options" | "variants" | "tags" | "productType" | "vendor"
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

  if (!listing || !draft) {
    return query.isError ? <Alert type="error" message={query.error.message} /> : <Spin />;
  }

  const set = (patch: Partial<Editable>) => setDraft((d) => ({ ...d!, ...patch }));
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

      <Card title={`图片（${draft.images.length}）`} extra={<Typography.Text type="secondary">第一张为主图</Typography.Text>}>
        <Image.PreviewGroup>
          <Space wrap>
            {draft.images.map((src, i) => (
              <div key={src} style={{ position: "relative" }}>
                <Image src={src} width={110} height={110} style={{ objectFit: "cover", borderRadius: 6 }} />
                {!locked && (
                  <Button
                    size="small"
                    danger
                    icon={<DeleteOutlined />}
                    style={{ position: "absolute", top: 4, right: 4 }}
                    onClick={() => set({ images: draft.images.filter((_, j) => j !== i) })}
                  />
                )}
              </div>
            ))}
          </Space>
        </Image.PreviewGroup>
      </Card>

      <Card
        title={`变体（${draft.variants.length}）`}
        extra={
          draft.options.length ? (
            <Space>
              {draft.options.map((o) => (
                <Tag key={o.name}>
                  {o.name}：{o.values.length} 个值
                </Tag>
              ))}
            </Space>
          ) : null
        }
      >
        <Table<ListingVariant>
          size="small"
          rowKey={(_, i) => String(i)}
          dataSource={draft.variants}
          pagination={draft.variants.length > 50 ? { pageSize: 50 } : false}
          columns={[
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

      <Space>
        <Button disabled={!dirty || locked} loading={save.isPending && !save.variables} onClick={() => save.mutate(false)}>
          保存
        </Button>
        <Button type="primary" disabled={locked} loading={save.isPending && save.variables} onClick={() => save.mutate(true)}>
          {listing.status === "published" ? "保存并同步到店铺" : "保存并发布"}
        </Button>
        <Link to={`/collect-box`}>
          <Typography.Text type="secondary">来源：采集箱</Typography.Text>
        </Link>
      </Space>
    </Space>
  );
}
