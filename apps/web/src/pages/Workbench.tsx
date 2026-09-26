import type {
  AttributesSuggestionValue,
  CategorySuggestionValue,
  Listing,
  ListingSuggestion,
  OptionsSuggestionValue,
  PipelineStage,
  SourceItem,
  Store,
  SuggestionField,
} from "@caiji/shared";
import {
  CheckOutlined,
  LinkOutlined,
  ReloadOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import dayjs from "dayjs";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { api } from "../api";
import { useExtension } from "../components/ExtensionBadge";
import { sanitizeHtml } from "../lib/sanitize";
import { collectOfferById } from "../extensionBridge";
import { useStoreScope } from "../shell/storeScope";
import { EmptyState, Err, Loading, Modal, St, Thumb } from "../ui";

type ListingExt = Listing;

const FIELD_LABEL: Record<SuggestionField, string> = {
  title: "标题",
  descriptionHtml: "描述",
  productType: "商品类型",
  tags: "标签",
  options: "变体选项",
  category: "类目",
  attributes: "平台属性",
};

const LISTING_TEXT: Record<Listing["status"], { st: string; label: string }> = {
  draft: { st: "draft", label: "草稿" },
  publishing: { st: "running", label: "发布中" },
  published: { st: "success", label: "已发布" },
  failed: { st: "failed", label: "发布失败" },
};

const REMOTE_TEXT: Record<string, string> = {
  ACTIVE: "在售",
  DRAFT: "店铺草稿",
  ARCHIVED: "已归档",
  UNLISTED: "不公开",
  DELETED: "店铺已删除",
};

const AUTO_ACTION_TEXT: Record<string, string> = {
  stock_push: "自动同步库存到店铺",
  stock_push_fallback_publish: "库存变化触发全量重发",
};

/** 链路阶段徽标（店稿卡上展示；null 不出徽标）。 */
const PIPELINE_TEXT: Record<PipelineStage, { st: string; label: string }> = {
  claimed: { st: "draft", label: "链路·已认领" },
  ai_running: { st: "running", label: "链路·AI 处理中" },
  hold_ai: { st: "review", label: "链路·待人工审核" },
  precheck: { st: "review", label: "链路·待发布" },
  hold_precheck: { st: "review", label: "链路·发布前待确认" },
  queued: { st: "running", label: "链路·发布排队中" },
  publishing: { st: "running", label: "链路·发布中" },
  published: { st: "success", label: "链路·已发布" },
  failed: { st: "failed", label: "链路·失败" },
};

function extractOfferId(input: string): string | null {
  const t = input.trim();
  return (
    t.match(/offer\/(\d+)/)?.[1] ?? t.match(/[?&]offerId=(\d+)/)?.[1] ?? (/^\d{6,}$/.test(t) ? t : null)
  );
}

/** 当前选中货源的各店刊登（服务端按 sourceItemId 过滤）。 */
function useSourceListings(sourceItemId: string | null, storeScope?: string | null) {
  return useQuery({
    queryKey: ["listings", "source", sourceItemId, storeScope ?? "*"],
    enabled: !!sourceItemId,
    queryFn: () =>
      api
        .listings({ sourceItemId: sourceItemId!, storeId: storeScope ?? undefined, pageSize: 100 })
        .then((r) => r.items as ListingExt[]),
    refetchInterval: (q) =>
      q.state.data?.some(
        (l) =>
          l.status === "publishing" ||
          ["ai_running", "queued", "publishing"].includes(l.pipelineStage ?? ""),
      )
        ? 2000
        : false,
  });
}

function priceRange(l: Listing): string {
  if (!l.variants.length) return "—";
  const ps = l.variants.map((v) => v.price);
  const min = Math.min(...ps);
  const max = Math.max(...ps);
  return min === max ? min.toFixed(2) : `${min.toFixed(2)} ~ ${max.toFixed(2)}`;
}

/** 轻量发布前检查（展示用；真正的门禁在服务端）。 */
function listingIssues(l: Listing): string[] {
  const issues: string[] = [];
  if (!l.title.trim()) issues.push("标题为空");
  if (!l.images.length) issues.push("没有主图");
  if (l.variants.every((v) => v.price <= 0)) issues.push("售价未定价");
  if (!l.channelCategoryId) issues.push("类目未映射");
  if (!l.vendor) issues.push("品牌为空");
  return issues;
}

/* ================= 左栏：货源池 ================= */

function LinkCollect({ onDone }: { onDone: () => void }) {
  const { message } = App.useApp();
  const ext = useExtension();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const ready = !!ext.data?.authorized;

  const run = async () => {
    const ids = [...new Set(value.split(/\s+/).map(extractOfferId).filter((v): v is string => !!v))];
    if (!ids.length) {
      message.warning("粘贴 1688 商品链接或 offerId，多个用空格/换行分隔");
      return;
    }
    setBusy(true);
    let ok = 0;
    const errors: string[] = [];
    for (const id of ids) {
      try {
        await collectOfferById(id);
        ok++;
      } catch (e) {
        errors.push(`${id}: ${(e as Error).message}`);
      }
    }
    setBusy(false);
    onDone();
    if (errors.length) message.error(`成功 ${ok}，失败 ${errors.length}：${errors[0]}`);
    else {
      message.success(`采集成功 ${ok} 个`);
      setValue("");
    }
  };

  return (
    <div className="rowline">
      <input
        className="inp sm"
        placeholder={ready ? "粘贴 1688 链接 / offerId，回车采集" : "先在顶栏授权插件"}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && run()}
        disabled={!ready}
      />
      <button type="button" className="btn sm" disabled={!ready || busy} onClick={run}>
        {busy ? "采集中…" : "采集"}
      </button>
    </div>
  );
}

