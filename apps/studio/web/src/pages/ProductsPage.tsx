import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link2, PackageSearch, Plus, Upload } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import type { Product } from "@studio/shared";
import { api } from "../api.js";
import { CreateProductModal, ImportCsvModal } from "../components/productModals.js";
import {
  Empty,
  Err,
  Loading,
  SOURCE_NAME,
  St,
  Thumb,
  fmtTime,
} from "../components/ui.js";

/** /products —— 货源主数据密表 */
export function ProductsPage() {
  const queryClient = useQueryClient();
  const [q, setQ] = useState("");
  const [qDeb, setQDeb] = useState("");
  const [modal, setModal] = useState<"create" | "csv" | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  const productsQ = useQuery({
    queryKey: ["products", qDeb],
    queryFn: () => api.products(qDeb || undefined),
  });
  const items = useMemo(() => productsQ.data?.items ?? [], [productsQ.data]);

  // 主稿状态点：对当前列表逐商品拉一次 draft（demo 量级可接受）
  const idsKey = items.map((p) => p.id).join(",");
  const draftsQ = useQuery({
    queryKey: ["draft-status", idsKey],
    enabled: items.length > 0,
    queryFn: async () => {
      const entries = await Promise.all(
        items.map(async (p) => [p.id, (await api.draft(p.id)).status] as const),
      );
      return Object.fromEntries(entries) as Record<string, string>;
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.deleteProduct(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["products"] }),
  });

  return (
    <div className="pg">
      <div className="pg-head">
        <input
          className="inp"
          style={{ maxWidth: 280 }}
          placeholder="搜索商品标题…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="pg-spacer" />
        <button type="button" className="btn" onClick={() => setModal("csv")}>
          <Upload size={14} /> 导入 CSV
        </button>
        <button type="button" className="btn primary" onClick={() => setModal("create")}>
          <Plus size={14} /> 新建商品
        </button>
      </div>

      {productsQ.isPending ? (
        <Loading />
      ) : productsQ.isError ? (
        <Err error={productsQ.error} onRetry={() => productsQ.refetch()} />
      ) : items.length === 0 ? (
        <Empty icon={<PackageSearch size={20} />}>
          {qDeb ? `没有匹配「${qDeb}」的商品` : "还没有商品。新建一个，或导入表格。"}
        </Empty>
      ) : (
        <div className="tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th style={{ width: 44 }}></th>
                <th>标题</th>
                <th>来源</th>
                <th>变体</th>
                <th>主稿</th>
                <th>创建时间</th>
                <th className="t-act">操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((p) => (
                <ProductRow
                  key={p.id}
                  p={p}
                  draftSt={draftsQ.data?.[p.id]}
                  onDelete={() => {
                    if (window.confirm(`删除「${p.title}」？其主稿一并删除。`)) {
                      del.mutate(p.id);
                    }
                  }}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {modal === "create" && (
        <CreateProductModal
          onClose={() => setModal(null)}
          onCreated={() => queryClient.invalidateQueries({ queryKey: ["products"] })}
        />
      )}
      {modal === "csv" && (
        <ImportCsvModal
          onClose={() => setModal(null)}
          onImported={() => queryClient.invalidateQueries({ queryKey: ["products"] })}
        />
      )}
    </div>
  );
}

function ProductRow({
  p,
  draftSt,
  onDelete,
}: {
  p: Product;
  draftSt: string | undefined;
  onDelete: () => void;
}) {
  return (
    <tr>
      <td>
        <Thumb src={p.images[0]} />
      </td>
      <td style={{ maxWidth: 0 }}>
        <div style={{ maxWidth: 380, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {p.title}
        </div>
        {p.sourceUrl && (
          <div style={{ color: "var(--text-tertiary)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 380 }}>
            {p.sourceUrl}
          </div>
        )}
      </td>
      <td>
        <span className="tag">{SOURCE_NAME[p.source] ?? p.source}</span>
        {p.source === "link" && <Link2 size={11} style={{ marginLeft: 4, verticalAlign: -1, color: "var(--text-tertiary)" }} />}
      </td>
      <td>{p.variants.length}</td>
      <td>
        <St st={draftSt ?? "draft"}>{draftSt === "ready" ? "就绪" : "草稿"}</St>
      </td>
      <td style={{ color: "var(--text-tertiary)" }}>{fmtTime(p.createdAt)}</td>
      <td className="t-act">
        <Link className="t-link" to={`/publish?product=${p.id}`} style={{ marginRight: 12 }}>
          去铺货
        </Link>
        <button type="button" className="btn ghost sm danger" onClick={onDelete}>
          删除
        </button>
      </td>
    </tr>
  );
}
