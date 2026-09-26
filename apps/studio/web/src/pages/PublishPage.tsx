import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link2,
  Plus,
  RefreshCw,
  Sparkles,
  Store,
  Upload,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useNavigate, useSearchParams } from "react-router";
import type {
  AiField,
  ChannelCheck,
  DraftFields,
  ListingDraft,
  Product,
  ProductVariant,
} from "@studio/shared";
import { api } from "../api.js";
import { AiMenu, type AiAction } from "../components/AiMenu.js";
import {
  CreateProductModal,
  ImportCsvModal,
  LinkProductModal,
} from "../components/productModals.js";
import {
  Empty,
  Err,
  Loading,
  PlatformBadge,
  SOURCE_NAME,
  St,
  Thumb,
} from "../components/ui.js";
import { useShopScope } from "../shell/shopScope.js";

/** AI 字段 → 主稿字段键 */
const AI_TO_FIELD: Record<AiField, keyof DraftFields> = {
  title: "title",
  description: "description",
  bullets: "bullets",
  attributes: "attributes",
  pricing: "price",
};

type SaveState = "saved" | "dirty" | "saving" | "error";

interface AiCard {
  kind: "ok" | "error";
  label: string;
  oldValue: unknown;
  newValue: unknown;
}

function fmtVal(v: unknown): string {
  if (v == null || v === "") return "（空）";
  if (Array.isArray(v)) return v.map((x) => `· ${x}`).join("\n");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, string>)
      .map(([k, val]) => `${k}: ${val}`)
      .join("\n");
  }
  return String(v);
}

function variantLabel(v: ProductVariant): string {
  const opt = Object.entries(v.options)
    .map(([k, val]) => `${k}=${val}`)
    .join(" ");
  return opt || v.sku || "默认";
}

/** 重命名属性键（保持插入顺序） */
function renameKey(rec: Record<string, string>, from: string, to: string) {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec)) out[k === from ? to : k] = v;
  return out;
}

function omitKey(rec: Record<string, string>, key: string) {
  const out = { ...rec };
  delete out[key];
  return out;
}

/* ================================================================
   /publish —— 铺货三栏：货 | 主稿 | 渠道对照
   ================================================================ */
