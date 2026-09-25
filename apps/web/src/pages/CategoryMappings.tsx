import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App, Button, Card, Popconfirm, Table, Tag, Typography } from "antd";
import { api } from "../api";

/** 类目映射：用户确认过的 来源类目 → 平台类目；删除后同来源类目重新走 AI 建议。 */
export function CategoryMappingsPage() {
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
