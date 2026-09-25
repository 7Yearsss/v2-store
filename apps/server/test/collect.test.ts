import { afterEach, describe, expect, it } from "vitest";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, offerHtml, setup } from "./helpers.js";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe("collect", () => {
  it("parses harvested HTML server-side into the collect box", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const res = await ctx.api("POST", "/api/collect", harvest("123", "纯棉T恤"), t);
    expect(res.status).toBe(201);
    const item = res.body.item;
    expect(item.title).toBe("纯棉T恤");
    expect(item.sourceItemId).toBe("123");
    expect(item.skus).toHaveLength(2);
    expect(item.skus[0]).toMatchObject({ spec: "颜色:红色 / 尺码:M", priceCny: 10.5 });
    expect(item.images).toEqual(["https://cbu01.alicdn.com/a.jpg"]);
    expect(item.attributes).toEqual({ 材质: "棉" });
  });

  it("dedupes re-collection across URL shapes by offerId", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const first = await ctx.api("POST", "/api/collect", harvest("123", "旧标题"), t);
    const h = harvest("123", "新标题");
    h.sourceInfo.itemUrl = "https://detail.1688.com/offer/123.html?spm=abc";
    const second = await ctx.api("POST", "/api/collect", h, t);
    expect(second.status).toBe(200);
    expect(second.body.duplicated).toBe(true);
    expect(second.body.item.id).toBe(first.body.item.id);
    expect(second.body.item.title).toBe("新标题");

    const check = await ctx.api(
      "POST",
      "/api/collect/check",
      { items: [{ itemUrl: "https://detail.1688.com/offer/123.html?x=1" }, { itemId: "999" }] },
      t,
    );
    expect(check.body.collected).toEqual(["https://detail.1688.com/offer/123.html?x=1"]);
  });

  it("returns 422 when the page has no product data", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const h = harvest("5");
    h.pageContent = "<html>login</html>";
    const res = await ctx.api("POST", "/api/collect", h, t);
    expect(res.status).toBe(422);
  });

  it("重复采集把最新库存/成本同步到刊登并重发已发布商品", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const store = (
      await ctx.api(
        "POST",
        "/api/stores/shopify",
        { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
        t,
      )
    ).body;
    const item = await ctx.api("POST", "/api/collect", harvest("77", "库存杯"), t);
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.body.item.id], storeIds: [store.id] },
      t,
    );
    const listing = (await ctx.api("GET", "/api/listings", undefined, t)).body.items[0];
    expect(listing.variants[0].stock).toBe(100);
    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    while (await runOnce(ctx.deps, jobHandlers)) {
      /* drain */
    }

    // 货源变了：红色/M 库存 100→3、成本 10.5→9
    const h = harvest("77", "库存杯");
    h.pageContent = offerHtml("77", "库存杯")
      .replace('"canBookCount":100', '"canBookCount":3')
      .replace('"price":"10.5"', '"price":"9"');
    const res = await ctx.api("POST", "/api/collect", h, t);
    expect(res.status).toBe(200);
    expect(res.body.duplicated).toBe(true);
    expect(res.body.updated).toBeGreaterThan(0);
    expect(res.body.republished).toBe(1);

    const done = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(done.body.status).toBe("publishing");
    expect(done.body.variants[0]).toMatchObject({ stock: 3, costCny: 9 });
    // 价格保持商家设定，不被货源价覆盖
    expect(done.body.variants[0].price).toBe(listing.variants[0].price);

    while (await runOnce(ctx.deps, jobHandlers)) {
      /* drain republish */
    }
    const res2 = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(res2.body.status).toBe("published");
  });
});
