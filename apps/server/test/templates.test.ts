import { afterEach, describe, expect, it } from "vitest";
import { fakeShopify } from "./fakeShopify.js";
import { setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const PAYLOAD = {
  pricing: { exchangeRate: 0.14, markup: 2, priceEnding: 0.99, extraCostCny: 3, minPrice: 5 },
  vendor: "MyBrand",
  aiEnhance: true,
  language: "en",
  rules: { publishStatus: "draft", bannedWords: ["厂家直销"], trackStock: true },
};

describe("刊登模板", () => {
  it("存模板→套用到店铺→认领用新设置；同名覆盖；跨工作区隔离", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const t2 = await ctx.register("other@test.dev");

    // 初始为空
    let list = await ctx.api("GET", "/api/templates", undefined, t);
    expect(list.body.items).toEqual([]);

    // 存模板
    const save = await ctx.api("POST", "/api/templates", { name: "服饰模板", payload: PAYLOAD }, t);
    expect(save.status).toBe(200);
    expect(save.body.item.payload.vendor).toBe("MyBrand");

    // 同名覆盖
    const again = await ctx.api(
      "POST",
      "/api/templates",
      { name: "服饰模板", payload: { ...PAYLOAD, vendor: "OtherBrand" } },
      t,
    );
    list = await ctx.api("GET", "/api/templates", undefined, t);
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].payload.vendor).toBe("OtherBrand");
    expect(again.body.item.id).toBe(save.body.item.id);

    // 模板内容套用到店铺：PATCH stores 全量替换规则
    const store = await ctx.api(
      "POST",
      "/api/stores/shopify",
      { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
      t,
    );
    const p = list.body.items[0].payload;
    const patch = await ctx.api(
      "PATCH",
      `/api/stores/${store.body.id}`,
      { vendor: p.vendor, aiEnhance: p.aiEnhance, language: p.language, rules: p.rules, pricing: p.pricing },
      t,
    );
    expect(patch.body.vendor).toBe("OtherBrand");
    expect(patch.body.rules.publishStatus).toBe("draft");

    // 跨工作区不可见/不可删
    const other = await ctx.api("GET", "/api/templates", undefined, t2);
    expect(other.body.items).toEqual([]);
    const denied = await ctx.api("DELETE", `/api/templates/${save.body.item.id}`, undefined, t2);
    expect(denied.status).toBe(404);

    // 删除
    const del = await ctx.api("DELETE", `/api/templates/${save.body.item.id}`, undefined, t);
    expect(del.body.ok).toBe(true);
  });
});
