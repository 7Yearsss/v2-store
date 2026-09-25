import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Card,
  Form,
  Input,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { useState } from "react";
import { api } from "../api";

function CategoryMappingCard() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const query = useQuery({ queryKey: ["category-mappings"], queryFn: api.categoryMappings });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteCategoryMapping(id),
    onSuccess: () => {
      message.success("已删除，同来源类目会重新走 AI 建议");
      qc.invalidateQueries({ queryKey: ["category-mappings"] });
    },
    onError: (e) => message.error(e.message),
  });

  return (
    <Card title="类目映射">
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        认领时遇到未映射的来源类目，AI 会推荐平台候选，确认一条后同来源类目自动套用。
      </Typography.Paragraph>
      <Table
        rowKey="id"
        size="small"
        loading={query.isLoading}
        dataSource={query.data?.items ?? []}
        pagination={false}
        columns={[
          {
            title: "来源",
            render: (_, m) => (
              <>
                <Tag>{m.sourcePlatform}</Tag>
                {m.sourceCategoryName ?? m.sourceCategoryId}
              </>
            ),
          },
          {
            title: "平台类目",
            render: (_, m) => (
              <>
                <Tag color="blue">{m.channel}</Tag>
                {m.channelCategoryName}
              </>
            ),
          },
          {
            title: "确认方式",
            width: 110,
            render: (_, m) => (m.confirmedBy === "user" ? "用户确认" : "AI"),
          },
          {
            title: "操作",
            width: 90,
            render: (_, m) => (
              <Popconfirm title="删除该映射？" onConfirm={() => del.mutate(m.id)}>
                <Button size="small" danger loading={del.isPending}>
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Card>
  );
}

function TermMappingCard() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ lang: string; sourceText: string; targetText: string }>();
  const [langFilter, setLangFilter] = useState("");
  const query = useQuery({ queryKey: ["term-mappings"], queryFn: api.termMappings });
  const upsert = useMutation({
    mutationFn: api.upsertTermMapping,
    onSuccess: () => {
      form.resetFields(["sourceText", "targetText"]);
      qc.invalidateQueries({ queryKey: ["term-mappings"] });
    },
    onError: (e) => message.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteTermMapping(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["term-mappings"] }),
    onError: (e) => message.error(e.message),
  });
  const items = (query.data?.items ?? []).filter((m) => !langFilter || m.lang === langFilter);
  const langs = [...new Set((query.data?.items ?? []).map((m) => m.lang))].sort();

  return (
    <Card
      title="术语翻译映射"
      extra={
        <Form
          form={form}
          layout="inline"
          onFinish={(v) =>
            upsert.mutate({ lang: v.lang?.trim() ?? "", sourceText: v.sourceText, targetText: v.targetText })
          }
        >
          <Form.Item name="lang" style={{ marginBottom: 0 }} initialValue="en">
            <Input placeholder="语言" style={{ width: 70 }} />
          </Form.Item>
          <Form.Item name="sourceText" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
            <Input placeholder="源词" style={{ width: 140 }} />
          </Form.Item>
          <Form.Item name="targetText" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
            <Input placeholder="译文" style={{ width: 140 }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="small" loading={upsert.isPending}>
            添加
          </Button>
        </Form>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        认领时按刊登语言预翻变体选项名/值与商品属性；AI 选项建议被接受时自动学习词对。
        删除后该词回到待翻译状态。
      </Typography.Paragraph>
      <Space style={{ marginBottom: 8 }}>
        {langs.map((l) => (
          <Tag.CheckableTag key={l} checked={langFilter === l} onChange={(c) => setLangFilter(c ? l : "")}>
            {l || "（空语言）"}
          </Tag.CheckableTag>
        ))}
      </Space>
      <Table
        rowKey="id"
        size="small"
        loading={query.isLoading}
        dataSource={items}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        columns={[
          { title: "语言", width: 80, render: (_, m) => <Tag>{m.lang || "—"}</Tag> },
          { title: "源词", dataIndex: "sourceText" },
          { title: "译文", dataIndex: "targetText" },
          {
            title: "操作",
            width: 90,
            render: (_, m) => (
              <Popconfirm title="删除该映射？" onConfirm={() => del.mutate(m.id)}>
                <Button size="small" danger loading={del.isPending}>
                  删除
                </Button>
              </Popconfirm>
            ),
          },
        ]}
      />
    </Card>
  );
}

/** 映射管理：类目映射 + 术语翻译映射。 */
export function CategoryMappingsPage() {
  return (
    <Tabs
      defaultActiveKey="category"
      items={[
        { key: "category", label: "类目映射", children: <CategoryMappingCard /> },
        { key: "term", label: "术语翻译映射", children: <TermMappingCard /> },
      ]}
    />
  );
}
