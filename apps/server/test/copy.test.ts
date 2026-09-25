import { afterEach, describe, expect, it } from "vitest";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe("listing copy", () => {
  it("copies a listing to another store as a fresh draft", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const mk = (domain: string) =>
      ctx!.api(
        "POST",
        "/api/stores/shopify",
        { authType: "access_token", shopDomain: domain, accessToken: "shpat_abcdefghij" },
        t,
      );
    const s1 = (await mk("a.myshopify.com")).body;
    const s2 = (await mk("b.myshopify.com")).body;
    const item = (await ctx.api("POST", "/api/collect", harvest("71", "复制杯"), t)).body.item;
    await ctx.api("POST", "/api/source-items/claim", { ids: [item.id], storeIds: [s1.id] }, t);
    const src = (await ctx.api("GET", "/api/listings", undefined, t)).body.items[0];
    await ctx.api("PATCH", `/api/listings/${src.id}`, { title: "复制杯 EN 优化版", vendor: "MugCo" }, t);

    const res = await ctx.api("POST", `/api/listings/${src.id}/copy`, { storeId: s2.id }, t);
    expect(res.status).toBe(201);
    expect(res.body.id).not.toBe(src.id);
    expect(res.body).toMatchObject({
      storeId: s2.id,
      status: "draft",
      title: "复制杯 EN 优化版",
      vendor: "MugCo",
      remoteId: null,
      remoteStatus: null,
    });
    expect(res.body.variants).toHaveLength(src.variants.length);
  });

  it("is scoped to the workspace", async () => {
    ctx = await setup(fakeShopify());
    const t1 = await ctx.register();
    const t2 = await ctx.register("b@test.dev");
    const store = (
      await ctx.api(
        "POST",
        "/api/stores/shopify",
        { authType: "access_token", shopDomain: "a.myshopify.com", accessToken: "shpat_abcdefghij" },
        t1,
      )
    ).body;
    const item = (await ctx.api("POST", "/api/collect", harvest("72", "隔离杯"), t1)).body.item;
    await ctx.api("POST", "/api/source-items/claim", { ids: [item.id], storeIds: [store.id] }, t1);
    const listing = (await ctx.api("GET", "/api/listings", undefined, t1)).body.items[0];

    // another team's store id must not be usable, and their call sees 404
    const cross = await ctx.api("POST", `/api/listings/${listing.id}/copy`, { storeId: store.id }, t2);
    expect(cross.status).toBe(404);
  });
});
