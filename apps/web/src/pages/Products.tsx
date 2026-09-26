import type { Listing, ListingBatchOp, SourceChange, SourceItem } from "@caiji/shared";
import {
  CloudSyncOutlined,
  SearchOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Checkbox,
  DatePicker,
  InputNumber,
  Modal,
  Popover,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useStoreScope } from "../shell/storeScope";
import { EmptyState, Err, Loading, St, Thumb } from "../ui";

type ListingExt = Listing;
type Tab = "draft" | "online" | "watch";

const AUTO_ACTION_TEXT: Record<string, string> = {
  stock_push: "自动同步库存到店铺",
  stock_push_fallback_publish: "库存变化触发全量重发",
  price_push: "自动同步价格到店铺",
  price_push_unsupported: "渠道不支持单独推价（仅标记）",
};

const LSTATUS: Record<Listing["status"], { st: string; label: string }> = {
  draft: { st: "draft", label: "草稿" },
  publishing: { st: "running", label: "发布中" },
  published: { st: "success", label: "已发布" },
  failed: { st: "failed", label: "失败" },
};

const REMOTE_LABEL: Record<string, string> = {
  ACTIVE: "在售",
  DRAFT: "草稿",
  ARCHIVED: "已归档",
  UNLISTED: "不公开",
  DELETED: "已删除",
};

const CHANGE_TYPE_LABEL: Record<SourceChange["changeType"], string> = {
  price: "价格",
  stock: "库存",
  title: "标题",
  images: "图片",
  attributes: "属性",
  delisted: "下架",
};

function priceRange(l: Listing): string {
  if (!l.variants.length) return "—";
  const ps = l.variants.map((v) => v.price);
  const min = Math.min(...ps);
  const max = Math.max(...ps);
  return min === max ? min.toFixed(2) : `${min.toFixed(2)}~${max.toFixed(2)}`;
}

function changeSummary(ch: SourceChange): string {
  const ov = ch.oldValue as Record<string, unknown> | string | null;
  const nv = ch.newValue as Record<string, unknown> | string | null;
  const pick = (v: typeof ov, k: string) =>
    v && typeof v === "object" ? v[k] : v;
  switch (ch.changeType) {
    case "price":
      return `¥${String(pick(ov, "priceCny") ?? "—")} → ¥${String(pick(nv, "priceCny") ?? "—")}`;
    case "stock":
      return `${String(pick(ov, "stock") ?? "—")} → ${String(pick(nv, "stock") ?? "—")}`;
    case "title":
      return `「${String(nv ?? "").slice(0, 40)}」`;
    case "images":
      return `主图/详情图已变化`;
    case "attributes":
      return "属性有变化";
    case "delisted":
      return "货源已下架";
  }
}

/** 某货源的待处理变更列表（关注页黄标点开）。 */
function PendingChanges({ sourceItemId }: { sourceItemId: string }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ["source-changes", sourceItemId],
    queryFn: () => api.sourceChanges({ sourceItemId, pending: true, pageSize: 50 }),
  });
  const decide = useMutation({
    mutationFn: ({ ids, action }: { ids: string[]; action: "apply" | "ignore" }) =>
      api.decideSourceChanges(ids, action),
    onSuccess: (r) => {
      message.success(`已应用 ${r.applied} 条、忽略 ${r.ignored} 条`);
      qc.invalidateQueries({ queryKey: ["source-changes"] });
      qc.invalidateQueries({ queryKey: ["listings"] });
    },
    onError: (e) => message.error(e.message),
  });
  const items = q.data?.items ?? [];
  if (q.isLoading) return <Typography.Text type="secondary">加载中…</Typography.Text>;
  if (!items.length) return <Typography.Text type="secondary">没有待处理的货源变更</Typography.Text>;
  return (
    <Space direction="vertical" size={6} style={{ maxWidth: 420 }}>
      {items.map((ch) => (
        <Space key={ch.id} size={6}>
          <Tag color="gold">{CHANGE_TYPE_LABEL[ch.changeType]}</Tag>
          <span style={{ fontSize: 12 }}>{ch.skuId ? `${ch.skuId}：` : ""}{changeSummary(ch)}</span>
          <Button size="small" type="link" onClick={() => decide.mutate({ ids: [ch.id], action: "apply" })}>
            应用
          </Button>
          <Button size="small" type="link" onClick={() => decide.mutate({ ids: [ch.id], action: "ignore" })}>
            忽略
          </Button>
        </Space>
      ))}
      <Button
        size="small"
        onClick={() => decide.mutate({ ids: items.map((c) => c.id), action: "ignore" })}
      >
        全部忽略
      </Button>
    </Space>
  );
}

