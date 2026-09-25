import type { CollectedOffer, OfferSku } from "./index.js";

/** Pure 1688 offer-page parsing shared by the extension (page-side) and the
 * server (which re-parses harvested pageContent). */

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

/**
 * Quote bare object keys (`{98:"x", a_b:1}` → `{"98":"x","a_b":1}`) outside of
 * string literals, so JS object literals embedded in pages parse as JSON.
 * Never eval page content — this runs on the server against remote HTML.
 */
export function quoteBareKeys(src: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    out += ch;
    if (inString) {
      if (ch === "\\") {
        out += src[++i] ?? "";
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{" || ch === ",") {
      const m = /^(\s*)([A-Za-z_$0-9][\w$]*)(\s*):/.exec(src.slice(i + 1, i + 200));
      if (m) {
        out += `${m[1]}"${m[2]}"${m[3]}:`;
        i += m[0].length;
      }
    }
  }
  return out;
}

/** JSON.parse, retrying with bare keys quoted (JS object literal). */
export function parseLooseJson(text: string): any | null {
  const strict = tryParseJson(text);
  if (strict) return strict;
  try {
    return JSON.parse(quoteBareKeys(text));
  } catch {
    return null;
  }
}

const CONTEXT_MARKER = "(window.contextPath,{";

/**
 * 2025+ detail pages: `window.context=(function(b,d){…})(window.contextPath,{"result":…});`
 * — the second IIFE argument is plain JSON running to the end of the script.
 */
function findContextData(html: string): any | null {
  const at = html.indexOf(CONTEXT_MARKER);
  if (at === -1) return null;
  const start = at + CONTEXT_MARKER.length - 1;
  const end = html.indexOf("</script>", start);
  const chunk = html
    .slice(start, end === -1 ? undefined : end)
    .trim()
    .replace(/\)\s*;?\s*$/, "");
  return parseLooseJson(chunk);
}

/**
 * Pull the offer page's embedded data blob out of raw HTML: the current
 * `window.context` IIFE, or the legacy `window.__INIT_DATA = {...}`.
 */
