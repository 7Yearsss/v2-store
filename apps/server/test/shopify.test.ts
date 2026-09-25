import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { verifyQueryHmac } from "../src/channels/shopify/oauth.js";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function claimOne(ctx: Awaited<ReturnType<typeof setup>>, t: string) {
  const store = await ctx.api(
    "POST",
    "/api/stores/shopify",
    { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
    t,
  );
  expect(store.status).toBe(201);
  const item = await ctx.api("POST", "/api/collect", harvest("777", "测试杯子"), t);
  const claim = await ctx.api(
    "POST",
    "/api/source-items/claim",
    { ids: [item.body.item.id], storeIds: [store.body.id] },
    t,
  );
  expect(claim.body).toEqual({ created: 1, skipped: 0 });
  const list = await ctx.api("GET", "/api/listings", undefined, t);
  return { store: store.body, listing: list.body.items[0] };
}

describe("shopify stores", () => {
  it("verifies and stores credentials encrypted", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const res = await ctx.api(
      "POST",
      "/api/stores/shopify",
      { authType: "access_token", shopDomain: "https://Demo.myshopify.com/admin", accessToken: "shpat_abcdefghij" },
      t,
    );
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: "Demo", shopDomain: "demo.myshopify.com", currency: "USD" });
    expect(JSON.stringify(res.body)).not.toContain("shpat_");
    const raw = await ctx.deps.db.query.stores.findFirst();
    expect(raw!.credentials).not.toContain("shpat_");
  });

  it("rejects bad tokens with a readable error", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const res = await ctx.api(
      "POST",
      "/api/stores/shopify",
      { authType: "access_token", shopDomain: "demo", accessToken: "bad_token_xx" },
      t,
    );
    expect(res.status).toBe(422);
    expect(res.body.error).toContain("令牌无效");
  });

  it("reports unreachable and nonexistent shops readably", async () => {
    ctx = await setup(() => {
      throw new TypeError("fetch failed");
    });
    const t = await ctx.register();
    const body = { authType: "access_token", shopDomain: "nope", accessToken: "shpat_abcdefghij" };
    const down = await ctx.api("POST", "/api/stores/shopify", body, t);
    expect(down.status).toBe(422);
    expect(down.body.error).toContain("无法连接店铺");
    await ctx.close();

    ctx = await setup(() => new Response("<html>not found</html>", { status: 404 }));
    const t2 = await ctx.register();
    const missing = await ctx.api("POST", "/api/stores/shopify", body, t2);
    expect(missing.status).toBe(422);
    expect(missing.body.error).toContain("不存在");
  });

  it("supports the client-credentials grant", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const res = await ctx.api(
      "POST",
      "/api/stores/shopify",
      { authType: "client_credentials", shopDomain: "demo", clientId: "id", clientSecret: "sec" },
      t,
    );
    expect(res.status).toBe(201);
    expect(res.body.authType).toBe("client_credentials");
  });
});

