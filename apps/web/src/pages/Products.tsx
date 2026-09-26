import type { Listing, SourceItem } from "@caiji/shared";
import {
  CloudSyncOutlined,
  SearchOutlined,
  UploadOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useStoreScope } from "../shell/storeScope";
import { EmptyState, Err, Loading, St, Thumb } from "../ui";

type ListingExt = Listing;

const AUTO_ACTION_TEXT: Record<string, string> = {
  stock_push: "自动同步库存到店铺",
  stock_push_fallback_publish: "库存变化触发全量重发",
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

function priceRange(l: Listing): string {
  if (!l.variants.length) return "—";
  const ps = l.variants.map((v) => v.price);
  const min = Math.min(...ps);
  const max = Math.max(...ps);
  return min === max ? min.toFixed(2) : `${min.toFixed(2)}~${max.toFixed(2)}`;
}

export function ProductsPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const scope = useStoreScope();
  const [q, setQ] = useState("");
  const [statusFilter, setStatusFilter] = useState<Listing["status"] | "all">("all");

  const listings = useQuery({
    queryKey: ["listings", "all", scope.storeId ?? "*", q],
    queryFn: async () => {
      const first = await api.listings({ pageSize: 100, page: 1, storeId: scope.storeId ?? undefined, q: q || undefined });
      const pages = Math.ceil(first.total / 100);
      if (pages <= 1) return first.items as ListingExt[];
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) =>
          api.listings({ pageSize: 100, page: i + 2, storeId: scope.storeId ?? undefined, q: q || undefined }),
        ),
      );
      return [first.items, ...rest.map((r) => r.items)].flat() as ListingExt[];
    },
    refetchInterval: (qr) => (qr.state.data?.some((l) => l.status === "publishing") ? 2000 : false),
  });
  const sources = useQuery({
    queryKey: ["source-items", "map"],
    queryFn: () => api.sourceItems({ page: 1, pageSize: 100 }),
    staleTime: 60_000,
  });
  const srcById = useMemo(() => {
    const m = new Map<string, SourceItem>();
    for (const i of sources.data?.items ?? []) m.set(i.id, i);
    return m;
  }, [sources.data]);

  const groups = useMemo(() => {
    const by = new Map<string, ListingExt[]>();
    for (const l of listings.data ?? []) {
      if (statusFilter !== "all" && l.status !== statusFilter) continue;
      by.set(l.sourceItemId, [...(by.get(l.sourceItemId) ?? []), l]);
    }
    return [...by.entries()]
      .map(([sid, ls]) => ({
        source: srcById.get(sid),
        sid,
        listings: ls.sort((a, b) => a.storeId.localeCompare(b.storeId)),
        latest: Math.max(...ls.map((l) => new Date(l.updatedAt).getTime())),
      }))
      .sort((a, b) => b.latest - a.latest);
  }, [listings.data, srcById, statusFilter]);

  const storeName = (id: string) => scope.stores.find((s) => s.id === id)?.name ?? "店铺";

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["listings"] });
    qc.invalidateQueries({ queryKey: ["overview"] });
  };
  const publish = useMutation({
    mutationFn: (ids: string[]) => api.publish(ids),
    onSuccess: (r) => {
      if (r.queued) message.success(`已提交发布 ${r.queued} 条`);
      for (const b of r.blocked ?? []) {
        message.warning(`「${b.title.slice(0, 30)}」被发布前检查拦截：含禁售词 ${b.words.join("、")}`, 8);
      }
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });
  const delist = useMutation({
    mutationFn: (ids: string[]) => api.delist(ids),
    onSuccess: (r) => {
      message.success(`已提交下架 ${r.queued} 条`);
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
          {(["all", "draft", "publishing", "published", "failed"] as const).map((s) => (
            <button
              key={s}
              type="button"
              className={statusFilter === s ? "active" : ""}
              onClick={() => setStatusFilter(s)}
            >
              {s === "all" ? "全部" : LSTATUS[s].label}
              {s !== "all" && counts.data?.[s] != null ? ` ${counts.data[s]}` : ""}
            </button>
          ))}
        </div>
        <button type="button" className="btn sm" onClick={() => syncAll.mutate()} disabled={syncAll.isPending}>
          <CloudSyncOutlined /> 同步店铺状态
        </button>
      </div>

      {listings.isLoading ? (
        <Loading />
      ) : listings.isError ? (
        <Err error={listings.error} onRetry={() => listings.refetch()} />
      ) : groups.length === 0 ? (
        <EmptyState>
          还没有刊登。去<Link to="/">铺货</Link>把货源认领到店铺。
        </EmptyState>
      ) : (
        groups.map((g) => (
          <div className="grp" key={g.sid}>
            <div className="grp-head">
              <Thumb src={g.source?.images[0] ?? g.listings[0]?.images[0]} />
              <span className="grp-title">{g.source?.title ?? g.listings[0]?.title ?? "未知货源"}</span>
              {g.source?.sourceUrl && (
                <a href={g.source.sourceUrl} target="_blank" rel="noreferrer" style={{ fontSize: "var(--fs-dense)" }}>
                  来源 ↗
                </a>
              )}
              <span className="grp-meta">
                {g.source?.priceText ?? ""} · {g.listings.length} 店稿
              </span>
            </div>
            <table className="tbl">
              <tbody>
                {g.listings.map((l) => (
                  <tr key={l.id}>
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
        ))
      )}
    </div>
  );
}
