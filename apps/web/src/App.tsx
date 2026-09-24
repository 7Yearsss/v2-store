import type { Product } from "@caiji/shared";
import { useEffect, useState } from "react";
import { pingExtension } from "./extensionBridge";

const S: Record<string, React.CSSProperties> = {
  page: { fontFamily: "system-ui", maxWidth: 960, margin: "0 auto", padding: 24 },
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
  img: { width: 160, height: 160, objectFit: "cover", borderRadius: 8 },
  pre: { background: "#f9fafb", padding: 12, borderRadius: 8, fontSize: 12, overflowX: "auto" },
  btn: { padding: "8px 14px", borderRadius: 8, border: "1px solid #d1d5db", background: "#fff", cursor: "pointer" },
};

export default function App() {
  const [products, setProducts] = useState<Product[]>([]);
  const [sel, setSel] = useState<Product | null>(null);
  const [ext, setExt] = useState<boolean | null>(null);

  useEffect(() => {
    fetch("/api/products").then((r) => r.json()).then(setProducts).catch(() => {});
    pingExtension().then(setExt);
  }, []);

  if (sel) {
    return (
      <div style={S.page}>
        <button style={S.btn} onClick={() => setSel(null)}>← 返回</button>
        <h2>{sel.title}</h2>
        <p style={S.muted}>
          {sel.sourcePlatform} · {sel.status} · {new Date(sel.collectedAt).toLocaleString()}
        </p>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {sel.images.slice(0, 5).map((u) => <img key={u} src={u} style={S.img} />)}
        </div>
        <h3>SKU ({sel.skus.length})</h3>
        <pre style={S.pre}>{JSON.stringify(sel.skus.slice(0, 20), null, 2)}</pre>
        <h3>属性</h3>
        <pre style={S.pre}>{JSON.stringify(sel.attributes, null, 2)}</pre>
        <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
          <button style={S.btn} disabled title="下一阶段">AI 处理</button>
          <button style={S.btn} disabled title="下一阶段">刊登</button>
        </div>
      </div>
    );
  }

  return (
    <div style={S.page}>
      <h1>商品库</h1>
      <p style={S.muted}>
        浏览器插件采集的商品会出现在这里。共 {products.length} 条。
        {ext !== null && (
          <span style={{ ...S.badge, marginLeft: 8, background: ext ? "#dcfce7" : "#fee2e2", color: ext ? "#15803d" : "#b91c1c" }}>
            {ext ? "插件已连接" : "插件未连接"}
          </span>
        )}
      </p>
      {products.map((p) => (
        <div key={p.id} style={S.row} onClick={() => setSel(p)}>
          {p.images[0] && <img src={p.images[0]} style={S.thumb} />}
          <div style={{ flex: 1 }}>
            <div>{p.title}</div>
            <div style={S.muted}>{p.priceText ?? `${p.skus.length} SKU`}</div>
          </div>
          <span style={S.badge}>{p.status}</span>
        </div>
      ))}
    </div>
  );
}
