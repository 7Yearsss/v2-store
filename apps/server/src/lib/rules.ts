import type { OfferSku, StoreRules } from "@caiji/shared";

/**
 * 采集预处理规则（认领时应用）与发布前检查（发布时拦截）的纯函数。
 * StoreRules 全字段可选；未设置 = 不干预。
 */

export function applyReplacements(text: string, rules?: StoreRules["replacements"]): string {
  let out = text;
  for (const r of rules ?? []) {
    if (r.from) out = out.split(r.from).join(r.to ?? "");
  }
  return out;
}

/** 标题：替换词 → 去供应商话术式 trim → 加前后缀（自动补空格）。 */
export function applyTitleRules(title: string, rules: StoreRules): string {
  let t = applyReplacements(title, rules.replacements).replace(/\s+/g, " ").trim();
  const pre = rules.titlePrefix?.trim();
  const suf = rules.titleSuffix?.trim();
  if (pre) t = `${pre} ${t}`;
  if (suf) t = `${t} ${suf}`;
  return t.slice(0, 255);
}

/** 属性：替换词应用到键和值（在转 HTML 之前做，避免碰转义符）。 */
export function applyAttrRules(
  attrs: Record<string, string>,
  rules: StoreRules,
): Record<string, string> {
  if (!rules.replacements?.length) return attrs;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    const nk = applyReplacements(k, rules.replacements).trim();
    const nv = applyReplacements(v, rules.replacements).trim();
    if (nk) out[nk] = nv;
  }
  return out;
}

const firstPrice = (priceText?: string | null) => {
  const m = priceText?.match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : undefined;
};

/** 价格区间过滤（按源成本 ¥）：返回留下的 SKU；未设区间 = 全留。 */
export function filterSkusByPrice(
  skus: OfferSku[],
  rules: StoreRules,
  priceText?: string | null,
): OfferSku[] {
  const lo = rules.priceMinCny ?? null;
  const hi = rules.priceMaxCny ?? null;
  if (lo == null && hi == null) return skus;
  const fallback = firstPrice(priceText);
  return skus.filter((s) => {
    const cost = s.priceCny ?? fallback;
    if (cost == null) return true; // 无价的放行（不替用户猜）
    if (lo != null && cost < lo) return false;
    if (hi != null && cost > hi) return false;
    return true;
  });
}

/** 认领图片数：系统硬上限 20 与店铺上限取小。 */
export function applyImageLimit(images: string[], rules: StoreRules): string[] {
  return images.slice(0, Math.min(20, rules.maxImages ?? 20));
}

const stripHtml = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

/**
 * 发布门禁：在标题/描述文本/标签/选项名+值/品牌中找禁售词（大小写不敏感
 * 子串匹配），返回命中的词（去重）。
 */
export function findBannedWords(
  listing: {
    title: string;
    descriptionHtml: string;
    tags: string[];
    options: Array<{ name: string; values: string[] }>;
    vendor: string;
  },
  words?: string[],
): string[] {
  if (!words?.length) return [];
  const hay = [
    listing.title,
    stripHtml(listing.descriptionHtml),
    ...listing.tags,
    ...listing.options.flatMap((o) => [o.name, ...o.values]),
    listing.vendor,
  ]
    .join("\n")
    .toLowerCase();
  return [...new Set(words.filter((w) => w.trim() && hay.includes(w.trim().toLowerCase())))];
}
