import { useState, type FormEvent } from "react";
import type { Product } from "@studio/shared";
import { api } from "../api.js";
import { Err, Modal } from "./ui.js";

/** 手工新建商品（铺货左栏与商品页共用）。 */
export function CreateProductModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: Product) => void;
}) {
  const [title, setTitle] = useState("");
  const [price, setPrice] = useState("");
  const [stock, setStock] = useState("0");
  const [image, setImage] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await api.createProduct({
        title: title.trim(),
        images: image.trim() ? [image.trim()] : [],
        variants: [
          {
            sku: "",
            options: {},
            price: Number.parseFloat(price) || 0,
            stock: Number.parseInt(stock, 10) || 0,
            upc: null,
          },
        ],
      });
      onCreated(p);
      onClose();
    } catch (e2) {
      setErr(e2);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="手工新建商品"
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="cp-form" className="btn primary" disabled={busy || !title.trim()}>
            {busy ? "创建中…" : "创建"}
          </button>
        </>
      }
    >
      <form id="cp-form" onSubmit={submit} style={{ display: "contents" }}>
        <div className="fld">
          <div className="fld-label">标题</div>
          <input
            className="inp"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="商品标题"
            autoFocus
          />
        </div>
        <div className="grid2">
          <div className="fld">
            <div className="fld-label">价格</div>
            <input
              className="inp"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              placeholder="0.00"
              inputMode="decimal"
            />
          </div>
          <div className="fld">
            <div className="fld-label">库存</div>
            <input
              className="inp"
              value={stock}
              onChange={(e) => setStock(e.target.value)}
              inputMode="numeric"
            />
          </div>
        </div>
        <div className="fld">
          <div className="fld-label">主图 URL（可选）</div>
          <input
            className="inp"
            value={image}
            onChange={(e) => setImage(e.target.value)}
            placeholder="https://…"
          />
        </div>
        {err != null && <Err error={err} />}
      </form>
    </Modal>
  );
}

/** 粘贴 CSV 导入（行级错误就地展示）。 */
export function ImportCsvModal({
  onClose,
  onImported,
}: {
  onClose: () => void;
  onImported: (created: Product[]) => void;
}) {
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  const [result, setResult] = useState<{
    created: Product[];
    errors: { row: number; message: string }[];
  } | null>(null);

  const submit = async () => {
    if (busy || !csv.trim()) return;
    setBusy(true);
    setErr(null);
    setResult(null);
    try {
      const r = await api.importCsv(csv);
      setResult(r);
      onImported(r.created);
      if (!r.errors.length) onClose();
    } catch (e2) {
      setErr(e2);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="导入 CSV"
      onClose={onClose}
      width={560}
      footer={
        <>
          <span className="mo-note" style={{ marginRight: "auto" }}>
            列：title, price, stock, sku, images, category
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            关闭
          </button>
          <button type="button" className="btn primary" disabled={busy || !csv.trim()} onClick={submit}>
            {busy ? "导入中…" : "导入"}
          </button>
        </>
      }
    >
      <div className="fld">
        <div className="fld-label">粘贴表格 / CSV 文本（首行可为表头）</div>
        <textarea
          className="inp"
          rows={8}
          value={csv}
          onChange={(e) => setCsv(e.target.value)}
          placeholder={"title,price,stock\n法式碎花连衣裙,39.9,300"}
          autoFocus
        />
      </div>
      {err != null && <Err error={err} />}
      {result && (
        <div className="fld">
          <div className="fld-label">
            已导入 {result.created.length} 条
            {result.errors.length > 0 && `，${result.errors.length} 行失败`}
          </div>
          {result.errors.length > 0 && (
            <div className="chk-issues">
              {result.errors.map((e) => (
                <div key={e.row} className="chk-issue">
                  <span className="chk-issue-f">第 {e.row} 行</span>
                  <span style={{ color: "var(--st-failed)" }}>{e.message}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

/** 从货源链接生成商品（mock 解析 1688/淘宝/天猫）。 */
export function LinkProductModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (p: Product) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);

  const submit = async () => {
    if (busy || !url.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const p = await api.productFromUrl(url.trim());
      onCreated(p);
      onClose();
    } catch (e2) {
      setErr(e2);
      setBusy(false);
    }
  };

  return (
    <Modal
      title="从链接生成"
      onClose={onClose}
      footer={
        <>
          <span className="mo-note" style={{ marginRight: "auto" }}>
            支持 1688 / 淘宝 / 天猫链接
          </span>
          <button type="button" className="btn ghost" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn primary" disabled={busy || !url.trim()} onClick={submit}>
            {busy ? "解析中…" : "生成草稿"}
          </button>
        </>
      }
    >
      <div className="fld">
        <div className="fld-label">货源链接</div>
        <input
          className="inp"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://detail.1688.com/offer/…"
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
      </div>
      {err != null && <Err error={err} />}
    </Modal>
  );
}
