import type { Product, ProductStatus } from "@caiji/shared";
import { useEffect, useMemo, useState } from "react";
import { collectOfferById, pingExtension } from "./extensionBridge";

const S: Record<string, React.CSSProperties> = {
  page: { fontFamily: "system-ui", maxWidth: 1100, margin: "0 auto", padding: 24 },
  row: {
    display: "flex",
    gap: 12,
    padding: "10px 0",
    borderBottom: "1px solid #eee",
    cursor: "pointer",
    alignItems: "center",
  },
  thumb: { width: 56, height: 56, objectFit: "cover", borderRadius: 6, background: "#f3f4f6" },
  badge: { fontSize: 12, padding: "2px 8px", borderRadius: 10, background: "#e0f2fe", color: "#0369a1" },
  muted: { color: "#9ca3af", fontSize: 13 },
  img: { width: 120, height: 120, objectFit: "cover", borderRadius: 8 },
  btn: { padding: "8px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" },
  btnPrimary: { padding: "8px 14px", borderRadius: 8, border: "none", background: "#f97316", color: "#fff", cursor: "pointer" },
  input: { padding: "8px 10px", borderRadius: 8, border: "1px solid #d1d5db", fontSize: 14 },
  textarea: { width: "100%", padding: 10, borderRadius: 8, border: "1px solid #d1d5db", fontSize: 14, fontFamily: "inherit" },
  label: { fontSize: 13, color: "#6b7280", marginBottom: 4 },
  table: { borderCollapse: "collapse", width: "100%", fontSize: 13 },
  cell: { border: "1px solid #e5e7eb", padding: "6px 8px" },
  tab: { padding: "6px 14px", borderRadius: 8, border: "none", cursor: "pointer", fontSize: 13 },
};

const STATUS_LABEL: Record<ProductStatus, string> = {
  draft: "采集箱",
  processed: "已加工",
  listed: "已刊登",
};

function extractOfferId(input: string): string | null {
  const t = input.trim();
  const m = t.match(/offer\/(\d+)/) ?? t.match(/[?&]offerId=(\d+)/) ?? (/^\d{6,}$/.test(t) ? [t] : null);
  return m?.[1] ?? (typeof m?.[0] === "string" ? m[0] : null);
}

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [sel, setSel] = useState<Product | null>(null);
  const [ext, setExt] = useState<boolean | null>(null);
  const [filter, setFilter] = useState<ProductStatus | "all">("all");
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  const reload = () =>
    fetch("/api/products").then((r) => r.json()).then(setProducts).catch(() => {});

  useEffect(() => {
    reload();
    pingExtension().then(setExt);
  }, []);

  const shown = useMemo(
    () => products.filter((p) => filter === "all" || p.status === filter),
    [products, filter],
  );

  async function collectByLink() {
    const offerId = extractOfferId(link);
    if (!offerId) {
      setNotice("贴 1688 商品链接或 offerId");
      return;
    }
    setBusy(true);
    try {
      await collectOfferById(offerId);
      setNotice("采集成功");
      setLink("");
      await reload();
    } catch (e) {
      setNotice(`采集失败：${e instanceof Error ? e.message : e}`);
    } finally {
      setBusy(false);
    }
  }

  if (sel) {
    return (
      <Detail
        product={sel}
        onBack={() => setSel(null)}
        onSaved={(p) => {
          setSel(p);
          reload();
        }}
      />
    );
  }

  return (
    <div style={S.page}>
      <h1>商品库</h1>
      <p style={S.muted}>
        插件采集的商品进采集箱。共 {products.length} 条。
        {ext !== null && (
          <span style={{ ...S.badge, marginLeft: 8, background: ext ? "#dcfce7" : "#fee2e2", color: ext ? "#15803d" : "#b91c1c" }}>
            {ext ? "插件已连接" : "插件未连接"}
          </span>
        )}
      </p>

      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          style={{ ...S.input, flex: 1 }}
          placeholder="贴 1688 链接 / offerId，走插件采集"
          value={link}
          onChange={(e) => setLink(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && collectByLink()}
        />
        <button style={S.btnPrimary} disabled={busy || !ext} onClick={collectByLink}>
          {busy ? "采集中…" : "链接采集"}
        </button>
      </div>
      {notice && <p style={S.muted}>{notice}</p>}

      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        {(["all", "draft", "processed", "listed"] as const).map((s) => (
          <button
            key={s}
            style={{
              ...S.tab,
              background: filter === s ? "#111827" : "#f3f4f6",
              color: filter === s ? "#fff" : "#374151",
            }}
            onClick={() => setFilter(s)}
          >
            {s === "all" ? `全部 ${products.length}` : STATUS_LABEL[s]}
          </button>
        ))}
      </div>

      {shown.map((p) => (
        <div key={p.id} style={S.row} onClick={() => setSel(p)}>
          {p.images[0] ? <img src={p.images[0]} style={S.thumb} /> : <div style={S.thumb} />}
          <div style={{ flex: 1 }}>
            <div>{p.aiTitle || p.title}</div>
            <div style={S.muted}>
              {p.priceText ?? `${p.skus.length} SKU`}
              {p.targetChannel ? ` → ${p.targetChannel}` : ""}
            </div>
          </div>
          <span style={S.badge}>{STATUS_LABEL[p.status]}</span>
        </div>
      ))}
      {!shown.length && <p style={S.muted}>暂无商品</p>}
    </div>
  );
}

