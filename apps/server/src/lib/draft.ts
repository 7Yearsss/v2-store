import type {
  ListingOption,
  ListingVariant,
  OfferSku,
  PricingRule,
} from "@caiji/shared";

export const DEFAULT_PRICING: PricingRule = {
  exchangeRate: 0.14,
  markup: 3,
  priceEnding: 0.99,
  extraCostCny: 0,
  minPrice: null,
};

/**
 * (source cost + fixed extra cost) → store currency → × markup, floored at
 * minPrice, then rounded up to the price ending.
 */
export function applyPricing(costCny: number, rule: PricingRule): number {
  const converted = (costCny + (rule.extraCostCny ?? 0)) * rule.exchangeRate * rule.markup;
  const raw = Math.max(converted, rule.minPrice ?? 0);
  if (rule.priceEnding == null) return Math.max(0.01, Math.round(raw * 100) / 100);
  const p = Math.floor(raw) + rule.priceEnding;
  // round up to the next ending so we never undercut the target price
  return Math.round((p < raw ? p + 1 : p) * 100) / 100;
}

const MAX_OPTIONS = 3; // Shopify limit

/** "颜色:红色 / 尺码:XL" → [["颜色","红色"],["尺码","XL"]] */
function parseSpec(spec: string): Array<[string, string]> {
  return spec
    .split(" / ")
    .map((part, i): [string, string] => {
      const idx = part.indexOf(":");
      return idx > 0
        ? [part.slice(0, idx).trim(), part.slice(idx + 1).trim()]
        : [`规格${i + 1}`, part.trim()];
    })
    .filter(([, v]) => v);
}

function firstPrice(priceText?: string | null): number | undefined {
  const m = priceText?.match(/\d+(\.\d+)?/);
  return m ? Number(m[0]) : undefined;
}

/**
 * Turn source SKUs into channel options + variants. Collapses to a single
 * "规格" option when the source has more dimensions than the channel allows
 * or when specs are inconsistent across SKUs.
 */
export function buildVariants(
  skus: OfferSku[],
  opts: {
    skuPrefix: string;
    priceText?: string | null;
    pricing: PricingRule;
    /** 术语预翻：选项名/选项值逐词精确映射（未命中原样）。 */
    termMap?: (t: string) => string;
  },
): { options: ListingOption[]; variants: ListingVariant[] } {
  const fallbackCost = firstPrice(opts.priceText);
  if (!skus.length) {
    return {
      options: [],
      variants: [
        {
          sku: `${opts.skuPrefix}-1`,
          optionValues: [],
          price: fallbackCost ? applyPricing(fallbackCost, opts.pricing) : 0,
          costCny: fallbackCost,
        },
      ],
    };
  }

  const parsed = skus.map((s) => parseSpec(s.spec));
  const names = parsed[0]?.map(([n]) => n) ?? [];
  const consistent =
    names.length > 0 &&
    names.length <= MAX_OPTIONS &&
    parsed.every(
      (p) => p.length === names.length && p.every(([n], i) => n === names[i]),
    );

  // 预翻在去重之前：不同源词译成同一词时撞名会落进下面的消歧逻辑；
  // 超过 255 的译文不能用作选项名/值，回落源词。
  const t0 = opts.termMap ?? ((s: string) => s);
  const t = (s: string) => {
    const r = t0(s);
    return r.length <= 255 ? r : s;
  };

  const rows: string[][] = consistent
    ? parsed.map((p) => p.map(([, v]) => t(v)))
    : skus.map((s) => [t(s.spec.slice(0, 255))]);
  const optionNames: string[] = [];
  {
    const nameSeen = new Map<string, number>();
    for (const n of consistent ? names : ["规格"]) {
      const tr = t(n);
      const c = (nameSeen.get(tr) ?? 0) + 1;
      nameSeen.set(tr, c);
      optionNames.push(c > 1 ? `${tr} (${c})` : tr);
    }
  }

  // Shopify rejects duplicate option-value combos; disambiguate.
  const seen = new Map<string, number>();
  const variants: ListingVariant[] = skus.map((s, i) => {
    let values = rows[i]!;
    const key = values.join("\u0000");
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > 1) values = [...values.slice(0, -1), `${values.at(-1)} (${n})`];
    const cost = s.priceCny ?? fallbackCost;
    return {
      sourceSkuId: s.skuId,
      sku: `${opts.skuPrefix}-${i + 1}`,
      optionValues: values,
      price: cost ? applyPricing(cost, opts.pricing) : 0,
      costCny: cost,
      stock: s.stock,
      image: s.image,
    };
  });

  const options: ListingOption[] = optionNames.map((name, idx) => ({
    name,
    values: [...new Set(variants.map((v) => v.optionValues[idx]!))],
  }));
  return { options, variants };
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (ch) => HTML_ESCAPES[ch]!);

export function attributesToHtml(attrs: Record<string, string>): string {
  const rows = Object.entries(attrs)
    .map(([k, v]) => `<tr><td>${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join("");
  return rows ? `<table>${rows}</table>` : "";
}
