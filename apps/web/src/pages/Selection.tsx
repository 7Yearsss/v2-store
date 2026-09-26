import {
  DeleteOutlined,
  PlayCircleOutlined,
  PlusOutlined,
} from "@ant-design/icons";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { App } from "antd";
import dayjs from "dayjs";
import { useMemo, useState } from "react";
import type {
  DiscoveryItem,
  DiscoveryItemStatus,
  DiscoverySignals,
  SelectionPlan,
  SelectionPlanFilters,
} from "@caiji/shared";
import { SELECTION_PRESET_PLANS } from "@caiji/shared";
import { api } from "../api";
import { useExtension } from "../components/ExtensionBadge";
import { stageCollectMany } from "../extensionBridge";
import { EmptyState, Err, Loading, Modal, St, Thumb } from "../ui";

const STATUS_TABS: Array<{ v: DiscoveryItemStatus | ""; label: string }> = [
  { v: "new", label: "新候选" },
  { v: "collected", label: "已入箱" },
  { v: "dismissed", label: "已忽略" },
  { v: "", label: "全部" },
];

const SCORE_FILTERS = [
  { v: 0, label: "全部评分" },
  { v: 50, label: "≥50" },
  { v: 70, label: "≥70" },
];

/** 1688 找同款：有图走以图搜款，没图退回标题关键词搜索。 */
function sameStyleUrl(item: DiscoveryItem): string {
  if (item.thumb) {
    return `https://s.1688.com/youyuan/index.htm?tab=imageSearch&imageAddress=${encodeURIComponent(item.thumb)}`;
  }
  return `https://s.1688.com/selloffer/offer_search.htm?keywords=${encodeURIComponent(item.title ?? item.sourceItemId)}`;
}

function SignalBadges({ s }: { s: DiscoverySignals }) {
  const tags: string[] = [];
  if (s.daiFa) tags.push("一件代发");
  if (s.ship48h) tags.push("48h发货");
  if (s.repurchaseRate != null) tags.push(`回头率${Math.round(s.repurchaseRate * 100)}%`);
  if (s.sellerYears != null) tags.push(`${s.sellerYears}年店`);
  if (s.sameStyleCount != null) tags.push(`同款${s.sameStyleCount}`);
  if (s.sourceRank != null) tags.push(`榜${s.sourceRank}`);
  if (s.rank != null && s.sourceRank == null) tags.push(`第${s.rank}名`);
  if (!tags.length) return null;
  return (
    <div className="sel-badges">
      {tags.map((t) => (
        <span key={t} className="tag">
          {t}
        </span>
      ))}
    </div>
  );
}

interface PlanDraft {
  name: string;
  source: "keyword" | "1688_rank";
  keywords: string;
  category: string;
  priceMin: string;
  priceMax: string;
  requireDaiFa: boolean;
  require48h: boolean;
  minRepurchase: string;
  schedule: "manual" | "daily";
  enabled: boolean;
}

const EMPTY_DRAFT: PlanDraft = {
  name: "",
  source: "keyword",
  keywords: "",
  category: "",
  priceMin: "",
  priceMax: "",
  requireDaiFa: true,
  require48h: false,
  minRepurchase: "",
  schedule: "manual",
  enabled: true,
};

function draftFromPlan(p?: SelectionPlan): PlanDraft {
  if (!p) return { ...EMPTY_DRAFT };
  const f = p.filters;
  return {
    name: p.name,
    source: p.source,
    keywords: (f.keywords ?? []).join("，"),
    category: f.category ?? "",
    priceMin: f.priceMinCny != null ? String(f.priceMinCny) : "",
    priceMax: f.priceMaxCny != null ? String(f.priceMaxCny) : "",
    requireDaiFa: f.requireDaiFa ?? false,
    require48h: f.require48h ?? false,
    minRepurchase: f.minRepurchase != null ? String(Math.round(f.minRepurchase * 100)) : "",
    schedule: p.schedule,
    enabled: p.enabled,
  };
}

