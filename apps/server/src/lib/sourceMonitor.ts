import { createHash } from "node:crypto";
import type {
  CollectedOffer,
  OfferSku,
  SourceChangeType,
  StoreRules,
} from "@caiji/shared";

/** 货源行里参与 diff 的字段快照（source_items 旧值）。 */
export interface SourceSnapshot {
  title: string;
  images: string[];
  descImages: string[];
  attributes: Record<string, string>;
  skus: OfferSku[];
}

export interface SourceChangeDraft {
  changeType: SourceChangeType;
  skuId: string | null;
  oldValue: unknown;
  newValue: unknown;
  fingerprint: string;
}

/** 同指纹的未消费变更不重复落库。 */
export function changeFingerprint(
  changeType: SourceChangeType,
  skuId: string | null,
  oldValue: unknown,
  newValue: unknown,
): string {
  return createHash("sha256")
    .update(JSON.stringify([changeType, skuId ?? null, oldValue ?? null, newValue ?? null]))
    .digest("hex");
}

const skuKey = (s: OfferSku) => s.skuId || s.spec;

/** prev（source_items 旧行）vs 本次采集的 offer → 字段级变更草稿。
 *  price/stock 按 sku 粒度；title/images/attributes 整品一条；delisted 不在这里
 *  （由 /collect/report 的 availability 翻转产生）。 */
export function diffSourceItem(
  prev: SourceSnapshot,
  offer: CollectedOffer,
): SourceChangeDraft[] {
  const out: SourceChangeDraft[] = [];
  const push = (
    changeType: SourceChangeType,
    skuId: string | null,
    oldValue: unknown,
    newValue: unknown,
  ) =>
    out.push({
      changeType,
      skuId,
      oldValue,
      newValue,
      fingerprint: changeFingerprint(changeType, skuId, oldValue, newValue),
    });

  if (prev.title !== offer.title) push("title", null, prev.title, offer.title);

  const prevImages = [...prev.images, ...prev.descImages];
  const nextImages = [...offer.images, ...(offer.descImages ?? [])];
  if (JSON.stringify(prevImages) !== JSON.stringify(nextImages)) {
    push(
      "images",
      null,
      { images: prev.images, descImages: prev.descImages },
      { images: offer.images, descImages: offer.descImages ?? [] },
    );
  }

  const changedAttrKeys = new Set([
    ...Object.keys(prev.attributes),
    ...Object.keys(offer.attributes),
  ]);
  const oldAttrs: Record<string, string | null> = {};
  const newAttrs: Record<string, string | null> = {};
  for (const k of changedAttrKeys) {
    const o = prev.attributes[k] ?? null;
    const n = offer.attributes[k] ?? null;
    if (o !== n) {
      oldAttrs[k] = o;
      newAttrs[k] = n;
    }
  }
  if (Object.keys(oldAttrs).length) push("attributes", null, oldAttrs, newAttrs);

  const prevByKey = new Map(prev.skus.map((s) => [skuKey(s), s]));
  const nextByKey = new Map(offer.skus.map((s) => [skuKey(s), s]));
  for (const [key, n] of nextByKey) {
    const p = prevByKey.get(key);
    if (!p) {
      // 新增 SKU：没有对应刊登变体，记一条库存变更让关注页能看到
      push("stock", key, null, { spec: n.spec, stock: n.stock, priceCny: n.priceCny });
      continue;
    }
    if ((p.priceCny ?? null) !== (n.priceCny ?? null)) {
      push("price", key, { spec: p.spec, priceCny: p.priceCny }, { spec: n.spec, priceCny: n.priceCny });
    }
    if ((p.stock ?? null) !== (n.stock ?? null)) {
      push("stock", key, { spec: p.spec, stock: p.stock }, { spec: n.spec, stock: n.stock });
    }
  }
  for (const [key, p] of prevByKey) {
    if (!nextByKey.has(key)) {
      // 货源撤掉了该 SKU：视为该 SKU 库存归零（不可再卖）
      push("stock", key, { spec: p.spec, stock: p.stock }, null);
    }
  }
  return out;
}

export type InventoryRules = NonNullable<StoreRules["inventory"]>;
export type MonitorRules = NonNullable<StoreRules["monitor"]>;

/** 仓储 L1：货源库存 → 推送渠道库存的策略变换（mirror|fixed|percent|cap）再减 buffer。 */
export function pushQuantity(
  sourceStock: number | undefined,
  inv?: InventoryRules,
): number {
  const src = sourceStock ?? 0;
  let q: number;
  switch (inv?.strategy ?? "mirror") {
    case "fixed":
      q = inv?.fixedQty ?? src;
      break;
    case "percent":
      q = Math.floor(src * (inv?.percent ?? 1));
      break;
    case "cap":
      q = Math.min(src, inv?.cap ?? src);
      break;
    default:
      q = src;
  }
  return Math.max(0, q - (inv?.buffer ?? 0));
}

/** 货源售罄判定：整品下架，或所有 sku 库存 ≤ minStock（监控阈值）。 */
export function isSourceOos(
  availability: "ok" | "delisted",
  skus: OfferSku[],
  monitor?: MonitorRules,
): boolean {
  if (availability === "delisted") return true;
  const min = monitor?.minStock;
  if (min == null) return false;
  if (!skus.length) return false;
  return skus.every((s) => (s.stock ?? 0) <= min);
}
