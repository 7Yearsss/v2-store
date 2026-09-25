import { afterEach, describe, expect, it } from "vitest";
import { harvest, setup } from "./helpers.js";

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
});