function draftFilters(d: PlanDraft): SelectionPlanFilters {
  const num = (s: string) => {
    const n = s.trim() === "" ? undefined : Number(s);
    return Number.isFinite(n) ? n : undefined;
  };
  return {
    keywords: d.keywords.split(/[,，、\n]/).map((k) => k.trim()).filter(Boolean),
    category: d.category.trim() || undefined,
    priceMinCny: num(d.priceMin),
    priceMaxCny: num(d.priceMax),
    requireDaiFa: d.requireDaiFa || undefined,
    require48h: d.require48h || undefined,
    minRepurchase: num(d.minRepurchase) != null ? Number(d.minRepurchase) / 100 : undefined,
  };
}

export function SelectionPage() {
  const { message } = App.useApp();
  const qc = useQueryClient();
  const ext = useExtension();
  const [planId, setPlanId] = useState<string | undefined>(undefined);
  const [status, setStatus] = useState<DiscoveryItemStatus | "">("new");
  const [minScore, setMinScore] = useState(0);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [editor, setEditor] = useState<{ open: boolean; plan?: SelectionPlan; draft: PlanDraft }>({
    open: false,
    draft: { ...EMPTY_DRAFT },
  });

  const plans = useQuery({ queryKey: ["selection-plans"], queryFn: api.selectionPlans });
  const items = useQuery({
    queryKey: ["discovery", "items", planId ?? "*", status, minScore],
    queryFn: () =>
      api.discoveryItems({
        planId,
        status: status || undefined,
        minScore: minScore || undefined,
        pageSize: 100,
      }),
    refetchInterval: 30_000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["selection-plans"] });
    qc.invalidateQueries({ queryKey: ["discovery"] });
  };

  const savePlan = useMutation({
    mutationFn: async () => {
      const d = editor.draft;
      const body = {
        name: d.name.trim(),
        source: d.source,
        filters: draftFilters(d),
        schedule: d.schedule,
        enabled: d.enabled,
      };
      return editor.plan
        ? api.updateSelectionPlan(editor.plan.id, body)
        : api.createSelectionPlan(body);
    },
    onSuccess: () => {
      message.success("已保存");
      setEditor({ open: false, draft: { ...EMPTY_DRAFT } });
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });

  const runPlan = useMutation({
    mutationFn: (id: string) => api.runSelectionPlan(id),
    onSuccess: () => {
      message.success("已标记到期——插件下次轮询会抓，现有候选重新打分");
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });

  const delPlan = useMutation({
    mutationFn: (id: string) => api.deleteSelectionPlan(id),
    onSuccess: () => {
      message.success("计划已删除");
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });

  const collect = useMutation({
    mutationFn: async (ids: string[]) => {
      const res = await api.discoveryCollect(ids);
      if (!res.items.length) throw new Error("没有可采集的候选（可能已入箱或被忽略）");
      if (!ext.data) {
        throw new Error("插件未连接——先授权插件，再把候选挂进待确认队列");
      }
      const staged = await stageCollectMany(
        res.items.map((i) => ({
          offerId: i.offerId,
          title: i.title,
          image: i.image ?? undefined,
          price: i.price ?? undefined,
          via: "plan",
        })),
      );
      return { count: res.items.length, queueCount: staged.count };
    },
    onSuccess: (r) => {
      message.success(
        `已加入插件待确认 ${r.count} 条（队列共 ${r.queueCount}）——打开任一 1688 页面在「待确认」里提交入库`,
        6,
      );
      setChecked(new Set());
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });

  const dismiss = useMutation({
    mutationFn: (ids: string[]) => api.discoveryDismiss(ids),
    onSuccess: (r) => {
      message.success(`已忽略 ${r.dismissed} 条`);
      setChecked(new Set());
      invalidate();
    },
    onError: (e) => message.error(e.message),
  });

  const planList = plans.data?.items ?? [];
  const itemList = items.data?.items ?? [];
  const lastRunAt = useMemo(() => {
    const ats = planList.map((p) => p.lastRunAt).filter((v): v is string => !!v);
    return ats.length ? ats.sort().at(-1)! : null;
  }, [planList]);
  const dailyPending = planList.filter((p) => p.schedule === "daily" && p.enabled && p.due).length;

  const toggle = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const checkedNew = itemList.filter((i) => checked.has(i.id) && i.status === "new").map((i) => i.id);

  return (
    <div className="pg sel">
      <header className="pg-head">
        <h2>选品</h2>
        <span className="pg-sub">
          计划定筛选 · 插件浏览/定时回流候选 · 勾选后详情页重采入箱
        </span>
        <span className="pg-spacer" />
        <span className="pg-sub" title="最近一次有候选回流的计划时间">
          {lastRunAt ? `最近回流 ${dayjs(lastRunAt).format("MM-DD HH:mm")}` : "尚无回流"}
          {dailyPending > 0 && ` · ${dailyPending} 个每日计划待插件抓取`}
        </span>
        <St st={ext.data ? "success" : "failed"}>
          {ext.data ? "插件在线" : "插件离线"}
        </St>
        <button
          type="button"
          className="btn primary"
          onClick={() => setEditor({ open: true, draft: { ...EMPTY_DRAFT } })}
        >
          <PlusOutlined /> 新建计划
        </button>
      </header>

      <div className="sel-body">
        <aside className="col sel-plans">
          <div className="col-head">
            选品计划
            <span className="pg-sub">{planList.length} 个</span>
          </div>
          <div className="sel-plan-list">
            <button
              type="button"
              className={`sel-plan${planId === undefined ? " active" : ""}`}
              onClick={() => setPlanId(undefined)}
            >
              <span className="sel-plan-name">全部候选</span>
              <span className="sel-plan-meta" />
            </button>
            {planList.map((p) => (
              <div
                key={p.id}
                className={`sel-plan${planId === p.id ? " active" : ""}${p.enabled ? "" : " off"}`}
                role="button"
                tabIndex={0}
                onClick={() => setPlanId(p.id)}
                onKeyDown={(e) => e.key === "Enter" && setPlanId(p.id)}
              >
                <span className="sel-plan-name" title={p.name}>
                  {p.name}
                </span>
                <span className="sel-plan-meta">
                  <span className="tag">{p.schedule === "daily" ? "每日" : "手动"}</span>
                  {p.due && p.enabled && <span className="tag warn">待抓取</span>}
                  {(p.newCount ?? 0) > 0 && <span className="tag ai">{p.newCount} 新</span>}
                </span>
                <span className="sel-plan-acts">
                  <button
                    type="button"
                    className="btn ghost sm"
                    title="立即跑一轮（插件下次轮询抓取 + 重新打分）"
                    disabled={runPlan.isPending}
                    onClick={(e) => {
                      e.stopPropagation();
                      runPlan.mutate(p.id);
                    }}
                  >
                    <PlayCircleOutlined />
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm"
                    title="编辑计划"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditor({ open: true, plan: p, draft: draftFromPlan(p) });
                    }}
                  >
                    编辑
                  </button>
                  <button
                    type="button"
                    className="btn ghost sm danger"
                    title="删除计划"
                    onClick={(e) => {
                      e.stopPropagation();
                      if (window.confirm(`删除计划「${p.name}」及其候选？`)) delPlan.mutate(p.id);
                    }}
                  >
                    <DeleteOutlined />
                  </button>
                </span>
                <span className="sel-plan-last" title={p.lastRunAt ?? ""}>
                  {p.lastRunAt ? `回流 ${dayjs(p.lastRunAt).format("MM-DD HH:mm")}` : "未跑过"}
                </span>
              </div>
            ))}
          </div>
          <div className="sel-plan-foot">
            <span className="pg-sub">预设模板：</span>
            {SELECTION_PRESET_PLANS.map((tpl) => (
              <button
                key={tpl.name}
                type="button"
                className="btn ghost sm"
                title={tpl.filters.keywords?.join("、")}
                onClick={() =>
                  setEditor({
                    open: true,
                    draft: { ...draftFromPlan(), ...tplToDraft(tpl), name: tpl.name },
                  })
                }
              >
                {tpl.name}
              </button>
            ))}
          </div>
        </aside>

        <section className="col sel-pool">
          <div className="col-head">
            <div className="seg" style={{ flex: "none" }}>
              {STATUS_TABS.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  className={status === t.v ? "active" : ""}
                  onClick={() => setStatus(t.v)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <div className="seg" style={{ flex: "none" }}>
              {SCORE_FILTERS.map((t) => (
                <button
                  key={t.label}
                  type="button"
                  className={minScore === t.v ? "active" : ""}
                  onClick={() => setMinScore(t.v)}
                >
                  {t.label}
                </button>
              ))}
            </div>
            <span className="pg-sub">{items.data ? `${items.data.total} 条` : ""}</span>
            <span className="pg-spacer" />
            {checkedNew.length > 0 && (
              <>
                <span className="pg-sub">已选 {checkedNew.length}</span>
                <button
                  type="button"
                  className="btn primary sm"
                  disabled={collect.isPending}
                  onClick={() => collect.mutate(checkedNew)}
                >
                  采集入库
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={dismiss.isPending}
                  onClick={() => dismiss.mutate(checkedNew)}
                >
                  忽略
                </button>
              </>
            )}
          </div>

          {items.isLoading ? (
            <Loading />
          ) : items.isError ? (
            <Err error={items.error} onRetry={() => items.refetch()} />
          ) : !itemList.length ? (
            <EmptyState>
              {status === "new"
                ? "暂无新候选——每日计划等插件抓取，或点计划的 ▶ 立即跑；浏览 1688 搜索页时命中计划关键词的卡片也会自动回流"
                : "这个状态下没有候选"}
            </EmptyState>
          ) : (
            <div className="sel-wall">
              {itemList.map((it) => {
                const selectable = it.status === "new";
                return (
                  <div key={it.id} className={`sel-card${checked.has(it.id) ? " on" : ""}`}>
                    <div className="sel-card-top">
                      {selectable && (
                        <input
                          type="checkbox"
                          className="chk-box sel-card-chk"
                          checked={checked.has(it.id)}
                          onChange={() => toggle(it.id)}
                          aria-label={`选择 ${it.title ?? it.sourceItemId}`}
                        />
                      )}
                      {it.score != null && (
                        <span
                          className={`sel-score${it.score >= 70 ? " hi" : it.score <= 0 ? " lo" : ""}`}
                          title="确定性信号打分（代发/发货/回头率/价带/毛利试算/名次）"
                        >
                          {it.score}
                        </span>
                      )}
                    </div>
                    <a
                      href={`https://detail.1688.com/offer/${it.sourceItemId}.html`}
                      target="_blank"
                      rel="noreferrer"
                      className="sel-card-img"
                    >
                      <Thumb src={it.thumb ?? undefined} lg />
                    </a>
                    <div className="sel-card-title" title={it.title ?? ""}>
                      {it.title ?? it.sourceItemId}
                    </div>
                    <div className="sel-card-meta">
                      <span className="sel-price">{it.priceText ?? "—"}</span>
                      {it.status !== "new" && (
                        <span className="tag">
                          {it.status === "collected"
                            ? "已入箱"
                            : it.status === "dismissed"
                              ? "已忽略"
                              : "已过期"}
                        </span>
                      )}
                    </div>
                    <SignalBadges s={it.signals} />
                    {it.aiNote && <div className="sel-note">AI：{it.aiNote}</div>}
                    <div className="sel-card-acts">
                      <a
                        className="btn ghost sm"
                        href={sameStyleUrl(it)}
                        target="_blank"
                        rel="noreferrer"
                        title="在 1688 找同款/相似货源"
                      >
                        找同款
                      </a>
                      {it.status === "collected" && it.sourceItemDbId ? (
                        <span className="tag ai">采集箱 ✓</span>
                      ) : selectable ? (
                        <button
                          type="button"
                          className="btn ghost sm"
                          onClick={() => dismiss.mutate([it.id])}
                        >
                          忽略
                        </button>
                      ) : null}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {editor.open && (
        <Modal
          title={editor.plan ? `编辑计划：${editor.plan.name}` : "新建选品计划"}
          onClose={() => setEditor({ open: false, draft: { ...EMPTY_DRAFT } })}
          footer={
            <>
              <button
                type="button"
                className="btn"
                onClick={() => setEditor({ open: false, draft: { ...EMPTY_DRAFT } })}
              >
                取消
              </button>
              <button
                type="button"
                className="btn primary"
                disabled={savePlan.isPending || !editor.draft.name.trim()}
                onClick={() => savePlan.mutate()}
              >
                保存
              </button>
            </>
          }
        >
          <div className="mo-form">
            <label>
              <span>名称</span>
              <input
                className="inp"
                value={editor.draft.name}
                onChange={(e) => setEditor((s) => ({ ...s, draft: { ...s.draft, name: e.target.value } }))}
                placeholder="如：宠物玩具·一件代发"
              />
            </label>
            <label>
              <span>来源</span>
              <select
                className="inp"
                value={editor.draft.source}
                onChange={(e) =>
                  setEditor((s) => ({
                    ...s,
                    draft: { ...s.draft, source: e.target.value as PlanDraft["source"] },
                  }))
                }
              >
                <option value="keyword">1688 关键词搜索</option>
                <option value="1688_rank">1688 销量榜</option>
              </select>
            </label>
            <label>
              <span>关键词（逗号分隔，最多 5 个参与抓取）</span>
              <textarea
                className="inp"
                rows={2}
                value={editor.draft.keywords}
                onChange={(e) =>
                  setEditor((s) => ({ ...s, draft: { ...s.draft, keywords: e.target.value } }))
                }
                placeholder="收纳箱，收纳架"
              />
            </label>
            <div className="mo-row">
              <label>
                <span>最低价 ¥</span>
                <input
                  className="inp"
                  inputMode="decimal"
                  value={editor.draft.priceMin}
                  onChange={(e) =>
                    setEditor((s) => ({ ...s, draft: { ...s.draft, priceMin: e.target.value } }))
                  }
                />
              </label>
              <label>
                <span>最高价 ¥</span>
                <input
                  className="inp"
                  inputMode="decimal"
                  value={editor.draft.priceMax}
                  onChange={(e) =>
                    setEditor((s) => ({ ...s, draft: { ...s.draft, priceMax: e.target.value } }))
                  }
                />
              </label>
              <label>
                <span>回头率 ≥ %</span>
                <input
                  className="inp"
                  inputMode="numeric"
                  value={editor.draft.minRepurchase}
                  onChange={(e) =>
                    setEditor((s) => ({
                      ...s,
                      draft: { ...s.draft, minRepurchase: e.target.value },
                    }))
                  }
                />
              </label>
            </div>
            <div className="mo-row">
              <label className="mo-check">
                <input
                  type="checkbox"
                  checked={editor.draft.requireDaiFa}
                  onChange={(e) =>
                    setEditor((s) => ({
                      ...s,
                      draft: { ...s.draft, requireDaiFa: e.target.checked },
                    }))
                  }
                />
                只要一件代发
              </label>
              <label className="mo-check">
                <input
                  type="checkbox"
                  checked={editor.draft.require48h}
                  onChange={(e) =>
                    setEditor((s) => ({
                      ...s,
                      draft: { ...s.draft, require48h: e.target.checked },
                    }))
                  }
                />
                只要 48h 发货
              </label>
            </div>
            <div className="mo-row">
              <label>
                <span>节奏</span>
                <select
                  className="inp"
                  value={editor.draft.schedule}
                  onChange={(e) =>
                    setEditor((s) => ({
                      ...s,
                      draft: { ...s.draft, schedule: e.target.value as PlanDraft["schedule"] },
                    }))
                  }
                >
                  <option value="manual">手动（点 ▶ 跑）</option>
                  <option value="daily">每日（插件定时抓）</option>
                </select>
              </label>
              <label className="mo-check">
                <input
                  type="checkbox"
                  checked={editor.draft.enabled}
                  onChange={(e) =>
                    setEditor((s) => ({ ...s, draft: { ...s.draft, enabled: e.target.checked } }))
                  }
                />
                启用
              </label>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function tplToDraft(tpl: (typeof SELECTION_PRESET_PLANS)[number]): Partial<PlanDraft> {
  const f = tpl.filters;
  return {
    source: tpl.source,
    keywords: (f.keywords ?? []).join("，"),
    category: f.category ?? "",
    priceMin: f.priceMinCny != null ? String(f.priceMinCny) : "",
    priceMax: f.priceMaxCny != null ? String(f.priceMaxCny) : "",
    requireDaiFa: f.requireDaiFa ?? false,
    require48h: f.require48h ?? false,
    minRepurchase: f.minRepurchase != null ? String(Math.round(f.minRepurchase * 100)) : "",
    schedule: tpl.schedule,
    enabled: true,
  };
}
