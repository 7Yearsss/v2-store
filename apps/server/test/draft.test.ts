import { describe, expect, it } from "vitest";
import { applyPricing, buildVariants, DEFAULT_PRICING, parseWeightKg } from "../src/lib/draft.js";

describe("pricing", () => {
  it("converts, marks up and applies a .99 ending without undercutting", () => {
    // 10 CNY * 0.14 * 3 = 4.2 → 4.99
    expect(applyPricing(10, DEFAULT_PRICING)).toBe(4.99);
    expect(applyPricing(10, { ...DEFAULT_PRICING, priceEnding: null })).toBe(4.2);
    // 5.5 → 5.99 ; 5.995 → 6.99
    expect(applyPricing(5.5 / 0.42, DEFAULT_PRICING)).toBe(5.99);
    expect(applyPricing(5.995 / 0.42, DEFAULT_PRICING)).toBe(6.99);
  });

  it("adds a fixed extra cost before conversion and enforces a price floor", () => {
    // (2.09 + 15) * 0.42 = 7.18 → 7.99
    expect(applyPricing(2.09, { ...DEFAULT_PRICING, extraCostCny: 15 })).toBe(7.99);
    // 2.09 * 0.42 = 0.88 → floor 9.9 → 9.99
    expect(applyPricing(2.09, { ...DEFAULT_PRICING, minPrice: 9.9 })).toBe(9.99);
    // rules saved before these fields existed still work
    const legacy = { exchangeRate: 0.14, markup: 3, priceEnding: 0.99 };
    expect(applyPricing(10, legacy)).toBe(4.99);
  });
});

describe("buildVariants", () => {
  const pricing = DEFAULT_PRICING;

  it("splits consistent specs into options", () => {
    const r = buildVariants(
      [
        { spec: "颜色:红 / 尺码:M", priceCny: 10 },
        { spec: "颜色:蓝 / 尺码:M", priceCny: 10 },
      ],
      { skuPrefix: "1", pricing },
    );
    expect(r.options).toEqual([
      { name: "颜色", values: ["红", "蓝"] },
      { name: "尺码", values: ["M"] },
    ]);
    expect(r.variants.map((v) => v.optionValues)).toEqual([
      ["红", "M"],
      ["蓝", "M"],
    ]);
    expect(r.variants[0]!.sku).toBe("1-1");
  });

  it("collapses >3 dimensions into one option and dedupes combos", () => {
    const r = buildVariants(
      [{ spec: "a:1 / b:2 / c:3 / d:4" }, { spec: "a:1 / b:2 / c:3 / d:4" }],
      { skuPrefix: "x", pricing, priceText: "¥8.00" },
    );
    expect(r.options).toHaveLength(1);
    expect(r.variants[1]!.optionValues[0]).toMatch(/\(2\)$/);
    expect(r.variants[0]!.costCny).toBe(8);
  });

  it("creates a single default variant when there are no SKUs", () => {
    const r = buildVariants([], { skuPrefix: "x", pricing, priceText: "12-20" });
    expect(r.options).toEqual([]);
    expect(r.variants).toHaveLength(1);
    expect(r.variants[0]!.costCny).toBe(12);
  });
});

describe("parseWeightKg", () => {
  it("parses Chinese and imperial weight values into kg", () => {
    expect(parseWeightKg({ 净重: "0.5kg" })).toBe(0.5);
    expect(parseWeightKg({ 重量: "500g" })).toBe(0.5);
    expect(parseWeightKg({ 毛重: "1.2千克" })).toBe(1.2);
    expect(parseWeightKg({ 净重: "0.3公斤" })).toBe(0.3);
    expect(parseWeightKg({ 单件重量: "800克" })).toBe(0.8);
    expect(parseWeightKg({ weight: "12oz" })).toBeCloseTo(0.34, 2);
    expect(parseWeightKg({ Weight: "1 lb" })).toBeCloseTo(0.454, 2);
  });

  it("returns null when no weight-like attribute or unparseable", () => {
    expect(parseWeightKg({ 材质: "棉" })).toBeNull();
    expect(parseWeightKg({ 净重: "不详" })).toBeNull();
    expect(parseWeightKg({})).toBeNull();
  });
});