function Detail({
  product,
  onBack,
  onSaved,
}: {
  product: Product;
  onBack: () => void;
  onSaved: (p: Product) => void;
}) {
  const [draft, setDraft] = useState(product);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(draft) !== JSON.stringify(product);

  const set = (patch: Partial<Product>) => setDraft((d) => ({ ...d, ...patch }));
  const setSku = (i: number, patch: Partial<Product["skus"][number]>) =>
    set({ skus: draft.skus.map((s, j) => (j === i ? { ...s, ...patch } : s)) });

  async function save(patch: Partial<Product> = {}) {
    setSaving(true);
    try {
      const res = await fetch(`/api/products/${product.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...draft, ...patch }),
      });
      if (res.ok) onSaved(await res.json());
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={S.page}>
      <button style={S.btn} onClick={onBack}>← 返回</button>

      <div style={{ display: "flex", gap: 12, alignItems: "center", margin: "12px 0" }}>
        <span style={S.badge}>{STATUS_LABEL[draft.status]}</span>
        <span style={S.muted}>
          {draft.sourcePlatform} · {new Date(draft.collectedAt).toLocaleString()} ·{" "}
          <a href={draft.sourceUrl} target="_blank" rel="noreferrer">源链接</a>
        </span>
        <div style={{ flex: 1 }} />
        <label style={S.label}>认领至</label>
        <select
          style={S.input}
          value={draft.targetChannel ?? ""}
          onChange={(e) =>
            set({ targetChannel: (e.target.value || undefined) as Product["targetChannel"] })
          }
        >
          <option value="">未认领</option>
          <option value="shopify">Shopify</option>
          <option value="shopee">Shopee</option>
          <option value="tiktok">TikTok Shop</option>
          <option value="woocommerce">WooCommerce</option>
        </select>
      </div>

      <div style={{ marginBottom: 12 }}>
        <div style={S.label}>原始标题</div>
        <input style={{ ...S.input, width: "100%" }} value={draft.title} onChange={(e) => set({ title: e.target.value })} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={S.label}>AI 标题（刊登用）</div>
        <input style={{ ...S.input, width: "100%" }} value={draft.aiTitle ?? ""} onChange={(e) => set({ aiTitle: e.target.value })} placeholder="待 AI 管线生成，可手改" />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={S.label}>AI 描述</div>
        <textarea style={S.textarea} rows={4} value={draft.aiDescription ?? ""} onChange={(e) => set({ aiDescription: e.target.value })} />
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {draft.images.slice(0, 6).map((u) => <img key={u} src={u} style={S.img} />)}
      </div>

      <h3>SKU ({draft.skus.length})</h3>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={{ ...S.cell, textAlign: "left" }}>规格</th>
            <th style={{ ...S.cell, textAlign: "left" }}>价格 ¥</th>
            <th style={{ ...S.cell, textAlign: "left" }}>库存</th>
          </tr>
        </thead>
        <tbody>
          {draft.skus.slice(0, 50).map((sku, i) => (
            <tr key={sku.skuId ?? i}>
              <td style={S.cell}>{sku.spec}</td>
              <td style={S.cell}>
                <input
                  style={{ ...S.input, width: 90, padding: "4px 6px" }}
                  value={sku.priceCny ?? ""}
                  onChange={(e) => setSku(i, { priceCny: Number(e.target.value) || undefined })}
                />
              </td>
              <td style={S.cell}>{sku.stock ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>属性</h3>
      <table style={S.table}>
        <tbody>
          {Object.entries(draft.attributes).map(([k, v]) => (
            <tr key={k}>
              <td style={{ ...S.cell, width: 160, color: "#6b7280" }}>{k}</td>
              <td style={S.cell}>{v}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ display: "flex", gap: 8, marginTop: 20 }}>
        <button style={S.btnPrimary} disabled={saving || !dirty} onClick={() => save()}>
          {saving ? "保存中…" : "保存修改"}
        </button>
        {draft.status === "draft" && (
          <button style={S.btn} disabled={saving} onClick={() => save({ status: "processed", processedAt: new Date().toISOString() })}>
            标记已加工
          </button>
        )}
        {draft.status === "processed" && (
          <button style={S.btn} disabled={saving || !draft.targetChannel} title={draft.targetChannel ? "" : "先认领渠道"} onClick={() => save({ status: "listed" })}>
            标记已刊登
          </button>
        )}
      </div>
    </div>
  );
}
