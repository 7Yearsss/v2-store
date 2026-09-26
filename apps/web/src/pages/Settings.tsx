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
import { Link } from "react-router";
import { api } from "../api";
import { ExtensionBadge, useExtension } from "../components/ExtensionBadge";

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

function AttributeMappingCard() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{
    channel: string;
    sourceName: string;
    channelAttrName: string;
    channelAttrId: string;
  }>();
  const query = useQuery({ queryKey: ["attribute-mappings"], queryFn: () => api.attributeMappings() });
  const upsert = useMutation({
    mutationFn: api.upsertAttributeMapping,
    onSuccess: () => {
      form.resetFields(["sourceName", "channelAttrName", "channelAttrId"]);
      qc.invalidateQueries({ queryKey: ["attribute-mappings"] });
    },
    onError: (e) => message.error(e.message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteAttributeMapping(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["attribute-mappings"] }),
    onError: (e) => message.error(e.message),
  });

  return (
    <Card
      title="属性映射"
      extra={
        <Form
          form={form}
          layout="inline"
          onFinish={(v) =>
            upsert.mutate({
              channel: v.channel,
              sourceName: v.sourceName,
              channelAttrName: v.channelAttrName,
              channelAttrId: v.channelAttrId,
            })
          }
        >
          <Form.Item name="channel" initialValue="shopify" style={{ marginBottom: 0 }}>
            <Input placeholder="平台" style={{ width: 90 }} disabled />
          </Form.Item>
          <Form.Item name="sourceName" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
            <Input placeholder="来源属性名（如 材质）" style={{ width: 150 }} />
          </Form.Item>
          <Form.Item name="channelAttrName" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
            <Input placeholder="平台属性名（如 Material）" style={{ width: 160 }} />
          </Form.Item>
          <Form.Item name="channelAttrId" rules={[{ required: true }]} style={{ marginBottom: 0 }}>
            <Input placeholder="平台属性 ID" style={{ width: 240 }} />
          </Form.Item>
          <Button type="primary" htmlType="submit" size="small" loading={upsert.isPending}>
            添加
          </Button>
        </Form>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
        来源属性名 → 平台类目标准属性。认领时自动套用进刊登；接受 AI
        属性建议时也会自动学习同名映射。属性 ID 可在店铺 → 类目属性接口或刊登编辑页 AI
        建议里查到。
      </Typography.Paragraph>
      <Table
        rowKey="id"
        size="small"
        loading={query.isLoading}
        dataSource={query.data?.items ?? []}
        pagination={{ pageSize: 50, hideOnSinglePage: true }}
        columns={[
          { title: "来源属性", dataIndex: "sourceName" },
          {
            title: "平台属性",
            render: (_, m) => (
              <>
                <Tag color="blue">{m.channel}</Tag>
                {m.channelAttrName}
              </>
            ),
          },
          {
            title: "属性 ID",
            render: (_, m) => (
              <Typography.Text code copyable style={{ fontSize: 12 }}>
                {m.channelAttrId}
              </Typography.Text>
            ),
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

function AccountCard() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const ext = useExtension();
  return (
    <Card title="账号与插件" size="small">
      <Space direction="vertical" size={8}>
        <div>
          当前用户：<b>{me.data?.user.name}</b>（{me.data?.user.email}） · 团队：{me.data?.workspace.name}
        </div>
        <Space>
          采集插件：<ExtensionBadge />
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          插件负责在 1688 页面采集商品并回扫货源变化；授权后工作台顶栏可随时重新绑定。
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          安装：<a href="/extension.zip" download>下载插件压缩包</a>，解压后打开 chrome://extensions，
          开启右上角「开发者模式」，点「加载已解压的扩展程序」选择解压目录，然后刷新本页点「授权插件」。
        </Typography.Text>
      </Space>
    </Card>
  );
}

/** 设置：类目映射 + 术语翻译映射 + 属性映射 + 账号/插件。 */
export function SettingsPage() {
  return (
    <div className="pg">
      <div className="pg-head">
        <h2>设置</h2>
        <span className="pg-sub">类目/属性/术语映射与各店刊登规则</span>
      </div>
      <Tabs
        defaultActiveKey="category"
        items={[
          { key: "category", label: "类目映射", children: <CategoryMappingCard /> },
          { key: "term", label: "术语翻译映射", children: <TermMappingCard /> },
          { key: "attribute", label: "属性映射", children: <AttributeMappingCard /> },
          { key: "account", label: "账号与插件", children: <AccountCard /> },
        ]}
      />
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        各店的定价 / AI 产线 / 发布前检查规则在<Link to="/stores">店铺页</Link>逐个编辑。
      </Typography.Text>
    </div>
  );
}
