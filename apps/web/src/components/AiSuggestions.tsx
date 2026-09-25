import type {
  Listing,
  ListingSuggestion,
  ListingVariant,
  OptionsSuggestionValue,
  SuggestionField,
} from "@caiji/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Col, Row, Space, Spin, Table, Tag, Typography } from "antd";
import { api } from "../api";

type DraftPatch = Partial<
  Pick<Listing, "title" | "descriptionHtml" | "productType" | "tags" | "options" | "variants">
>;

const FIELD_LABEL: Record<SuggestionField, string> = {
  title: "标题",
  descriptionHtml: "描述",
  productType: "商品类型",
  tags: "标签",
  options: "变体选项",
};

const cellStyle: React.CSSProperties = {
  background: "#fafafa",
  borderRadius: 6,
  padding: "8px 12px",
  maxHeight: 220,
  overflow: "auto",
};
const newCellStyle: React.CSSProperties = { ...cellStyle, background: "#f6ffed" };

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
  return <Typography.Text>{String(value)}</Typography.Text>;
}

function CurrentView({ field, listing }: { field: SuggestionField; listing: Listing }) {
  const value =
    field === "options"
      ? ({ options: listing.options, variantOptionValues: [] } as OptionsSuggestionValue)
      : listing[field];
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
    mutationFn: (decisions: Array<{ id: string; action: "accept" | "reject" }>) =>
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
              <Button
                size="small"
                type="primary"
                onClick={() => decide.mutate([{ id: s.id, action: "accept" }])}
              >
                接受
              </Button>
              <Button
                size="small"
                onClick={() => decide.mutate([{ id: s.id, action: "reject" }])}
              >
                回退
              </Button>
            </Space>
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
