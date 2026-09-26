import type {
  AttributesSuggestionValue,
  CategorySuggestionValue,
  Listing,
  ListingChannelAttribute,
  ListingSuggestion,
  ListingVariant,
  OptionsSuggestionValue,
  SuggestionField,
} from "@caiji/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Col, Row, Space, Spin, Table, Tag, Typography } from "antd";
import { api } from "../api";

type DraftPatch = Partial<
  Pick<
    Listing,
    | "title"
    | "descriptionHtml"
    | "productType"
    | "tags"
    | "options"
    | "variants"
    | "channelAttributes"
  >
>;

const FIELD_LABEL: Record<SuggestionField, string> = {
  title: "标题",
  descriptionHtml: "描述",
  productType: "商品类型",
  tags: "标签",
  options: "变体选项",
  category: "类目",
  attributes: "平台属性",
};

const cellStyle: React.CSSProperties = {
  background: "var(--surface-2)",
  borderRadius: 6,
  padding: "8px 12px",
  maxHeight: 220,
  overflow: "auto",
};
const newCellStyle: React.CSSProperties = { ...cellStyle, background: "rgba(63,182,139,0.12)" };

function OptionsView({ options }: { options: { name: string; values: string[] }[] }) {
  return (
    <Table
      size="small"
      rowKey="name"
      dataSource={options}
      pagination={false}
      columns={[
        { title: "选项", dataIndex: "name", width: 110 },
        {
          title: "值",
          render: (_, o) => o.values.join(" / "),
        },
      ]}
    />
  );
}

/** 平台属性：提案为 {sourceName,sourceValue} → attrName=value 映射行。 */
function AttributesView({ value }: { value: AttributesSuggestionValue }) {
  return (
    <Table
      size="small"
      rowKey={(r) => `${r.attrId}:${r.sourceName}`}
      dataSource={value.attributes}
      pagination={false}
      columns={[
        {
          title: "来源",
          width: 130,
          render: (_, a) =>
            a.sourceName ? `${a.sourceName}：${a.sourceValue}` : "（新增）",
        },
        { title: "平台属性", dataIndex: "attrName", width: 120 },
        { title: "值", dataIndex: "value" },
      ]}
    />
  );
}

function ChannelAttrsTable({ items }: { items: ListingChannelAttribute[] }) {
  return (
    <Table
      size="small"
      rowKey="attrId"
      dataSource={items}
      pagination={false}
      columns={[
        { title: "平台属性", dataIndex: "name", width: 120 },
        { title: "值", dataIndex: "value" },
      ]}
    />
  );
}

function ValueView({ field, value }: { field: SuggestionField; value: unknown }) {
  if (field === "descriptionHtml") {
    return <div dangerouslySetInnerHTML={{ __html: String(value) }} />;
  }
  if (field === "tags") {
    return (
      <Space wrap size={4}>
        {(value as string[]).map((t) => (
          <Tag key={t}>{t}</Tag>
        ))}
      </Space>
    );
  }
  if (field === "options") {
    return <OptionsView options={(value as OptionsSuggestionValue).options} />;
  }
  if (field === "attributes") {
    return <AttributesView value={value as AttributesSuggestionValue} />;
  }
  return <Typography.Text>{String(value)}</Typography.Text>;
}

function CurrentView({ field, listing }: { field: SuggestionField; listing: Listing }) {
  const value =
    field === "options"
      ? ({ options: listing.options, variantOptionValues: [] } as OptionsSuggestionValue)
      : field === "category"
        ? listing.channelCategoryName
        : field === "attributes"
          ? listing.channelAttributes
          : listing[field];
  if (field === "attributes") return <ChannelAttrsTable items={value as ListingChannelAttribute[]} />;
  return <ValueView field={field} value={value} />;
}

/** Suggestion value → the draft fields it touches when accepted. */
export function acceptedPatch(s: ListingSuggestion, variants: ListingVariant[]): DraftPatch {
  switch (s.field) {
    case "title":
      return { title: String(s.value) };
    case "descriptionHtml":
      return { descriptionHtml: String(s.value) };
    case "productType":
      return { productType: String(s.value) };
    case "tags":
      return { tags: s.value as string[] };
    case "options": {
      const v = s.value as OptionsSuggestionValue;
      return {
        options: v.options,
        variants: variants.map((vr, i) => ({
          ...vr,
          optionValues: v.variantOptionValues[i] ?? vr.optionValues,
        })),
      };
    }
    case "attributes": {
      const v = s.value as AttributesSuggestionValue;
      return {
        channelAttributes: v.attributes.map((a) => ({
          attrId: a.attrId,
          name: a.attrName,
          value: a.value,
        })),
      };
    }
    default:
      return {};
  }
}