export function ProductsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const scope = useStoreScope();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("draft");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [priceModal, setPriceModal] = useState<{ op: "price_set" | "price_mul" | "price_add" } | null>(null);
  const [priceValue, setPriceValue] = useState<number | null>(null);
  const [tagModal, setTagModal] = useState(false);
  const [tagAdd, setTagAdd] = useState<string[]>([]);
  const [tagRemove, setTagRemove] = useState<string[]>([]);
  const [publishAtModal, setPublishAtModal] = useState(false);
  const [publishAt, setPublishAt] = useState<string | null>(null);

  const listings = useQuery({
    queryKey: ["listings", "all", scope.storeId ?? "*", q, tab],
    queryFn: async () => {
      const base = { pageSize: 100, storeId: scope.storeId ?? undefined, q: q || undefined };
      const first = await api.listings({ ...base, page: 1, watch: tab === "watch" || undefined });
      const pages = Math.ceil(first.total / 100);
      if (pages <= 1) return first.items as ListingExt[];
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) =>
          api.listings({ ...base, page: i + 2, watch: tab === "watch" || undefined }),
        ),
      );
      return [first.items, ...rest.map((r) => r.items)].flat() as ListingExt[];
    },
    refetchInterval: (qr) => (qr.state.data?.some((l) => l.status === "publishing") ? 2000 : false),
  });
  const sources = useQuery({
    queryKey: ["source-items", "map"],
    queryFn: async () => {
      // 与刊登查询同口径：翻完所有页，货源详情（价格/链接）不因超过一页而缺失
      const first = await api.sourceItems({ page: 1, pageSize: 100 });
      const pages = Math.ceil(first.total / 100);
      if (pages <= 1) return first.items;
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) => api.sourceItems({ page: i + 2, pageSize: 100 })),
      );
      return [first.items, ...rest.map((r) => r.items)].flat();
    },
    staleTime: 60_000,
  });
  const srcById = useMemo(() => {
    const m = new Map<string, SourceItem>();
    for (const i of sources.data ?? []) m.set(i.id, i);
    return m;
  }, [sources.data]);

  const inTab = (l: ListingExt) => {
    if (tab === "watch") return true; // 服务端 watch 过滤
    if (tab === "draft") return l.status === "draft" || l.status === "failed";
    return l.status === "published" || l.status === "publishing";
  };

  const groups = useMemo(() => {
    const by = new Map<string, ListingExt[]>();
    for (const l of listings.data ?? []) {
      if (!inTab(l)) continue;
      by.set(l.sourceItemId, [...(by.get(l.sourceItemId) ?? []), l]);
    }
    return [...by.entries()]
      .map(([sid, ls]) => ({
        source: srcById.get(sid),
        sid,
        listings: ls.sort((a, b) => a.storeId.localeCompare(b.storeId)),
        latest: Math.max(...ls.map((l) => new Date(l.updatedAt).getTime())),
        monitorPending: Math.max(...ls.map((l) => l.sourceMonitor?.pending ?? 0)),
      }))
      .sort((a, b) => b.latest - a.latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listings.data, srcById, tab]);

  const storeName = (id: string) => scope.stores.find((s) => s.id === id)?.name ?? "店铺";

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["listings"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
    qc.invalidateQueries({ queryKey: ["source-changes"] });
  };
  const publish = useMutation({
    mutationFn: (ids: string[]) => api.publish(ids),
    onSuccess: (r) => {
      if (r.queued) message.success(`已提交发布 ${r.queued} 条`);
      for (const b of r.blocked ?? []) {
        message.warning(`「${b.title.slice(0, 30)}」被发布前检查拦截：含禁售词 ${b.words.join("、")}`, 8);
      }
      setSelected(new Set());
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });
  const delist = useMutation({
    mutationFn: (ids: string[]) => api.delist(ids),
    onSuccess: (r) => {
      message.success(`已提交下架 ${r.queued} 条`);
      setSelected(new Set());
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });
  const batch = useMutation({
    mutationFn: (ops: ListingBatchOp[]) => api.listingBatch([...selected], ops),
    onSuccess: (r) => {
      message.success(`批量操作完成：更新 ${r.updated} 条`);
      setSelected(new Set());
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });
  const syncAll = useMutation({
    mutationFn: async () => {
      const all = scope.stores.filter((s) => s.status === "active");
      await Promise.all(all.map((s) => api.syncStore(s.id)));
      await new Promise((r) => setTimeout(r, 3000));
    },
    onSuccess: () => {
      message.success("已从店铺同步最新状态");
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });

  const counts = useQuery({ queryKey: ["listings", "counts"], queryFn: api.listingCounts });
  const toggle = (id: string, on: boolean) => {
    setSelected((s) => {
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const allIds = groups.flatMap((g) => g.listings.map((l) => l.id));
  const allChecked = allIds.length > 0 && allIds.every((id) => selected.has(id));

  const draftCount = (counts.data?.draft ?? 0) + (counts.data?.failed ?? 0);
  const onlineCount = (counts.data?.published ?? 0) + (counts.data?.publishing ?? 0);

  return (
    <div className="pg">
      <div className="pg-head">
        <h2>商品</h2>
        <span className="pg-sub">按货源聚合，同货源的各店刊登在一组里</span>
        <div className="pg-spacer" />
        <div className="rowline" style={{ flex: "none", minWidth: 220 }}>
          <SearchOutlined style={{ color: "var(--text-tertiary)", fontSize: 12 }} />
          <input
            className="inp sm"
            placeholder="搜索刊登标题…"
            onKeyDown={(e) => e.key === "Enter" && setQ((e.target as HTMLInputElement).value)}
          />
        </div>
        <div className="seg" style={{ flex: "none" }}>
          {(
            [
              ["draft", `草稿 ${draftCount}`],
              ["online", `在线 ${onlineCount}`],
              ["watch", "关注"],
            ] as Array<[Tab, string]>
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={tab === key ? "active" : ""}
              onClick={() => setTab(key)}
            >
              {label}
            </button>
          ))}
        </div>
        <button type="button" className="btn sm" onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
          <CloudSyncOutlined /> 同步店铺状态
        </button>
      </div>

      {selected.size > 0 && (
        <div className="rowline" style={{ marginBottom: 10, gap: 8, flexWrap: "wrap" }}>
          <Tag color="blue">已选 {selected.size} 条</Tag>
          <Button size="small" icon={<UploadOutlined />} onClick={() => publish.mutate([...selected])}>
            发布
          </Button>
          <Button size="small" onClick={() => delist.mutate([...selected])}>
            下架
          </Button>
          <Select
            size="small"
            placeholder="批量改价"
            style={{ width: 130 }}
            onChange={(op) => {
              setPriceValue(null);
              setPriceModal({ op });
            }}
            options={[
              { value: "price_set", label: "统一设为" },
              { value: "price_mul", label: "乘以系数" },
              { value: "price_add", label: "统一加减" },
            ]}
          />
          <Button size="small" onClick={() => setTagModal(true)}>
            内部标记
          </Button>
          <Button size="small" onClick={() => batch.mutate([{ op: "monitor_enable" }])}>
            批量开启监控
          </Button>
          <Button size="small" onClick={() => batch.mutate([{ op: "monitor_enable", value: false }])}>
            关闭监控
          </Button>
          <Button size="small" onClick={() => setPublishAtModal(true)}>
            定时发布
          </Button>
          <Button size="small" type="text" onClick={() => setSelected(new Set())}>
            清除选择
          </Button>
        </div>
      )}

      {listings.isLoading ? (
        <Loading />
      ) : listings.isError ? (
        <Err error={listings.error} onRetry={() => listings.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState>
          {tab === "watch"
            ? "关注页是空的：没有漂移、未消费的货源变更、远端删除或货源下架。"
            : (
              <>
                还没有刊登。去<Link to="/">铺货</Link>把货源认领到店铺。
              </>
            )}
        </EmptyState>
      ) : (
        <>
          <div className="rowline" style={{ marginBottom: 8 }}>
            <Checkbox
              checked={allChecked}
              onChange={(e) =>
                setSelected(e.target.checked ? new Set(allIds) : new Set())
              }
            >
              全选
            </Checkbox>
          </div>
          {groups.map((g) => (
            <div className="grp" key={g.sid}>
              <div className="grp-head">
                <Thumb src={g.source?.images[0] ?? g.listings[0]?.images[0]} />
                <span className="grp-title">{g.source?.title ?? g.listings[0]?.title ?? "未知货源"}</span>
                {g.source?.sourceUrl && (
                  <a href={g.source.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: "var(--fs-dense)" }}>
                    来源 ↗
                  </a>
                )}
                {g.source?.availability === "delisted" && (
                  <Tag color="red">
                    断货 {g.source.delistedAt ? Math.max(1, dayjs().diff(dayjs(g.source.delistedAt), "day")) : ""} 天
                  </Tag>
                )}
                {g.monitorPending > 0 && (
                  <Popover
                    title="货源变更"
                    trigger="click"
                    content={<PendingChanges sourceItemId={g.sid} />}
                  >
                    <Tag color="gold" style={{ cursor: "pointer" }}>
                      货源变更 ×{g.monitorPending}
                    </Tag>
                  </Popover>
                )}
                <span className="grp-meta">
                  {g.source?.priceText ?? ""} · {g.listings.length} 店稿
                </span>
              </div>
              <table className="tbl">
                <tbody>
                  {g.listings.map((l) => (
                    <tr key={l.id}>
                      <td style={{ width: 30 }}>
                        <Checkbox
                          checked={selected.has(l.id)}
                          onChange={(e) => toggle(l.id, e.target.checked)}
                        />
                      </td>
                      <td style={{ width: 120 }}>
                        <span style={{ fontWeight: 500, color: "var(--text)" }}>{storeName(l.storeId)}</span>
                      </td>
                      <td style={{ width: 130 }}>
                        <St st={LSTATUS[l.status].st}>
                          {LSTATUS[l.status].label}
                          {l.status === "published" && l.lastError ? " ⚠" : ""}
                        </St>
                      </td>
                      <td style={{ width: 110 }}>
                        {l.remoteStatus ? (
                          <St st={l.remoteStatus === "DELETED" ? "failed" : "success"}>
                            {REMOTE_LABEL[l.remoteStatus] ?? l.remoteStatus}
                          </St>
                        ) : (
                          <span style={{ color: "var(--text-tertiary)" }}>—</span>
                        )}
                      </td>
                      <td style={{ width: 100 }}>{priceRange(l)}</td>
                      <td>
                        {(l.sourceMonitor?.pending ?? 0) > 0 && (
                          <Popover
                            title="货源变更"
                            trigger="click"
                            content={<PendingChanges sourceItemId={l.sourceItemId} />}
                          >
                            <Tag color="gold" style={{ cursor: "pointer" }}>
                              货源{[...new Set(l.sourceMonitor!.types)].map((t) => CHANGE_TYPE_LABEL[t]).join("/")}变化
                            </Tag>
                          </Popover>
                        )}
                        {l.lastError && <div className="job-err">{l.lastError}</div>}
                        {l.remoteDrift.length > 0 && (
                          <div className="job-sub">
                            与店铺不一致：{[...new Set(l.remoteDrift.map((d) => d.field))].join("、")}
                          </div>
                        )}
                        {l.lastAutoAction && (
                          <div className="job-sub">
                            自动：{AUTO_ACTION_TEXT[l.lastAutoAction.action] ?? l.lastAutoAction.action} ·{" "}
                            {dayjs(l.lastAutoAction.at).format("MM-DD HH:mm")}
                          </div>
                        )}
                        {l.internalTags.map((t) => (
                          <Tag key={t} style={{ marginTop: 2 }}>{t}</Tag>
                        ))}
                        {!l.lastError && <div className="job-sub">{l.title}</div>}
                      </td>
                      <td style={{ width: 120, color: "var(--text-tertiary)" }}>
                        {dayjs(l.updatedAt).format("MM-DD HH:mm")}
                      </td>
                      <td className="t-act" style={{ width: 190 }}>
                        <Link to={`/listings/${l.id}`} className="t-link">
                          编辑
                        </Link>
                        {" · "}
                        {l.status !== "publishing" && (
                          <button type="button" className="btn ghost sm" onClick={() => publish.mutate([l.id])}>
                            <UploadOutlined /> {l.status === "failed" ? "重发" : l.status === "published" ? "同步" : "发布"}
                          </button>
                        )}
                        {l.status === "published" && l.remoteStatus !== "DRAFT" && (
                          <button type="button" className="btn ghost sm" onClick={() => delist.mutate([l.id])}>
                            下架
                          </button>
                        )}
                        {l.remoteUrl && (
                          <a href={l.remoteUrl} target="_blank" rel="noreferrer" className="t-link">
                            店铺 ↗
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}

      <Modal
        title="批量改价"
        open={!!priceModal}
        onCancel={() => setPriceModal(null)}
        onOk={() => {
          if (priceValue == null || !priceModal) return;
          batch.mutate([{ op: priceModal.op, value: priceValue }]);
          setPriceModal(null);
        }}
      >
        <Space>
          {priceModal?.op === "price_set" && "把所有选中刊登的售价统一设为："}
          {priceModal?.op === "price_mul" && "把选中刊登的售价统一乘以："}
          {priceModal?.op === "price_add" && "把选中刊登的售价统一加/减（负数=减）："}
          <InputNumber value={priceValue} onChange={(v) => setPriceValue(v)} step={0.01} style={{ width: 160 }} />
        </Space>
      </Modal>

      <Modal
        title="内部标记"
        open={tagModal}
        onCancel={() => setTagModal(false)}
        onOk={() => {
          if (!tagAdd.length && !tagRemove.length) return setTagModal(false);
          batch.mutate([{ op: "internal_tag", add: tagAdd, remove: tagRemove }]);
          setTagModal(false);
          setTagAdd([]);
          setTagRemove([]);
        }}
      >
        <Space direction="vertical" style={{ width: "100%" }}>
          <div>
            添加标记：
            <Select mode="tags" style={{ width: "100%" }} value={tagAdd} onChange={setTagAdd} open={false} placeholder="输入标记后回车" />
          </div>
          <div>
            移除标记：
            <Select mode="tags" style={{ width: "100%" }} value={tagRemove} onChange={setTagRemove} open={false} placeholder="输入要移除的标记" />
          </div>
        </Space>
      </Modal>

      <Modal
        title="定时发布"
        open={publishAtModal}
        onCancel={() => setPublishAtModal(false)}
        onOk={() => {
          batch.mutate([{ op: "publish_at", value: publishAt }]);
          setPublishAtModal(false);
        }}
      >
        <Space>
          选择发布时间（留空则取消定时）：
          <DatePicker
            showTime
            onChange={(d) => setPublishAt(d ? d.toISOString() : null)}
          />
        </Space>
      </Modal>
    </div>
  );
}
