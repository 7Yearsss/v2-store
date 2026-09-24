import type { CollectedOffer, OfferSku } from "@caiji/shared";

/** Pure 1688 offer-page parsing shared by MAIN-world collector and background. */

export function tryParseJson(text: string): any | null {
  if (!text || typeof text !== "string") return null;
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/^\s*\w+\s*\(([\s\S]*)\)\s*;?\s*$/); // JSONP wrapper
    if (!m) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }
}

/** Pull `window.__INIT_DATA = {...}` out of raw offer-page HTML. */
export function findInitData(html: string): any | null {
  const patterns = [
    /window\.__INIT_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
    /window\.__INIT_DATA\s*=\s*(\{[\s\S]*?\})\s*;/i,
    /__INIT_DATA\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m?.[1]) {
      const parsed = tryParseJson(m[1]);
      if (parsed) return parsed;
    }
  }
  return null;
}

/** Depth-limited deep search for the first value held under any of `keys`. */
export function deepFind(obj: unknown, keys: string[], depth = 0): any {
  if (!obj || depth > 8 || typeof obj !== "object") return undefined;
  const rec = obj as Record<string, unknown>;
  for (const k of keys) {
    if (k in rec && rec[k] != null && typeof rec[k] === "object") return rec[k];
  }
  for (const v of Object.values(rec)) {
    const hit = deepFind(v, keys, depth + 1);
    if (hit) return hit;
  }
  return undefined;
}

/** Locate a shop offer list: array of objects with id/offerId + subject/price fields. */
export function findOfferList(obj: unknown, depth = 0): any[] | null {
  if (!obj || depth > 8 || typeof obj !== "object") return null;
  if (Array.isArray(obj)) {
    const first = obj[0];
    return obj.length &&
      first &&
      typeof first === "object" &&
      (first.id != null || first.offerId != null) &&
      (first.subject != null ||
        first.offerImages != null ||
        first.offerPrice != null)
      ? obj
      : null;
  }
  const rec = obj as Record<string, unknown>;
  if (Array.isArray(rec.offerList) && rec.offerList.length) {
    return rec.offerList as any[];
  }
  for (const v of Object.values(rec)) {
    const hit = findOfferList(v, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function normalizeUrl(u: unknown): string {
  if (!u || typeof u !== "string") return "";
  const s = u.trim().replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/");
  return s ? (s.startsWith("//") ? `https:${s}` : s) : "";
}

// --- page-data accessors (two shapes seen in the wild) --------------------

function getSkuModel(data: any): any {
  return (
    data?.globalData?.skuModel ??
    data?.result?.data?.Root?.fields?.dataJson?.skuModel ??
    {}
  );
}

function getBaseInfo(data: any): any {
  const g = data?.globalData ?? {};
  return g.offerBaseInfo ?? g.tempModel ?? g.model?.offerBaseInfo ?? {};
}

function extractTitle(data: any): string {
  const base = getBaseInfo(data);
  return String(
    base.subject ??
      base.offerTitle ??
      base.title ??
      data?.globalData?.tempModel?.offerTitle ??
      "",
  ).trim();
}

function extractImages(data: any): string[] {
  const base = getBaseInfo(data);
  const list =
    base.imageList ?? base.images ?? base.offerImgList ?? data?.globalData?.images ?? [];
  const out: string[] = [];
  if (Array.isArray(list)) {
    for (const item of list) {
      const u = normalizeUrl(
        typeof item === "string"
          ? item
          : item?.fullPathImageURI ?? item?.imageUrl ?? item?.url ?? item?.imgUrl ?? item?.src,
      );
      if (u && !out.includes(u)) out.push(u);
    }
  }
  return out;
}

function extractAttributes(data: any): Record<string, string> {
  const attrs: Record<string, string> = {};
  const list = deepFind(data, [
    "productFeatureList",
    "featureList",
    "attributes",
  ]);
  if (Array.isArray(list)) {
    for (const f of list) {
      const k = f?.name ?? f?.attributeName;
      const v = f?.value ?? f?.attributeValue ?? f?.valueStr;
      if (k && v) attrs[String(k)] = String(v);
    }
  }
  return attrs;
}

function extractSeller(data: any): string | undefined {
  const g = data?.globalData ?? {};
  return (
    g?.sellerLoginId ??
    g?.shareModel?.companyName ??
    deepFind(data, ["companyInfo"])?.companyName ??
    undefined
  );
}

function extractSkus(data: any): OfferSku[] {
  const skuModel = getSkuModel(data);
  const infoMap = skuModel?.skuInfoMap ?? {};
  const props: any[] = Array.isArray(skuModel?.skuProps) ? skuModel.skuProps : [];
  const out: OfferSku[] = [];
  for (const [key, row] of Object.entries(infoMap)) {
    const r = row as any;
    const price = Number(r?.discountPrice ?? r?.price ?? r?.salePrice ?? NaN);
    const spec = String(key)
      .split(/[>;]/)
      .map((v: string, i: number) => {
        const prop = props[i]?.prop ?? props[i]?.name ?? `规格${i + 1}`;
        return `${prop}:${String(v).trim()}`;
      })
      .join(" / ");
    out.push({
      skuId: String(r?.specId ?? r?.skuId ?? key),
      spec: spec || String(key),
      priceCny: Number.isFinite(price) ? price : undefined,
      stock: Number(r?.canBookCount ?? r?.amountOnSale ?? r?.stock ?? NaN) || undefined,
    });
  }
  return out;
}

/** Normalize a parsed __INIT_DATA/context blob into our CollectedOffer. */
export function normalizeOffer(
  data: any,
  offerIdHint?: string,
  url?: string,
): CollectedOffer {
  const offerId =
    String(getBaseInfo(data)?.offerId ?? getBaseInfo(data)?.id ?? offerIdHint ?? "") ||
    undefined;
  const priceModel = data?.globalData?.priceModel ?? data?.globalData?.orderParamModel ?? {};
  const priceText = priceModel?.price ?? priceModel?.currentPrice ?? undefined;
  return {
    sourcePlatform: "1688",
    sourceUrl:
      url ??
      (offerId ? `https://detail.1688.com/offer/${offerId}.html` : ""),
    offerId,
    title: extractTitle(data),
    priceText: priceText ? String(priceText) : undefined,
    skus: extractSkus(data),
    images: extractImages(data),
    attributes: extractAttributes(data),
    sellerName: extractSeller(data),
    collectedAt: new Date().toISOString(),
  };
}