export function PublishPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const scope = useShopScope();
  const [params, setParams] = useSearchParams();

  /* ---------- 左栏：商品池 ---------- */
  const productsQ = useQuery({ queryKey: ["products"], queryFn: () => api.products() });
  const products = useMemo(() => productsQ.data?.items ?? [], [productsQ.data]);

  const [selectedId, setSelectedId] = useState<string | null>(params.get("product"));
  const selectedRef = useRef<string | null>(selectedId);
  selectedRef.current = selectedId;

  // 列表加载后兜底选中第一个；?product= 变化（商品页跳来）时跟随
  useEffect(() => {
    if (!selectedId && products.length) setSelectedId(products[0].id);
  }, [selectedId, products]);
  useEffect(() => {
    const p = params.get("product");
    if (p && p !== selectedRef.current) setSelectedId(p);
  }, [params]);

  /* ---------- 中栏：主稿 + 自动保存 ---------- */
  const [baseDraft, setBaseDraft] = useState<ListingDraft | null>(null);
  const [fields, setFields] = useState<DraftFields | null>(null);
  const [saveState, setSaveState] = useState<SaveState>("saved");
  const [aiCards, setAiCards] = useState<Partial<Record<AiField, AiCard>>>({});
  const [aiBusy, setAiBusy] = useState<AiField | null>(null);
  // ok 店默认勾选（unchecked 记录用户取消）；问题店默认剔除（forced 记录用户强行勾选）
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const [forced, setForced] = useState<Set<string>>(new Set());

  const loadedRef = useRef<string | null>(null); // fields 当前承载的 productId
  const pendingRef = useRef<{ productId: string | null; patch: Partial<DraftFields> }>({
    productId: null,
    patch: {},
  });
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const draftQ = useQuery({
    queryKey: ["draft", selectedId],
    queryFn: () => api.draft(selectedId!),
    enabled: !!selectedId,
  });

  useEffect(() => {
    const d = draftQ.data;
    if (!d || !selectedId) return;
    setBaseDraft(d);
    if (loadedRef.current !== d.productId) {
      loadedRef.current = d.productId;
      pendingRef.current = { productId: d.productId, patch: {} };
      setFields({ ...d.fields, images: d.fields.images ?? [] });
      setSaveState("saved");
      setAiCards({});
      setUnchecked(new Set());
      setForced(new Set());
    }
  }, [draftQ.data, selectedId]);

  const sendPatch = useCallback(async (): Promise<boolean> => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const { productId, patch } = pendingRef.current;
    if (!productId || !Object.keys(patch).length) return true;
    pendingRef.current = { productId, patch: {} };
    setSaveState("saving");
    try {
      const resp = await api.patchDraft(productId, patch);
      queryClient.setQueryData(["draft", productId], resp);
      if (selectedRef.current === productId) setBaseDraft(resp);
      setSaveState(Object.keys(pendingRef.current.patch).length ? "dirty" : "saved");
      return true;
    } catch {
      // 保留未送出的 patch，下次编辑/点击状态行时重发
      pendingRef.current = {
        productId,
        patch: { ...patch, ...pendingRef.current.patch },
      };
      setSaveState("error");
      return false;
    }
  }, [queryClient]);

  const edit = useCallback(
    <K extends keyof DraftFields>(key: K, value: DraftFields[K]) => {
      const pid = loadedRef.current;
      if (!pid) return;
      setFields((f) => (f ? { ...f, [key]: value } : f));
      pendingRef.current = {
        productId: pid,
        patch: { ...pendingRef.current.patch, [key]: value },
      };
      setSaveState("dirty");
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => void sendPatch(), 800);
    },
    [sendPatch],
  );

  // 卸载时把未保存的 patch 送出（页面切换场景）
  useEffect(() => {
    return () => {
      const { productId, patch } = pendingRef.current;
      if (productId && Object.keys(patch).length) {
        void api.patchDraft(productId, patch).catch(() => {});
      }
    };
  }, []);

  const switchProduct = useCallback(
    (id: string) => {
      if (id === selectedRef.current) return;
      void sendPatch().finally(() => {
        loadedRef.current = id;
        pendingRef.current = { productId: id, patch: {} };
        setSelectedId(id);
        setParams(id ? { product: id } : {}, { replace: true });
        setFields(null);
        setBaseDraft(null);
      });
    },
    [sendPatch, setParams],
  );

  /* ---------- 字段级 AI ---------- */
  const runAi = useCallback(
    async (field: AiField, action: AiAction) => {
      const pid = loadedRef.current;
      if (!pid || !fields) return;
      setAiBusy(field);
      const key = AI_TO_FIELD[field];
      const oldValue = fields[key];
      try {
        const resp = await api.runAi(pid, {
          field,
          mode: action.mode,
          channel: action.channel,
        });
        queryClient.setQueryData(["draft", pid], resp);
        setBaseDraft(resp);
        const newValue = resp.fields[key];
        setFields((f) => (f ? { ...f, [key]: newValue } : f));
        // 服务端已写入 AI 结果：pending 里这个字段的旧值会把它覆盖回去，移除
        delete pendingRef.current.patch[key];
        setAiCards((c) => ({
          ...c,
          [field]: { kind: "ok", label: action.label, oldValue, newValue },
        }));
      } catch (e) {
        setAiCards((c) => ({
          ...c,
          [field]: {
            kind: "error",
            label: action.label,
            oldValue: null,
            newValue: e instanceof Error ? e.message : "AI 调用失败",
          },
        }));
      } finally {
        setAiBusy(null);
      }
    },
    [fields, queryClient],
  );

  const undoAi = useCallback(
    (field: AiField) => {
      const card = aiCards[field];
      const pid = loadedRef.current;
      if (!card || !pid) return;
      const key = AI_TO_FIELD[field];
      edit(key, card.oldValue as DraftFields[typeof key]);
      void sendPatch();
      setAiCards((c) => ({ ...c, [field]: undefined }));
    },
    [aiCards, edit, sendPatch],
  );

  const dismissAi = useCallback((field: AiField) => {
    setAiCards((c) => ({ ...c, [field]: undefined }));
  }, []);

  /* ---------- 右栏：渠道对照 ---------- */
  const previewShops = useMemo(
    () => (scope.shop ? [scope.shop] : scope.shops),
    [scope.shop, scope.shops],
  );
  const shopIdsKey = previewShops.map((s) => s.id).join(",");

  const previewQ = useQuery({
    queryKey: ["preview", selectedId, baseDraft?.updatedAt, shopIdsKey],
    queryFn: () => api.preview(selectedId!, previewShops.map((s) => s.id)),
    enabled: !!selectedId && previewShops.length > 0,
  });
  const checks = previewQ.data?.checks ?? [];

  const checkable = checks.filter(
    (c) => (c.ok && !unchecked.has(c.shopId)) || (!c.ok && forced.has(c.shopId)),
  );
  const skipped = checks.filter((c) => !c.ok && !forced.has(c.shopId));
  const doomed = checks.filter((c) => !c.ok && forced.has(c.shopId));

  const reauth = useMutation({
    mutationFn: (id: string) => api.reauthShop(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["shops"] });
      void queryClient.invalidateQueries({ queryKey: ["preview"] });
    },
  });

  const publishMut = useMutation({
    mutationFn: () =>
      api.publish(selectedId!, checkable.map((c) => c.shopId)),
    onSuccess: (detail) => {
      void queryClient.invalidateQueries({ queryKey: ["jobs"] });
      navigate(`/tasks/${detail.job.id}`);
    },
  });

  const doPublish = async () => {
    // 未保存的编辑先落库；保存失败就不发——否则发布会用到旧版主稿
    if (!(await sendPatch())) return;
    publishMut.mutate();
  };

  /* ---------- 弹层 ---------- */
  const [modal, setModal] = useState<"create" | "csv" | "link" | null>(null);
  const afterCreated = (p: Product) => {
    void queryClient.invalidateQueries({ queryKey: ["products"] });
    switchProduct(p.id);
  };

  /* ================= 渲染 ================= */
  const product = products.find((p) => p.id === selectedId) ?? null;

  return (
    <div className="pub">
      {/* ---------- 左栏 · 货 ---------- */}
      <section className="col">
        <div className="col-head">
          商品池
          <span className="col-count">{products.length}</span>
        </div>
        <div className="src-acts">
          <button type="button" className="btn sm" onClick={() => setModal("create")}>
            <Plus size={12} />
            新建
          </button>
          <button type="button" className="btn sm" onClick={() => setModal("csv")}>
            <Upload size={12} />
            CSV
          </button>
          <button type="button" className="btn sm" onClick={() => setModal("link")}>
            <Link2 size={12} />
            链接
          </button>
        </div>
        <div className="col-body">
          {productsQ.isPending ? (
            <Loading />
          ) : productsQ.isError ? (
            <Err error={productsQ.error} onRetry={() => productsQ.refetch()} />
          ) : products.length === 0 ? (
            <Empty>
              还没有可铺的商品。
              <br />
              导入表格，或贴一条货源链接。
            </Empty>
          ) : (
            products.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`pd-row${p.id === selectedId ? " sel" : ""}`}
                onClick={() => switchProduct(p.id)}
              >
                <Thumb src={p.images[0]} />
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="pd-title">{p.title}</div>
                  <div className="pd-sub">
                    <span className="tag">{SOURCE_NAME[p.source] ?? p.source}</span>
                    {p.variants.length} 变体
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      </section>

      {/* ---------- 中栏 · 主稿 ---------- */}
      <section className="col">
        <div className="col-head">
          主稿
          {product && (
            <span className="col-count" style={{ marginLeft: 0 }}>
              {product.title}
            </span>
          )}
          <span className="col-count">
            {saveState === "saving" ? (
              <St st="running">保存中…</St>
            ) : saveState === "dirty" ? (
              <St st="review">未保存</St>
            ) : saveState === "error" ? (
              <button type="button" className="chk-toggle" onClick={() => void sendPatch()}>
                保存失败 · 点击重试
              </button>
            ) : (
              <St st="success">已保存</St>
            )}
          </span>
        </div>
        <div className="col-body">
          {!selectedId ? (
            <Empty>从左侧选一个商品开始铺货</Empty>
          ) : draftQ.isPending || !fields ? (
            <Loading text="载入主稿…" />
          ) : draftQ.isError ? (
            <Err error={draftQ.error} onRetry={() => draftQ.refetch()} />
          ) : (
            <>
              {/* 主图（主稿字段，可增删——TikTok ≥5 张等校验走这里） */}
              <div className="fld">
                <div className="fld-label">
                  主图
                  <span className="fld-count">{(fields.images ?? []).length} 张</span>
                </div>
                <div className="imgstrip">
                  {(fields.images ?? []).map((src, i) => (
                    <span key={`${src}-${i}`} style={{ position: "relative" }}>
                      <Thumb src={src} lg />
                      <button
                        type="button"
                        className="icon-btn"
                        aria-label="删除此图"
                        style={{ position: "absolute", top: 2, right: 2 }}
                        onClick={() =>
                          edit("images", (fields.images ?? []).filter((_, j) => j !== i))
                        }
                      >
                        ×
                      </button>
                    </span>
                  ))}
                </div>
                <input
                  className="inp sm"
                  placeholder="粘贴图片 URL，回车加入主稿"
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.currentTarget.value.trim()) {
                      edit("images", [...(fields.images ?? []), e.currentTarget.value.trim()]);
                      e.currentTarget.value = "";
                      void sendPatch();
                    }
                  }}
                />
              </div>

              {/* 标题 */}
              <div className="fld">
                <div className="fld-label">
                  标题
                  {baseDraft?.aiFields.includes("title") && <span className="tag ai">AI</span>}
                  <span className="fld-count">{fields.title.length} 字</span>
                  <AiMenu field="title" busy={aiBusy !== null} onRun={(a) => void runAi("title", a)} />
                </div>
                <input
                  className="inp"
                  value={fields.title}
                  onChange={(e) => edit("title", e.target.value)}
                  onBlur={() => void sendPatch()}
                />
                {aiCards.title && (
                  <AiDiffCard card={aiCards.title} onUndo={() => undoAi("title")} onDismiss={() => dismissAi("title")} />
                )}
              </div>

              {/* 卖点 */}
              <div className="fld">
                <div className="fld-label">
                  卖点
                  {baseDraft?.aiFields.includes("bullets") && <span className="tag ai">AI</span>}
                  <AiMenu field="bullets" busy={aiBusy !== null} onRun={(a) => void runAi("bullets", a)} />
                </div>
                {fields.bullets.map((b, i) => (
                  <div key={i} className="rowline">
                    <input
                      className="inp sm"
                      value={b}
                      onChange={(e) =>
                        edit("bullets", fields.bullets.map((x, j) => (j === i ? e.target.value : x)))
                      }
                      onBlur={() => void sendPatch()}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="删除此条"
                      onClick={() => edit("bullets", fields.bullets.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() => edit("bullets", [...fields.bullets, ""])}
                >
                  <Plus size={12} /> 加一条卖点
                </button>
                {aiCards.bullets && (
                  <AiDiffCard card={aiCards.bullets} onUndo={() => undoAi("bullets")} onDismiss={() => dismissAi("bullets")} />
                )}
              </div>

              {/* 描述 */}
              <div className="fld">
                <div className="fld-label">
                  描述
                  {baseDraft?.aiFields.includes("description") && <span className="tag ai">AI</span>}
                  <AiMenu field="description" busy={aiBusy !== null} onRun={(a) => void runAi("description", a)} />
                </div>
                <textarea
                  className="inp"
                  rows={6}
                  value={fields.description}
                  onChange={(e) => edit("description", e.target.value)}
                  onBlur={() => void sendPatch()}
                />
                {aiCards.description && (
                  <AiDiffCard card={aiCards.description} onUndo={() => undoAi("description")} onDismiss={() => dismissAi("description")} />
                )}
              </div>

              {/* 类目 + 属性 */}
              <div className="fld">
                <div className="fld-label">
                  类目 / 属性
                  {baseDraft?.aiFields.includes("attributes") && <span className="tag ai">AI</span>}
                  <AiMenu field="attributes" busy={aiBusy !== null} onRun={(a) => void runAi("attributes", a)} />
                </div>
                <input
                  className="inp"
                  value={fields.category ?? ""}
                  placeholder="平台中性类目路径，如 女装/裙装/连衣裙"
                  onChange={(e) => edit("category", e.target.value || null)}
                  onBlur={() => void sendPatch()}
                />
                {Object.entries(fields.attributes).map(([k, v], i) => (
                  <div key={i} className="rowline">
                    <input
                      className="inp sm"
                      value={k}
                      placeholder="属性名"
                      style={{ maxWidth: "40%" }}
                      onChange={(e) =>
                        edit(
                          "attributes",
                          renameKey(fields.attributes, k, e.target.value),
                        )
                      }
                      onBlur={() => void sendPatch()}
                    />
                    <input
                      className="inp sm"
                      value={v}
                      placeholder="值"
                      onChange={(e) =>
                        edit("attributes", { ...fields.attributes, [k]: e.target.value })
                      }
                      onBlur={() => void sendPatch()}
                    />
                    <button
                      type="button"
                      className="icon-btn"
                      aria-label="删除属性"
                      onClick={() =>
                        edit("attributes", omitKey(fields.attributes, k))
                      }
                    >
                      ×
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn ghost sm"
                  style={{ alignSelf: "flex-start" }}
                  onClick={() =>
                    edit("attributes", { ...fields.attributes, "": "" })
                  }
                >
                  <Plus size={12} /> 加一条属性
                </button>
                {aiCards.attributes && (
                  <AiDiffCard card={aiCards.attributes} onUndo={() => undoAi("attributes")} onDismiss={() => dismissAi("attributes")} />
                )}
              </div>

              {/* 价格 */}
              <div className="fld">
                <div className="fld-label">
                  价格
                  {baseDraft?.aiFields.includes("pricing") && <span className="tag ai">AI</span>}
                  <AiMenu field="pricing" busy={aiBusy !== null} onRun={(a) => void runAi("pricing", a)} />
                </div>
                <div className="grid2">
                  <input
                    className="inp"
                    value={fields.price === 0 ? "" : String(fields.price)}
                    placeholder="售价"
                    inputMode="decimal"
                    onChange={(e) => edit("price", Number.parseFloat(e.target.value) || 0)}
                    onBlur={() => void sendPatch()}
                  />
                  <input
                    className="inp"
                    value={fields.compareAtPrice == null ? "" : String(fields.compareAtPrice)}
                    placeholder="划线价（可选）"
                    inputMode="decimal"
                    onChange={(e) =>
                      edit(
                        "compareAtPrice",
                        e.target.value === "" ? null : Number.parseFloat(e.target.value) || 0,
                      )
                    }
                    onBlur={() => void sendPatch()}
                  />
                </div>
                {aiCards.pricing && (
                  <AiDiffCard card={aiCards.pricing} onUndo={() => undoAi("pricing")} onDismiss={() => dismissAi("pricing")} />
                )}
              </div>

              {/* UPC */}
              <div className="fld">
                <div className="fld-label">UPC / 识别码</div>
                <input
                  className="inp"
                  value={fields.upc ?? ""}
                  placeholder="GTIN / EAN / UPC"
                  onChange={(e) => edit("upc", e.target.value || null)}
                  onBlur={() => void sendPatch()}
                />
              </div>

              {/* 变体（只读） */}
              {product && product.variants.length > 0 && (
                <div className="fld">
                  <div className="fld-label">
                    库存 / 变体
                    <span className="fld-count">只读 · 改货去商品页</span>
                  </div>
                  <table className="var-tbl">
                    <thead>
                      <tr>
                        <th>规格</th>
                        <th>价格</th>
                        <th>库存</th>
                        <th>UPC</th>
                      </tr>
                    </thead>
                    <tbody>
                      {product.variants.map((v, i) => (
                        <tr key={i}>
                          <td>{variantLabel(v)}</td>
                          <td>{v.price}</td>
                          <td>{v.stock}</td>
                          <td>{v.upc ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </section>

      {/* ---------- 右栏 · 渠道对照 ---------- */}
      <section className="col">
        <div className="col-head">
          渠道对照
          <span className="col-count">
            {scope.shop ? scope.shop.name : `${previewShops.length} 店`}
          </span>
        </div>
        <div className="col-body">
          {previewShops.length === 0 ? (
            <Empty icon={<Store size={20} />}>
              还没有店铺。
              <br />
              先去「店铺」页连接一间。
            </Empty>
          ) : !selectedId ? (
            <Empty>选中商品后这里显示各店能否发布</Empty>
          ) : previewQ.isPending ? (
            <Loading text="校验中…" />
          ) : previewQ.isError ? (
            <Err error={previewQ.error} onRetry={() => previewQ.refetch()} />
          ) : (
            checks.map((c) => (
              <CheckCard
                key={c.shopId}
                check={c}
                checked={checkable.some((x) => x.shopId === c.shopId)}
                onToggle={(on) => {
                  if (c.ok) {
                    setUnchecked((s) => {
                      const n = new Set(s);
                      if (on) n.delete(c.shopId);
                      else n.add(c.shopId);
                      return n;
                    });
                  } else {
                    setForced((s) => {
                      const n = new Set(s);
                      if (on) n.add(c.shopId);
                      else n.delete(c.shopId);
                      return n;
                    });
                  }
                }}
                onReauth={() => reauth.mutate(c.shopId)}
                reauthBusy={reauth.isPending}
              />
            ))
          )}
        </div>
        <div className="col-foot">
          <button
            type="button"
            className="cta"
            disabled={!selectedId || checkable.length === 0 || publishMut.isPending}
            onClick={() => void doPublish()}
          >
            {publishMut.isPending ? "创建任务…" : `铺到 ${checkable.length} 家店`}
          </button>
          {skipped.length > 0 && (
            <div className="cta-note">{skipped.length} 家店有问题已跳过</div>
          )}
          {doomed.length > 0 && (
            <div className="cta-note" style={{ color: "var(--st-partial)" }}>
              {doomed.length} 家问题店已强行勾选，发布后预计失败
            </div>
          )}
          {publishMut.isError && (
            <div className="cta-note" style={{ color: "var(--st-failed)" }}>
              {publishMut.error instanceof Error ? publishMut.error.message : "发布失败"}
            </div>
          )}
        </div>
      </section>

      {/* ---------- 弹层 ---------- */}
      {modal === "create" && (
        <CreateProductModal onClose={() => setModal(null)} onCreated={afterCreated} />
      )}
      {modal === "csv" && (
        <ImportCsvModal onClose={() => setModal(null)} onImported={(ps) => {
          void queryClient.invalidateQueries({ queryKey: ["products"] });
          if (ps[0]) switchProduct(ps[0].id);
        }} />
      )}
      {modal === "link" && (
        <LinkProductModal onClose={() => setModal(null)} onCreated={afterCreated} />
      )}
    </div>
  );
}

/* ---------- AI 前后值对照卡 ---------- */
function AiDiffCard({
  card,
  onUndo,
  onDismiss,
}: {
  card: AiCard;
  onUndo: () => void;
  onDismiss: () => void;
}) {
  if (card.kind === "error") {
    return (
      <div className="ai-diff" style={{ borderLeftColor: "var(--st-failed)" }}>
        <div className="ai-diff-head" style={{ color: "var(--st-failed)" }}>
          <Sparkles size={12} /> AI · {card.label} 失败
        </div>
        <div className="ai-diff-new" style={{ color: "var(--st-failed)" }}>
          {String(card.newValue)}
        </div>
        <div className="ai-diff-acts">
          <button type="button" className="btn ghost sm" onClick={onDismiss}>
            知道了
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="ai-diff">
      <div className="ai-diff-head">
        <Sparkles size={12} /> AI · {card.label} · 已写入主稿
      </div>
      <div className="ai-diff-old">{fmtVal(card.oldValue)}</div>
      <div className="ai-diff-new">{fmtVal(card.newValue)}</div>
      <div className="ai-diff-acts">
        <button type="button" className="btn ghost sm" onClick={onUndo}>
          还原
        </button>
        <button type="button" className="btn sm" onClick={onDismiss}>
          保留
        </button>
      </div>
    </div>
  );
}

/* ---------- 渠道对照卡 ---------- */
function CheckCard({
  check,
  checked,
  onToggle,
  onReauth,
  reauthBusy,
}: {
  check: ChannelCheck;
  checked: boolean;
  onToggle: (on: boolean) => void;
  onReauth: () => void;
  reauthBusy: boolean;
}) {
  const [open, setOpen] = useState(false);
  const authExpired = check.issues.some((i) => i.code === "auth_expired");
  const warns = check.issues.filter((i) => i.severity === "warn");
  const badCount = check.issues.length - warns.length;

  return (
    <div className="chk">
      <div className="chk-head">
        <input
          type="checkbox"
          className="chk-box"
          checked={checked}
          title={
            check.ok
              ? "勾选发布到此店"
              : "有问题——默认跳过，勾选则强行带上（预计失败）"
          }
          onChange={(e) => onToggle(e.target.checked)}
        />
        <PlatformBadge id={check.platform} />
        <b>{check.shopName}</b>
        <span className="chk-meta">
          {check.platform} · {check.site}
        </span>
      </div>
      <div className="chk-status">
        <span className="st-dot" data-st={check.ok ? "success" : authExpired ? "failed" : "review"} />
        {check.ok ? (
          <span>
            能发
            {warns.length > 0 && (
              <button
                type="button"
                className="chk-toggle"
                style={{ marginLeft: 8 }}
                onClick={() => setOpen((o) => !o)}
              >
                {warns.length} 个建议 {open ? "▴" : "▾"}
              </button>
            )}
          </span>
        ) : authExpired ? (
          <span style={{ flex: 1 }}>
            授权过期
            <button
              type="button"
              className="chk-toggle"
              style={{ marginLeft: 8 }}
              disabled={reauthBusy}
              onClick={onReauth}
            >
              <RefreshCw size={11} style={{ verticalAlign: -1 }} /> 重新授权
            </button>
          </span>
        ) : (
          <span>
            <button type="button" className="chk-toggle" onClick={() => setOpen((o) => !o)}>
              {badCount} 个问题 {open ? "▴" : "▾"}
            </button>
          </span>
        )}
      </div>
      {open && check.issues.length > 0 && (
        <div className="chk-issues">
          {check.issues.map((i, idx) => (
            <div key={idx} className="chk-issue">
              <span className="chk-issue-f">
                {i.severity === "warn" ? "建议 " : ""}
                {i.field}
              </span>
              <span>{i.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