function SourceRow({
  item,
  stores,
  active,
  onSelect,
}: {
  item: SourceItem;
  stores: Store[];
  active: boolean;
  onSelect: () => void;
}) {
  const claimedNames = item.claimedStoreIds
    .map((id) => stores.find((s) => s.id === id)?.name)
    .filter(Boolean) as string[];
  const changed = new Date(item.updatedAt).getTime() - new Date(item.collectedAt).getTime() > 60_000;
  return (
    <button type="button" className={`pd-row${active ? " sel" : ""}`} onClick={onSelect}>
      <Thumb src={item.images[0]} />
      <span style={{ minWidth: 0, flex: 1 }}>
        <span className="pd-title">{item.title}</span>
        <span className="pd-sub">
          {item.priceText ?? (item.skus[0]?.priceCny ? `¥${item.skus[0].priceCny}` : "—")}
          {" · "}{item.skus.length} SKU · {dayjs(item.collectedAt).format("MM-DD HH:mm")}
        </span>
        {claimedNames.length > 0 && (
          <span className="pd-sub" style={{ gap: 4 }}>
            {claimedNames.map((n) => (
              <span key={n} className="tag">
                {n}
              </span>
            ))}
          </span>
        )}
      </span>
      {changed && (
        <span className="tag warn" title={`来源更新于 ${dayjs(item.updatedAt).format("MM-DD HH:mm")}`}>
          已更新
        </span>
      )}
    </button>
  );
}

function SourceColumn({
  onClaim,
  selectedId,
  onSelect,
}: {
  onClaim: () => void;
  selectedId: string | null;
  onSelect: (item: SourceItem) => void;
}) {
  const { stores } = useStoreScope();
  const qc = useQueryClient();
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<"unclaimed" | "claimed">("unclaimed");
  // 分页加载：超过一页的货源可用「加载更多」浏览，刷新时已加载页一起更新
  const list = useInfiniteQuery({
    queryKey: ["source-items", q],
    queryFn: ({ pageParam }) => api.sourceItems({ q, page: pageParam, pageSize: 50 }),
    initialPageParam: 1,
    getNextPageParam: (last, pages) =>
      pages.reduce((n, p) => n + p.items.length, 0) < last.total ? pages.length + 1 : undefined,
    refetchInterval: 60_000,
  });
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;
  const unclaimed = items.filter((i) => i.claimedStoreIds.length === 0);
  const claimed = items.filter((i) => i.claimedStoreIds.length > 0);
  const shown = tab === "unclaimed" ? unclaimed : claimed;
  useEffect(() => {
    if (!selectedId && shown.length) onSelect(shown[0]);
  }, [selectedId, shown, onSelect]);

  return (
    <section className="col">
      <div className="col-head">
        货源池
        <span className="col-count">
          {unclaimed.length} 待认领 · {claimed.length} 已认领
        </span>
      </div>
      <div className="src-acts" style={{ flexDirection: "column", gap: 8 }}>
        <LinkCollect onDone={() => qc.invalidateQueries({ queryKey: ["source-items"] })} />
        <div className="rowline">
          <div className="rowline" style={{ flex: 1 }}>
            <SearchOutlined style={{ color: "var(--text-tertiary)", fontSize: 12 }} />
            <input
              className="inp sm"
              placeholder="搜索标题…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <button
            type="button"
            className="icon-btn"
            title="刷新"
            onClick={() => list.refetch()}
            disabled={list.isFetching}
          >
            <ReloadOutlined spin={list.isFetching} />
          </button>
        </div>
        <div className="seg">
          <button type="button" className={tab === "unclaimed" ? "active" : ""} onClick={() => setTab("unclaimed")}>
            待认领（{unclaimed.length}）
          </button>
          <button type="button" className={tab === "claimed" ? "active" : ""} onClick={() => setTab("claimed")}>
            已认领（{claimed.length}）
          </button>
        </div>
      </div>
      <div className="col-body">
        {list.isLoading ? (
          <Loading />
        ) : list.isError ? (
          <Err error={list.error} onRetry={() => list.refetch()} />
        ) : shown.length === 0 ? (
          <EmptyState>
            {q
              ? "没有匹配的货源"
              : tab === "unclaimed"
                ? "没有待认领的货源。贴 1688 链接采集，或在 1688 页面用插件「加入采集箱」。"
                : "还没有已认领的货源"}
          </EmptyState>
        ) : (
          shown.map((item) => (
            <SourceRow
              key={item.id}
              item={item}
              stores={stores}
              active={item.id === selectedId}
              onSelect={() => onSelect(item)}
            />
          ))
        )}
        {list.hasNextPage && (
          <button
            type="button"
            className="btn sm ghost"
            style={{ margin: "4px auto" }}
            disabled={list.isFetchingNextPage}
            onClick={() => list.fetchNextPage()}
          >
            {list.isFetchingNextPage ? "加载中…" : `加载更多（还有 ${total - items.length} 条）`}
          </button>
        )}
      </div>
      <div className="col-foot">
        <button type="button" className="btn" disabled={!selectedId} onClick={onClaim}>
          仅认领到店铺…
        </button>
      </div>
    </section>
  );
}