export function findInitData(html: string): any | null {
  const ctx = findContextData(html);
  if (ctx) return ctx;
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

// --- page-data accessors (shapes seen in the wild) -------------------------
//
// current (2025+): window.context = { result: { global: { globalData: { model: {
//   offerDetail: { offerId, subject, imageList, skuProps, featureAttributes, leafCategoryName },
//   tradeModel:  { skuMap: [{ specAttrs, price, discountPrice, canBookCount, skuId, specId }], priceDisplay },
//   sellerModel: { companyName, loginId } } } } } }
// legacy:        window.__INIT_DATA = { globalData: { offerBaseInfo, skuModel, priceModel } }

/** The `model` object of the current detail-page format, if present. */
function getModel(data: any): any | null {
  const m =
    data?.result?.global?.globalData?.model ??
    data?.global?.globalData?.model ??
    data?.globalData?.model;
  return m?.offerDetail ? m : null;
}

/**
 * Strip a page-data blob down to the product parts before it leaves the
 * browser — the current format also carries the *viewer's* 1688 account
 * (buyerModel), which we must not ship to our server.
 */
export function productOnlyData(data: any): any {
  const model = getModel(data);
  if (!model) return data;
  const { offerDetail, tradeModel, sellerModel } = model;
  return { result: { global: { globalData: { model: { offerDetail, tradeModel, sellerModel } } } } };
}

function getSkuModel(data: any): any {
  return (
    data?.globalData?.skuModel ??
    data?.result?.data?.Root?.fields?.dataJson?.skuModel ??
    {}
  );
}

function getBaseInfo(data: any): any {
  const model = getModel(data);
  if (model) return model.offerDetail;
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
    base.imageList ??
    base.mainImageList ??
    base.images ??
    base.offerImgList ??
    data?.globalData?.images ??
    [];
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
  const list =
    getModel(data)?.offerDetail?.featureAttributes ??
    deepFind(data, ["productFeatureList", "featureList", "attributes"]);
  if (Array.isArray(list)) {
    for (const f of list) {
      const k = f?.name ?? f?.attributeName;
      const v =
        (Array.isArray(f?.values) && f.values.length ? f.values.join(",") : undefined) ??
        f?.value ??
        f?.attributeValue ??
        f?.valueStr;
      if (k && v) attrs[String(k)] = String(v);
    }
  }
  return attrs;
}

function extractSeller(data: any): string | undefined {
  const seller = getModel(data)?.sellerModel;
  if (seller) return seller.companyName ?? seller.loginId ?? undefined;
  const g = data?.globalData ?? {};
  return (
    g?.sellerLoginId ??
    g?.shareModel?.companyName ??
    deepFind(data, ["companyInfo"])?.companyName ??
    undefined
  );
}

/** "红色&gt;M" + skuProps → "颜色:红色 / 尺码:M" */
function specText(key: string, props: any[]): string {
  return String(key)
    .split(/&gt;|[>;]/)
    .map((v: string, i: number) => {
      const prop = props[i]?.prop ?? props[i]?.name ?? `规格${i + 1}`;
      return `${prop}:${String(v).trim()}`;
    })
    .join(" / ");
}

/** spec key(如 "红色>M") 的首规格值 → skuProps 里对应值的 imageUrl。 */
function skuImage(key: string, props: any[]): string | undefined {
  const candidates = String(key)
    .split(/&gt;|[>;]/)
    .map((seg) => {
      const v = seg.split(":");
      return (v[1] ?? v[0]).trim();
    })
    .filter(Boolean);
  for (const prop of props) {
    const values = Array.isArray(prop?.value)
      ? prop.value
      : Array.isArray(prop?.values)
        ? prop.values
        : [];
    for (const cand of candidates) {
      const hit = values.find(
        (v: any) => String(v?.name ?? v?.value ?? v?.specName ?? "").trim() === cand,
      );
      const img = hit?.imageUrl ?? hit?.image ?? hit?.imgUrl ?? hit?.picUrl;
      if (img) return String(img);
    }
  }
  return undefined;
}

function toSku(key: string, r: any, props: any[]): OfferSku {
  const price = Number(r?.discountPrice || r?.price || r?.salePrice || NaN);
  const image = skuImage(key, props) ?? skuImage(String(r?.specAttrs ?? ""), props);
  return {
    skuId: String(r?.specId ?? r?.skuId ?? key),
    spec: specText(key, props) || String(key),
    priceCny: Number.isFinite(price) ? price : undefined,
    stock: Number(r?.canBookCount ?? r?.amountOnSale ?? r?.stock ?? NaN) || undefined,
    image,
  };
}

function extractSkus(data: any): OfferSku[] {
  const model = getModel(data);
  if (model) {
    const props: any[] = Array.isArray(model.offerDetail?.skuProps)
      ? model.offerDetail.skuProps
      : [];
    const skuMap = model.tradeModel?.skuMap;
    const rows: Array<[string, any]> = Array.isArray(skuMap)
      ? skuMap.map((r: any) => [String(r?.specAttrs ?? r?.skuId ?? ""), r])
      : Object.entries(skuMap ?? {});
    return rows.filter(([k]) => k).map(([k, r]) => toSku(k, r, props));
  }
  const skuModel = getSkuModel(data);
  const props: any[] = Array.isArray(skuModel?.skuProps) ? skuModel.skuProps : [];
  return Object.entries(skuModel?.skuInfoMap ?? {}).map(([k, r]) => toSku(k, r, props));
}

/**
 * 1688 详情页 offerDetail.descUrl / detailUrl：详情区 HTML 的拉取地址
 * （插件 background 拉它解析长图；同域页面请求，不经过 CORS）。
 */
export function descUrlFromData(data: any): string | undefined {
  const detail = getModel(data)?.offerDetail ?? getBaseInfo(data) ?? {};
  const u =
    detail.descUrl ?? detail.detailUrl ?? detail.descriptionUrl ?? detail.desc_url;
  const s = normalizeUrl(u);
  return s.startsWith("http") ? s : undefined;
}

const IMG_TAG_RE = /<img[^>]+?(?:data-src|data-lazyload-src|data-ks-lazyload|src)\s*=\s*["']([^"']+)["']/gi;
const SKIP_IMG = /logo|sprite|icon|blank\.gif|search-lazyload/i;

/** Detail/desc HTML → ordered unique image urls. */
export function descImagesFromHtml(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(IMG_TAG_RE)) {
    const u = normalizeUrl(m[1]);
    if (!u.startsWith("http") || SKIP_IMG.test(u) || out.includes(u)) continue;
    out.push(u);
  }
  return out;
}

function extractPriceText(data: any): string | undefined {
  const trade = getModel(data)?.tradeModel;
  if (trade) {
    const { minPrice, maxPrice, priceDisplay } = trade;
    if (minPrice && maxPrice && minPrice !== maxPrice) return `${minPrice}-${maxPrice}`;
    return String(priceDisplay ?? minPrice ?? "") || undefined;
  }
  const priceModel = data?.globalData?.priceModel ?? data?.globalData?.orderParamModel ?? {};
  const p = priceModel?.price ?? priceModel?.currentPrice;
  return p ? String(p) : undefined;
}

/** Normalize a parsed window.context / __INIT_DATA blob into our CollectedOffer. */
export function normalizeOffer(
  data: any,
  offerIdHint?: string,
  url?: string,
): CollectedOffer {
  const base = getBaseInfo(data);
  const offerId = String(base?.offerId ?? base?.id ?? offerIdHint ?? "") || undefined;
  const detail = getModel(data)?.offerDetail;
  const category = detail?.leafCategoryName;
  const categoryId = detail?.leafCategoryId ?? detail?.categoryId ?? detail?.cid;
  return {
    sourcePlatform: "1688",
    sourceUrl:
      url ??
      (offerId ? `https://detail.1688.com/offer/${offerId}.html` : ""),
    offerId,
    title: extractTitle(data),
    priceText: extractPriceText(data),
    skus: extractSkus(data),
    images: extractImages(data),
    attributes: extractAttributes(data),
    categoryId: categoryId ? String(categoryId) : undefined,
    categoryPath: category ? [String(category)] : undefined,
    sellerName: extractSeller(data),
    collectedAt: new Date().toISOString(),
  };
}