describe("claim → publish", () => {
  it("builds a priced draft and publishes it via productSet", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const { listing } = await claimOne(ctx, t);
    expect(listing.status).toBe("draft");
    expect(listing.options).toEqual([
      { name: "颜色", values: ["红色"] },
      { name: "尺码", values: ["M", "L"] },
    ]);
    // 10.5 CNY * 0.14 * 3 = 4.41 → 4.99
    expect(listing.variants[0]).toMatchObject({ sku: "777-1", price: 4.99, costCny: 10.5 });

    // re-claim is idempotent
    const again = await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [listing.sourceItemId], storeIds: [listing.storeId] },
      t,
    );
    expect(again.body).toEqual({ created: 0, skipped: 1 });

    const pub = await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    expect(pub.body).toEqual({ queued: 1, skipped: 0, blocked: [] });
    // editing while publishing is refused
    const locked = await ctx.api("PATCH", `/api/listings/${listing.id}`, { title: "x" }, t);
    expect(locked.status).toBe(409);

    // drain: 建店时的类目树同步任务可能排在发布前面
    while (await runOnce(ctx.deps, jobHandlers)) {
      /* drain */
    }
    const done = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(done.body.status).toBe("published");
    expect(done.body.remoteId).toBe("gid://shopify/Product/42");
    expect(done.body.remoteUrl).toBe("https://demo.myshopify.com/admin/products/42");

    const call = ctx.calls.find((c) => c.body?.query?.includes("productSet"))!;
    const input = call.body.variables.input;
    expect(input.productOptions[1]).toEqual({
      name: "尺码",
      position: 2,
      values: [{ name: "M" }, { name: "L" }],
    });
    expect(input.variants[0]).toMatchObject({
      sku: "777-1",
      price: "4.99",
      optionValues: [
        { optionName: "颜色", name: "红色" },
        { optionName: "尺码", name: "M" },
      ],
      inventoryItem: { tracked: false, cost: "1.47" },
    });
    expect(input.files).toEqual([
      { originalSource: "https://cbu01.alicdn.com/a.jpg", contentType: "IMAGE" },
    ]);
    expect(call.body.variables.identifier).toBeUndefined();

    // republish syncs the same remote product
    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    await runOnce(ctx.deps, jobHandlers);
    const resync = ctx.calls.filter((c) => c.body?.query?.includes("productSet")).at(-1)!;
    expect(resync.body.variables.identifier).toEqual({ id: "gid://shopify/Product/42" });
  });

  it("marks the listing failed with Shopify's validation message", async () => {
    ctx = await setup(
      fakeShopify({ productSetErrors: [{ field: ["input", "title"], message: "is too long" }] }),
    );
    const t = await ctx.register();
    const { listing } = await claimOne(ctx, t);
    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    while (await runOnce(ctx.deps, jobHandlers)) {
      /* drain */
    }
    const res = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(res.body.status).toBe("failed");
    expect(res.body.lastError).toBe("input.title: is too long");
  });

  it("草稿发布 + SEO + 默认项 + 变体图绑定", async () => {
    ctx = await setup(
      fakeShopify({
        sourceImages: {
          "https://cbu01.alicdn.com/d1.jpg": new Uint8Array([0xff, 0xd8, 0xff, 1]),
          "https://cbu01.alicdn.com/d2.jpg": new Uint8Array([0xff, 0xd8, 0xff, 2]),
        },
      }),
    );
    const t = await ctx.register();
    const store = (
      await ctx.api(
        "POST",
        "/api/stores/shopify",
        { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
        t,
      )
    ).body;
    await ctx.api(
      "PATCH",
      `/api/stores/${store.id}`,
      {
        rules: {
          publishStatus: "draft",
          defaultTags: ["dropship"],
          defaultProductType: "Cups",
        },
      },
      t,
    );
    const item = await ctx.api(
      "POST",
      "/api/collect",
      {
        sourceInfo: {
          itemUrl: "https://detail.1688.com/offer/ov1.html",
          itemId: "ov1",
          source: "1688",
        },
        productExtInfo: {
          offer: {
            sourcePlatform: "1688",
            sourceUrl: "https://detail.1688.com/offer/ov1.html",
            offerId: "ov1",
            title: "保温杯",
            priceText: "¥10",
            skus: [
              {
                spec: "颜色:红色 / 容量:500ml",
                priceCny: 10,
                stock: 5,
                image: "https://cbu01.alicdn.com/red.jpg",
              },
            ],
            images: ["https://cbu01.alicdn.com/a.jpg"],
            descImages: ["https://cbu01.alicdn.com/d1.jpg", "https://cbu01.alicdn.com/d2.jpg"],
            attributes: {},
            collectedAt: new Date().toISOString(),
          },
        },
      },
      t,
    );
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.body.item.id], storeIds: [store.id] },
      t,
    );
    const list = await ctx.api("GET", "/api/listings", undefined, t);
    const listing = list.body.items[0];
    // 详情图随认领进刊登
    expect(listing.descImages).toEqual([
      "https://cbu01.alicdn.com/d1.jpg",
      "https://cbu01.alicdn.com/d2.jpg",
    ]);
    // 刊登默认项在认领时生效
    expect(listing.tags).toEqual(["dropship"]);
    expect(listing.productType).toBe("Cups");
    expect(listing.variants[0].image).toBe("https://cbu01.alicdn.com/red.jpg");

    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    while (await runOnce(ctx.deps, jobHandlers)) {
      /* drain */
    }
    const done = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(done.body.status).toBe("published");
    expect(done.body.remoteStatus).toBe("DRAFT");

    const setCall = ctx.calls.find((c) => String(c.body?.query ?? "").includes("productSet"));
    const input = setCall!.body.variables.input;
    expect(input.status).toBe("DRAFT");
    expect(input.seo.title).toBe("保温杯");
    expect(input.seo.description).toContain("保温杯");
    // files = 主图 + 变体图
    expect(input.files).toHaveLength(2);
    expect(input.files[1].originalSource).toBe("https://cbu01.alicdn.com/red.jpg");
    // 详情图：fileCreate 转永久 cdn URL 后追加到描述末尾
    expect(input.descriptionHtml).toContain('<img src="https://cdn.example/desc/f0.jpg"/>');
    expect(input.descriptionHtml).toContain('<img src="https://cdn.example/desc/f1.jpg"/>');

    // 变体图绑定：productSet → BindData 拿 media/variant id → productVariantsBulkUpdate
    const bind = ctx.calls.find((c) =>
      String(c.body?.query ?? "").includes("productVariantsBulkUpdate"),
    );
    expect(bind).toBeTruthy();
    expect(bind!.body.variables.variants).toEqual([
      { id: "gid://shopify/ProductVariant/v0", mediaId: "gid://shopify/Media/m1" },
    ]);
    // 草稿态不发 publishablePublish
    expect(
      ctx.calls.some((c) => String(c.body?.query ?? "").includes("publishablePublish")),
    ).toBe(false);
  });

  it("trackStock 开启后写入货源库存", async () => {
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
    await ctx.api("PATCH", `/api/stores/${store.id}`, { rules: { trackStock: true } }, t);
    const item = await ctx.api(
      "POST",
      "/api/collect",
      {
        sourceInfo: { itemUrl: "https://detail.1688.com/offer/st1.html", itemId: "st1", source: "1688" },
        productExtInfo: {
          offer: {
            sourcePlatform: "1688",
            sourceUrl: "https://detail.1688.com/offer/st1.html",
            offerId: "st1",
            title: "库存杯",
            priceText: "¥10",
            skus: [
              { spec: "颜色:红色", priceCny: 10, stock: 5 },
              { spec: "颜色:蓝色", priceCny: 12, stock: 999999 },
            ],
            images: [],
            attributes: {},
            collectedAt: new Date().toISOString(),
          },
        },
      },
      t,
    );
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.body.item.id], storeIds: [store.id] },
      t,
    );
    const list = await ctx.api("GET", "/api/listings", undefined, t);
    const listing = list.body.items[0];
    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    while (await runOnce(ctx.deps, jobHandlers)) {
      /* drain */
    }
    const done = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(done.body.status).toBe("published");

    const setCall = ctx.calls.find((c) => String(c.body?.query ?? "").includes("productSet"));
    expect(setCall!.body.variables.input.variants[0].inventoryItem.tracked).toBe(true);
    const stock = ctx.calls.find((c) =>
      String(c.body?.query ?? "").includes("inventorySetQuantities"),
    );
    expect(stock).toBeTruthy();
    expect(stock!.body.variables.input).toMatchObject({ name: "available" });
    expect(stock!.body.variables.input.quantities).toEqual([
      { inventoryItemId: "gid://shopify/InventoryItem/i0", locationId: "gid://shopify/Location/l1", quantity: 5, changeFromQuantity: 0 },
      // 库存封顶 99999
      { inventoryItemId: "gid://shopify/InventoryItem/i1", locationId: "gid://shopify/Location/l1", quantity: 99999, changeFromQuantity: 0 },
    ]);
  });

  it("rejects zero-priced variants before calling Shopify", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const { listing } = await claimOne(ctx, t);
    const variants = listing.variants.map((v: any) => ({ ...v, price: 0 }));
    await ctx.api("PATCH", `/api/listings/${listing.id}`, { variants }, t);
    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    while (await runOnce(ctx.deps, jobHandlers)) {
      /* drain */
    }
    const res = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(res.body.status).toBe("failed");
    expect(res.body.lastError).toContain("价格为 0");
  });
});

describe("oauth", () => {
  it("verifies Shopify query HMAC", () => {
    const params = new URLSearchParams({ code: "c", shop: "demo.myshopify.com", timestamp: "1" });
    const message = "code=c&shop=demo.myshopify.com&timestamp=1";
    params.set("hmac", createHmac("sha256", "secret").update(message).digest("hex"));
    expect(verifyQueryHmac("secret", params)).toBe(true);
    params.set("shop", "evil.myshopify.com");
    expect(verifyQueryHmac("secret", params)).toBe(false);
  });

  it("builds an install URL bound to the workspace", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const res = await ctx.api("GET", "/api/shopify/install?shop=demo", undefined, t);
    const url = new URL(res.body.url);
    expect(url.host).toBe("demo.myshopify.com");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:5173/api/shopify/callback");
    expect(url.searchParams.get("state")).toMatch(/\./);
  });
});