/* ================= 中栏：店稿 + AI 建议 ================= */

function SuggestionValue({ s }: { s: ListingSuggestion }) {
  if (s.field === "title" || s.field === "productType") {
    return <span className="ai-diff-new">{String(s.value)}</span>;
  }
  if (s.field === "descriptionHtml") {
    return (
      <div
        className="ai-diff-new"
        style={{ maxHeight: 160, overflow: "auto" }}
        dangerouslySetInnerHTML={{ __html: sanitizeHtml(String(s.value)) }}
      />
    );
  }
  if (s.field === "tags") {
    return (
      <span className="rowline" style={{ flexWrap: "wrap" }}>
        {(s.value as string[]).map((t) => (
          <span key={t} className="tag">
            {t}
          </span>
        ))}
      </span>
    );
  }
  if (s.field === "options") {
    const v = s.value as OptionsSuggestionValue;
    return (
      <table className="var-tbl">
        <tbody>
          {v.options.map((o) => (
            <tr key={o.name}>
              <td style={{ width: 90, color: "var(--text-tertiary)" }}>{o.name}</td>
              <td>{o.values.join(" / ")}</td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  if (s.field === "attributes") {
    const v = s.value as AttributesSuggestionValue;
    return (
      <table className="var-tbl">
        <tbody>
          {v.attributes.map((a) => (
            <tr key={`${a.attrId}:${a.sourceName}`}>
              <td style={{ color: "var(--text-tertiary)" }}>
                {a.sourceName ? `${a.sourceName}：${a.sourceValue}` : "（新增）"}
              </td>
              <td>
                {a.attrName}: {a.value}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return null;
}

function SuggestionCard({
  s,
  listing,
  onDecide,
  busy,
}: {
  s: ListingSuggestion;
  listing: Listing;
  onDecide: (id: string, action: "accept" | "reject", choice?: string) => void;
  busy: boolean;
}) {
  const current =
    s.field === "title"
      ? listing.title
      : s.field === "productType"
        ? listing.productType
        : s.field === "category"
          ? listing.channelCategoryName
          : null;
  if (s.field === "category") {
    const v = s.value as CategorySuggestionValue;
    return (
      <div className="ai-diff">
        <div className="ai-diff-head">
          <span className="tag ai">AI</span> 类目建议
          <span className="col-count">来源：{v.sourceCategoryName ?? "未知"}</span>
        </div>
        {v.candidates.map((c, i) => (
          <div className="ai-cand" key={c.id}>
            <span style={{ flex: 1 }}>
              {i + 1}. {c.fullName || c.name}
              {c.confidence != null && (
                <span style={{ color: "var(--text-tertiary)" }}>　置信度 {c.confidence}</span>
              )}
            </span>
            <button type="button" className="btn sm primary" disabled={busy} onClick={() => onDecide(s.id, "accept", c.id)}>
              用此类目
            </button>
          </div>
        ))}
        <div className="ai-diff-acts">
          <button type="button" className="btn sm" disabled={busy} onClick={() => onDecide(s.id, "reject")}>
            回退
          </button>
          <span className="cta-note" style={{ textAlign: "left" }}>
            当前：{current ?? "未映射"}；确认后同来源类目自动套用
          </span>
        </div>
      </div>
    );
  }
  return (
    <div className="ai-diff">
      <div className="ai-diff-head">
        <span className="tag ai">AI</span> {FIELD_LABEL[s.field]}建议
        <span className="col-count" />
        <span className="ai-diff-acts">
          <button
            type="button"
            className="btn sm primary"
            disabled={busy}
            onClick={() => onDecide(s.id, "accept")}
          >
            <CheckOutlined /> 接受
          </button>
          <button type="button" className="btn sm" disabled={busy} onClick={() => onDecide(s.id, "reject")}>
            回退
          </button>
        </span>
      </div>
      {current != null && current !== "" && <span className="ai-diff-old">{current}</span>}
      {s.field === "options" && (
        <span className="ai-diff-old">
          {listing.options.map((o) => `${o.name}: ${o.values.join("/")}`).join("　")}
        </span>
      )}
      <SuggestionValue s={s} />
      {s.field === "options" && (
        <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>接受后所有变体的选项值一并替换</span>
      )}
    </div>
  );
}

function SuggestionsPanel({ listing }: { listing: Listing }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const query = useQuery({
    queryKey: ["suggestions", listing.id],
    queryFn: () => api.listingSuggestions(listing.id),
    refetchInterval: (q) => (q.state.data?.pending ? 3000 : false),
  });
  const [busy, setBusy] = useState(false);
  const decide = async (id: string, action: "accept" | "reject", choice?: string) => {
    setBusy(true);
    try {
      await api.decideSuggestions(listing.id, [{ id, action, choice }]);
      qc.invalidateQueries({ queryKey: ["suggestions", listing.id] });
      qc.invalidateQueries({ queryKey: ["listings"] });
      if (action === "accept") message.success("已应用到店稿");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const regenerate = async () => {
    try {
      const r = await api.aiEnhance(listing.id);
      if (!r.queued) message.info("已有 AI 任务在队列中");
      qc.invalidateQueries({ queryKey: ["suggestions", listing.id] });
    } catch (e) {
      message.error((e as Error).message);
    }
  };

  const items = query.data?.items ?? [];
  const pending = items.filter((i) => i.status === "pending");
  const generating = query.data?.pending ?? false;
  if (!query.data || (pending.length === 0 && !generating && items.length === 0)) {
    return (
      <div className="fld">
        <div className="fld-label">AI 建议</div>
        <div className="cta-note" style={{ textAlign: "left" }}>
          暂无建议。
          <button type="button" className="btn sm ghost" onClick={regenerate}>
            生成 AI 建议
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="fld">
      <div className="fld-label">
        AI 建议
        {generating && <span className="tag ai">生成中…</span>}
        {pending.length > 0 && <span className="tag">{pending.length} 条待审</span>}
        <span className="fld-count">
          {pending.length > 1 && (
            <button
              type="button"
              className="btn sm"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                try {
                  await api.decideSuggestions(
                    listing.id,
                    pending.map((s) => ({ id: s.id, action: "accept" as const })),
                  );
                  qc.invalidateQueries({ queryKey: ["suggestions", listing.id] });
                  qc.invalidateQueries({ queryKey: ["listings"] });
                  message.success(`已接受 ${pending.length} 条`);
                } catch (e) {
                  message.error((e as Error).message);
                } finally {
                  setBusy(false);
                }
              }}
            >
              全部接受
            </button>
          )}
          <button type="button" className="btn sm ghost" onClick={regenerate}>
            重新生成
          </button>
        </span>
      </div>
      {pending.map((s) => (
        <SuggestionCard key={s.id} s={s} listing={listing} onDecide={decide} busy={busy} />
      ))}
    </div>
  );
}

function DraftSummary({ listing }: { listing: ListingExt }) {
  const issues = listingIssues(listing);
  const opts = listing.options;
  return (
    <>
      <div className="fld">
        <div className="fld-label">
          标题
          {listing.lastError && <span className="tag err">发布失败</span>}
          <span className="fld-count">{listing.title.length}/255</span>
        </div>
        <div style={{ fontSize: "var(--fs)" }}>{listing.title}</div>
        {listing.lastError && (
          <div className="chk-issue">
            <span className="chk-issue-f">原因</span>
            <span style={{ color: "var(--st-failed)" }}>{listing.lastError}</span>
          </div>
        )}
      </div>

      <div className="fld">
        <div className="fld-label">
          图片<span className="fld-count">{listing.images.length} 主图 · {listing.descImages.length} 详情图</span>
        </div>
        <div className="imgstrip">
          {listing.images.map((src) => (
            <Thumb key={src} src={src} lg />
          ))}
        </div>
      </div>

      <div className="fld">
        <div className="fld-label">
          变体
          <span className="fld-count">
            {listing.variants.length} 个 · 售价 {priceRange(listing)}
          </span>
        </div>
        <table className="var-tbl">
          <thead>
            <tr>
              {opts.map((o) => (
                <th key={o.name}>{o.name}</th>
              ))}
              <th>SKU</th>
              <th>售价</th>
            </tr>
          </thead>
          <tbody>
            {listing.variants.slice(0, 5).map((v, i) => (
              <tr key={i}>
                {opts.map((_, j) => (
                  <td key={j}>{v.optionValues[j]}</td>
                ))}
                <td>{v.sku || "—"}</td>
                <td>{v.price.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {listing.variants.length > 5 && (
          <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>
            还有 {listing.variants.length - 5} 个变体，去完整编辑页查看
          </span>
        )}
      </div>

      <div className="fld">
        <div className="fld-label">属性</div>
        <div className="rowline" style={{ flexWrap: "wrap", gap: 4 }}>
          <span className="tag">类目：{listing.channelCategoryName ?? "未映射"}</span>
          {listing.vendor && <span className="tag">品牌：{listing.vendor}</span>}
          {listing.productType && <span className="tag">{listing.productType}</span>}
          {listing.tags.slice(0, 6).map((t) => (
            <span key={t} className="tag">
              {t}
            </span>
          ))}
        </div>
      </div>

      {issues.length > 0 && (
        <div className="fld">
          <div className="fld-label" style={{ color: "var(--st-partial)" }}>发布前还缺</div>
          <div className="chk-issues">
            {issues.map((i) => (
              <span key={i} className="chk-issue">
                · {i}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}

function MiddleColumn({
  item,
  listings,
  listingsLoading,
}: {
  item: SourceItem | null;
  listings: ListingExt[];
  listingsLoading: boolean;
}) {
  const { stores } = useStoreScope();
  const [tabStoreId, setTabStoreId] = useState<string | null>(null);
  if (!item) {
    return (
      <section className="col">
        <div className="col-head">店稿</div>
        <EmptyState icon={<LinkOutlined style={{ fontSize: 20 }} />}>
          在左侧选中一个货源，这里展示它在各店的刊登草稿
        </EmptyState>
      </section>
    );
  }
  const mine = listings.filter((l) => l.sourceItemId === item.id);
  const activeListing =
    mine.find((l) => l.storeId === tabStoreId) ?? mine.find((l) => l.status === "draft") ?? mine[0] ?? null;
  const changed = new Date(item.updatedAt).getTime() - new Date(item.collectedAt).getTime() > 60_000;

  return (
    <section className="col">
      <div className="col-head">
        店稿
        <span className="col-count" style={{ fontWeight: 400 }}>
          {item.sourcePlatform} · {item.sourceItemId ?? ""}
        </span>
      </div>
      <div className="col-body">
        <div className="fld">
          <div className="fld-label">
            来源货源
            <a href={item.sourceUrl} target="_blank" rel="noreferrer" className="fld-count" style={{ marginLeft: "auto" }}>
              打开来源 ↗
            </a>
          </div>
          <div className="rowline">
            <Thumb src={item.images[0]} />
            <span className="pd-title" style={{ flex: 1 }}>{item.title}</span>
          </div>
          <div className="pd-sub">
            采集于 {dayjs(item.collectedAt).format("MM-DD HH:mm")}
            {changed && (
              <span className="tag warn" title="来源数据在首次采集后有更新（重采）">
                来源已更新 · {dayjs(item.updatedAt).format("MM-DD HH:mm")}
              </span>
            )}
          </div>
        </div>

        {mine.length > 0 && (
          <div className="fld">
            <div className="fld-label">各店草稿</div>
            <div className="lt-tabs">
              {mine.map((l) => {
                const s = stores.find((x) => x.id === l.storeId);
                return (
                  <button
                    type="button"
                    key={l.id}
                    className={`lt-tab${activeListing?.id === l.id ? " active" : ""}`}
                    onClick={() => setTabStoreId(l.storeId)}
                  >
                    <span className="st-dot" data-st={LISTING_TEXT[l.status].st} />
                    {s?.name ?? "店铺"}
                    {l.remoteStatus && (
                      <span style={{ color: "var(--text-tertiary)" }}>{REMOTE_TEXT[l.remoteStatus] ?? l.remoteStatus}</span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {listingsLoading ? (
          <Loading />
        ) : !activeListing ? (
          <EmptyState>这个货源还没有认领到任何店铺。在右侧勾选目标店，点「铺到 N 家店」一步完成。</EmptyState>
        ) : (
          <>
            <div className="rowline" style={{ justifyContent: "space-between" }}>
              <St st={LISTING_TEXT[activeListing.status].st}>
                {LISTING_TEXT[activeListing.status].label}
                {activeListing.remoteStatus ? ` · 店铺${REMOTE_TEXT[activeListing.remoteStatus] ?? activeListing.remoteStatus}` : ""}
              </St>
              <span className="rowline">
                {activeListing.remoteUrl && (
                  <a href={activeListing.remoteUrl} target="_blank" rel="noreferrer" style={{ fontSize: "var(--fs-dense)" }}>
                    店铺后台 ↗
                  </a>
                )}
                <Link to={`/listings/${activeListing.id}`} className="btn sm">
                  完整编辑
                </Link>
              </span>
            </div>
            {activeListing.linkStatus === "remote_deleted" && (
              <div className="chk-issue">
                <span className="chk-issue-f">远端</span>
                <span>店铺侧商品已删除，重新发布会新建</span>
              </div>
            )}
            {activeListing.remoteDrift.length > 0 && (
              <div className="chk-issue">
                <span className="chk-issue-f">漂移</span>
                <span>
                  与店铺不一致：{[...new Set(activeListing.remoteDrift.map((d) => d.field))].join("、")}
                  （下次发布会以本地为准覆盖）
                </span>
              </div>
            )}
            {activeListing.lastAutoAction && (
              <div className="chk-issue">
                <span className="chk-issue-f">自动</span>
                <span>
                  {AUTO_ACTION_TEXT[activeListing.lastAutoAction.action] ?? activeListing.lastAutoAction.action}
                  {" · "}{dayjs(activeListing.lastAutoAction.at).format("MM-DD HH:mm")}
                </span>
              </div>
            )}
            <DraftSummary listing={activeListing} />
            <SuggestionsPanel listing={activeListing} />
          </>
        )}
      </div>
    </section>
  );
}

/* ================= 右栏：店铺对照 + 唯一主按钮 ================= */

function StoreCheckCard({
  store,
  listing,
  pendingSuggests,
  checked,
  onCheck,
}: {
  store: Store;
  listing: ListingExt | undefined;
  pendingSuggests: number;
  checked: boolean;
  onCheck: (v: boolean) => void;
}) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const [pipeBusy, setPipeBusy] = useState(false);
  const pipe = async (act: "advance" | "pause" | "cancel") => {
    if (!listing) return;
    setPipeBusy(true);
    try {
      const call = {
        advance: api.pipelineAdvance,
        pause: api.pipelinePause,
        cancel: api.pipelineCancel,
      }[act];
      await call(listing.id);
      qc.invalidateQueries({ queryKey: ["listings"] });
      if (act === "advance") message.success("已推进");
      else if (act === "pause") message.success("已暂停");
      else message.success("已退出链路");
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setPipeBusy(false);
    }
  };
  const dead = store.status !== "active";
  const busy = listing?.status === "publishing";
  const issues = listing ? listingIssues(listing) : [];
  const blockers = issues.filter((i) => i !== "类目未映射" && i !== "品牌为空");

  let statusLine: React.ReactNode;
  if (dead) statusLine = <St st="failed">连接异常，先到店铺页处理</St>;
  else if (!listing) statusLine = <St st="draft">未认领 · 将创建草稿并发布</St>;
  else if (listing.status === "publishing") statusLine = <St st="running">发布中…</St>;
  else if (listing.status === "failed")
    statusLine = <St st="failed">发布失败{listing.lastError ? `：${listing.lastError}` : ""}</St>;
  else if (listing.status === "published")
    statusLine = (
      <St st={listing.remoteStatus === "DELETED" ? "failed" : "success"}>
        已发布{listing.remoteStatus ? ` · ${REMOTE_TEXT[listing.remoteStatus] ?? listing.remoteStatus}` : ""}
        {listing.remoteStatus === "DELETED" ? "（重发将新建）" : "（点击同步更新）"}
      </St>
    );
  else if (pendingSuggests > 0) statusLine = <St st="review">草稿 · {pendingSuggests} 条 AI 建议待审</St>;
  else if (blockers.length > 0) statusLine = <St st="review">草稿 · 缺字段</St>;
  else statusLine = <St st="ready">草稿 · 可发布</St>;

  return (
    <div className={`chk${dead ? " off" : ""}`}>
      <div className="chk-head">
        <input
          type="checkbox"
          className="chk-box"
          disabled={dead || busy}
          checked={checked}
          onChange={(e) => onCheck(e.target.checked)}
          aria-label={`选择店铺 ${store.name}`}
        />
        <b>{store.name}</b>
        <span className="chk-meta">
          {store.platform}
          {store.currency ? ` · ${store.currency}` : ""}
        </span>
      </div>
      <div className="chk-status">
        {statusLine}
        {listing?.remoteUrl && (
          <a href={listing.remoteUrl} target="_blank" rel="noreferrer" style={{ marginLeft: "auto" }}>
            ↗
          </a>
        )}
      </div>
      {listing?.pipelineStage && (
        <div className="chk-issues">
          <span className="chk-issue">
            <St st={PIPELINE_TEXT[listing.pipelineStage].st}>
              {PIPELINE_TEXT[listing.pipelineStage].label}
            </St>
            {listing.publishAt &&
              ` · 定时 ${dayjs(listing.publishAt).format("MM-DD HH:mm")}`}
            {listing.pipelineHoldReason && (
              <span style={{ color: "var(--text-tertiary)" }}>（{listing.pipelineHoldReason}）</span>
            )}
          </span>
          <span className="rowline" style={{ marginLeft: "auto" }}>
            {listing.pipelineStage !== "published" && listing.pipelineStage !== "publishing" && (
              <button
                type="button"
                className="btn sm primary"
                disabled={pipeBusy}
                onClick={() => pipe("advance")}
              >
                推进
              </button>
            )}
            {listing.pipelineStage !== "published" &&
              listing.pipelineStage !== "publishing" &&
              listing.pipelineHoldReason !== "manual" && (
                <button
                  type="button"
                  className="btn sm"
                  disabled={pipeBusy}
                  onClick={() => pipe("pause")}
                >
                  暂停
                </button>
              )}
            {listing.pipelineStage !== "published" && listing.pipelineStage !== "publishing" && (
              <button
                type="button"
                className="btn sm ghost"
                disabled={pipeBusy}
                onClick={() => pipe("cancel")}
              >
                取消链路
              </button>
            )}
          </span>
        </div>
      )}
      {listing && issues.length > 0 && listing.status !== "published" && (
        <div className="chk-issues">
          {issues.map((i) => (
            <span key={i} className="chk-issue">
              <span className="chk-issue-f">缺</span>
              {i}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ClaimModal({ item, open, onClose }: { item: SourceItem | null; open: boolean; onClose: () => void }) {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const { stores } = useStoreScope();
  const [storeIds, setStoreIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const active = stores.filter((s) => s.status === "active");
  const claimable = active.filter((s) => !item?.claimedStoreIds.includes(s.id));
  const run = async (advance: boolean) => {
    if (!item) return;
    setBusy(true);
    try {
      const r = await api.claim([item.id], storeIds, advance);
      message.success(
        `已认领 ${r.created} 条${r.skipped ? `，跳过已认领 ${r.skipped} 条` : ""}${advance ? "，链路已启动" : ""}`,
      );
      qc.invalidateQueries({ queryKey: ["source-items"] });
      qc.invalidateQueries({ queryKey: ["listings"] });
      setStoreIds([]);
      onClose();
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  if (!open || !item) return null;
  return (
    <Modal
      title={`认领「${item.title.slice(0, 24)}…」到店铺`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button
            type="button"
            className="btn"
            disabled={!storeIds.length || busy}
            onClick={() => run(true)}
          >
            认领并发布
          </button>
          <button
            type="button"
            className="btn primary"
            disabled={!storeIds.length || busy}
            onClick={() => run(false)}
          >
            {busy ? "认领中…" : `认领${storeIds.length ? `（${storeIds.length}）` : ""}`}
          </button>
        </>
      }
    >
      {claimable.length === 0 ? (
        <div className="mo-note">该货源已认领到所有可用店铺。</div>
      ) : (
        claimable.map((s) => (
          <label key={s.id} className="rowline" style={{ cursor: "pointer" }}>
            <input
              type="checkbox"
              className="chk-box"
              checked={storeIds.includes(s.id)}
              onChange={(e) =>
                setStoreIds((v) => (e.target.checked ? [...v, s.id] : v.filter((x) => x !== s.id)))
              }
            />
            <span>{s.name}</span>
            <span className="mo-note">（{s.shopDomain}）</span>
          </label>
        ))
      )}
      <div className="mo-note">
        认领后按店铺定价规则生成刊登草稿，AI 建议随后在店稿中待审；「认领并发布」进入自动链路
        （AI → 卡点 → 发布前检查 → 按店铺节奏发布）。
      </div>
    </Modal>
  );
}

export function WorkbenchPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const scope = useStoreScope();
  const [selected, setSelected] = useState<SourceItem | null>(null);
  const selectedId = selected?.id ?? null;
  const [claimOpen, setClaimOpen] = useState(false);
  const [checkedStores, setCheckedStores] = useState<Set<string>>(new Set());
  const [busyStores, setBusyStores] = useState(false);
  const lastAction = useRef<string | null>(null);

  const listings = useSourceListings(selectedId, scope.storeId);
  const mine = listings.data ?? [];
  const pendingQueries = useQueries({
    queries: mine.map((l) => ({
      queryKey: ["suggestions", l.id] as const,
      queryFn: () => api.listingSuggestions(l.id),
      refetchInterval: (q: { state: { data?: { pending?: boolean } } }) => (q.state.data?.pending ? 3000 : false),
    })),
  });
  const pendingByListing = useMemo(() => {
    const m = new Map<string, number>();
    mine.forEach((l, i) => {
      const items = pendingQueries[i]?.data?.items;
      if (items) m.set(l.id, items.filter((s) => s.status === "pending").length);
    });
    return m;
  }, [mine, pendingQueries]);

  const listingFor = (storeId: string) => mine.find((l) => l.storeId === storeId);
  const visibleStores = scope.storeId ? scope.stores.filter((s) => s.id === scope.storeId) : scope.stores;
  const checked = [...checkedStores].filter((id) => visibleStores.some((s) => s.id === id));
  const targetable = visibleStores.filter((s) => s.status === "active");

  const run = async (claimOnly: boolean) => {
    if (!selected || checked.length === 0) return;
    setBusyStores(true);
    lastAction.current = claimOnly ? "claim" : "publish";
    try {
      const fresh = () => listings.refetch().then((r) => r.data ?? []);
      const listingOf = (arr: ListingExt[], sid: string) =>
        arr.find((l) => l.sourceItemId === selected.id && l.storeId === sid);

      const needClaim = checked.filter((sid) => !listingOf(listings.data ?? [], sid));
      if (needClaim.length) {
        const r = await api.claim([selected.id], needClaim);
        if (r.created > 0) message.success(`已认领 ${r.created} 条`);
        qc.invalidateQueries({ queryKey: ["source-items"] });
      }
      if (claimOnly) {
        qc.invalidateQueries({ queryKey: ["listings"] });
        return;
      }
      // claim 后需要拿到新 listing 再发布
      const arr = await fresh();
      const ids = checked
        .map((sid) => listingOf(arr, sid))
        .filter((l): l is ListingExt => !!l && l.status !== "publishing")
        .map((l) => l.id);
      if (!ids.length) {
        message.info("没有可发布的草稿（可能都已在发布中）");
        return;
      }
      const r = await api.publish(ids);
      if (r.queued) message.success(`已提交发布 ${r.queued} 条，原地跟踪状态`);
      for (const b of r.blocked ?? []) {
        message.warning(`「${b.title.slice(0, 30)}」被发布前检查拦截：含禁售词 ${b.words.join("、")}`, 8);
      }
      qc.invalidateQueries({ queryKey: ["listings"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    } catch (e) {
      message.error((e as Error).message);
    } finally {
      setBusyStores(false);
    }
  };

  const allChecked = targetable.length > 0 && targetable.every((s) => checked.includes(s.id));
  return (
    <>
      <div className="narrow-hint">工作台按 ≥1280px 宽设计，当前窗口较窄，三栏会纵向堆叠。</div>
      <div className="pub">
        <SourceColumn selectedId={selectedId} onSelect={setSelected} onClaim={() => setClaimOpen(true)} />
        <MiddleColumn item={selected} listings={listings.data ?? []} listingsLoading={listings.isLoading} />
        <section className="col">
          <div className="col-head">
            目标店铺
            <span className="col-count">
              {scope.store ? `仅 ${scope.store.name}` : `${visibleStores.length} 店`}
            </span>
          </div>
          <div className="src-acts">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() =>
                setCheckedStores(allChecked ? new Set() : new Set(targetable.map((s) => s.id)))
              }
            >
              {allChecked ? "取消全选" : "全选可发布店铺"}
            </button>
          </div>
          <div className="col-body">
            {visibleStores.length === 0 ? (
              <EmptyState>
                还没有店铺。先去<Link to="/stores">店铺页</Link>连接 Shopify。
              </EmptyState>
            ) : (
              visibleStores.map((s) => {
                const l = listingFor(s.id);
                return (
                  <StoreCheckCard
                    key={s.id}
                    store={s}
                    listing={l}
                    pendingSuggests={l ? (pendingByListing.get(l.id) ?? 0) : 0}
                    checked={checkedStores.has(s.id)}
                    onCheck={(v) =>
                      setCheckedStores((old) => {
                        const n = new Set(old);
                        if (v) n.add(s.id);
                        else n.delete(s.id);
                        return n;
                      })
                    }
                  />
                );
              })
            )}
          </div>
          <div className="col-foot">
            {!selected && <div className="cta-note">先在左侧选一个货源</div>}
            {selected && checked.length === 0 && <div className="cta-note">勾选目标店铺</div>}
            <button
              type="button"
              className="cta"
              disabled={!selected || checked.length === 0 || busyStores}
              onClick={() => run(false)}
            >
              {busyStores ? "处理中…" : `铺到 ${checked.length} 家店`}
            </button>
            {checked.some((sid) => !listingFor(sid)) && (
              <button type="button" className="btn sm ghost" disabled={busyStores} onClick={() => run(true)}>
                仅认领，先不发布
              </button>
            )}
          </div>
        </section>
      </div>
      <ClaimModal item={selected} open={claimOpen} onClose={() => setClaimOpen(false)} />
    </>
  );
}