export function AiSuggestionsCard({
  listing,
  onAccepted,
}: {
  listing: Listing;
  /** Notified after a suggestion is accepted (server已落库); page merges it into the draft. */
  onAccepted: (s: ListingSuggestion) => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["suggestions", listing.id],
    queryFn: () => api.listingSuggestions(listing.id),
    refetchInterval: (q) => (q.state.data?.pending ? 3000 : false),
  });

  const decide = useMutation({
    mutationFn: (
      decisions: Array<{ id: string; action: "accept" | "reject"; choice?: string }>,
    ) =>
      api.decideSuggestions(listing.id, decisions),
    onSuccess: (_r, decisions) => {
      for (const d of decisions) {
        const s = query.data?.items.find((i) => i.id === d.id);
        if (s && d.action === "accept") onAccepted(s);
      }
      qc.invalidateQueries({ queryKey: ["suggestions", listing.id] });
      qc.invalidateQueries({ queryKey: ["listings", "one", listing.id] });
    },
    onError: (e) => message.error(e.message),
  });
  const regenerate = useMutation({
    mutationFn: () => api.aiEnhance(listing.id),
    onSuccess: (r) => {
      if (!r.queued) message.info("已有 AI 任务在队列中");
      qc.invalidateQueries({ queryKey: ["suggestions", listing.id] });
    },
    onError: (e) => message.error(e.message),
  });

  const data = query.data;
  const pending = data?.items.filter((i) => i.status === "pending") ?? [];
  const decidedCount = (data?.items.length ?? 0) - pending.length;
  if (!data || (!pending.length && !decidedCount && !data.pending)) return null;

  return (
    <Card
      title="AI 建议"
      extra={
        <Space>
          {data.pending && (
            <Typography.Text type="secondary">
              <Spin size="small" /> 生成中…
            </Typography.Text>
          )}
          {pending.length > 1 && (
            <Button
              size="small"
              onClick={() =>
                decide.mutate(pending.map((s) => ({ id: s.id, action: "accept" as const })))
              }
            >
              全部接受
            </Button>
          )}
          <Button size="small" loading={regenerate.isPending} onClick={() => regenerate.mutate()}>
            重新生成
          </Button>
        </Space>
      }
    >
      <Space direction="vertical" size={16} style={{ width: "100%" }}>
        {pending.map((s) => (
          <div key={s.id}>
            <Space style={{ marginBottom: 8 }}>
              <Tag color="blue">{FIELD_LABEL[s.field]}</Tag>
              {s.field !== "category" && (
                <Button
                  size="small"
                  type="primary"
                  onClick={() => decide.mutate([{ id: s.id, action: "accept" }])}
                >
                  接受
                </Button>
              )}
              <Button
                size="small"
                onClick={() => decide.mutate([{ id: s.id, action: "reject" }])}
              >
                回退
              </Button>
            </Space>
            {s.field === "category" ? (
              <CategoryView
                value={s.value as CategorySuggestionValue}
                current={listing.channelCategoryName}
                busy={decide.isPending}
                onPick={(choice) =>
                  decide.mutate([{ id: s.id, action: "accept", choice }])
                }
              />
            ) : (
            <Row gutter={12}>
              <Col span={12}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  当前
                </Typography.Text>
                <div style={cellStyle}>
                  <CurrentView field={s.field} listing={listing} />
                </div>
              </Col>
              <Col span={12}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  AI 建议
                </Typography.Text>
                <div style={newCellStyle}>
                  <ValueView field={s.field} value={s.value} />
                  {s.field === "options" && (
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                      接受后所有变体的选项值会一并翻译
                    </Typography.Text>
                  )}
                </div>
              </Col>
            </Row>
            )}
          </div>
        ))}
        {decidedCount > 0 && (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            已处理 {decidedCount} 条建议
          </Typography.Text>
        )}
      </Space>
    </Card>
  );
}

/** 类目建议：来源类目 + 平台候选，每个候选单独的“用此类目”按钮（确认后记住映射）。 */
function CategoryView({
  value,
  current,
  busy,
  onPick,
}: {
  value: CategorySuggestionValue;
  current: string | null;
  busy: boolean;
  onPick: (choice: string) => void;
}) {
  return (
    <div style={cellStyle}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
        来源类目：{value.sourceCategoryName ?? value.sourceCategoryId ?? "未知"}
        {current ? `　当前：${current}` : "　当前：未映射"}
      </Typography.Text>
      <Space direction="vertical" size={6} style={{ width: "100%" }}>
        {value.candidates.map((cd, i) => (
          <Space key={cd.id} style={{ display: "flex", justifyContent: "space-between", width: "100%" }}>
            <Typography.Text>
              {i + 1}. {cd.fullName || cd.name}
              {cd.confidence != null && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {"　"}置信度 {cd.confidence}
                </Typography.Text>
              )}
            </Typography.Text>
            <Button size="small" type="primary" ghost disabled={busy} onClick={() => onPick(cd.id)}>
              用此类目
            </Button>
          </Space>
        ))}
      </Space>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
        确认后同来源类目自动套用此映射（可在“类目映射”页删除）
      </Typography.Text>
    </div>
  );
}
