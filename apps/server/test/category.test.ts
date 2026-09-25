import { afterEach, describe, expect, it } from "vitest";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";
import { fakeShopify } from "./fakeShopify.js";
import { json, setup, type FakeFetch } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const AI_URL = "https://ai.test/v1/chat/completions";

/** fakeShopify + canned replies for the two category prompts and aiEnhance. */
function fakeAll(): FakeFetch {
  const shopify = fakeShopify();
  return (url, init) => {
    if (url === AI_URL) {
      const body = JSON.parse(String(init.body));
      const user = String(body.messages?.[1]?.content ?? "");
      if (user.includes('"terms"')) {
        return json({ choices: [{ message: { content: '{"terms":["coat"]}' } }] });
      }
      if (user.includes('"picks"')) {
        return json({
          choices: [
            {
              message: {
                content:
                  '{"picks":[{"id":"gid://shopify/TaxonomyCategory/c2","confidence":90},{"id":"gid://shopify/TaxonomyCategory/c1","confidence":70}]}',
              },
            },
          ],
        });
      }
      return json({
        choices: [{ message: { content: '{"title":"AI Title","tags":["t"]}' } }],
      });
    }
    return shopify(url, init);
  };
}

function enableAi(c: Awaited<ReturnType<typeof setup>>) {
  c.deps.config.ai = { baseUrl: "https://ai.test/v1", apiKey: "k", model: "m" };
}

/** Collect via the pre-parsed offer path so categoryId/categoryPath survive. */
function offerWithCategory(offerId: string, categoryId = "cat-1688-9") {
  return {
    sourceInfo: {
      itemUrl: `https://detail.1688.com/offer/${offerId}.html`,
      itemId: offerId,
      source: "1688",
    },
    productExtInfo: {
      offer: {
        sourcePlatform: "1688",
        sourceUrl: `https://detail.1688.com/offer/${offerId}.html`,
        offerId,
        title: "女式羽绒服",
        priceText: "¥100",
        categoryId,
        categoryPath: ["女装/女士精品>羽绒服"],
        skus: [{ spec: "红色>M", priceCny: 100, stock: 10 }],
        images: ["https://img.example/a.jpg"],
        attributes: {},
        collectedAt: new Date().toISOString(),
      },
    },
  };
}

async function storeAndClaim(
  c: Awaited<ReturnType<typeof setup>>,
  t: string,
  offerId: string,
  categoryId?: string,
) {
  const store =
    (await c.api("GET", "/api/stores", undefined, t)).body[0] ??
    (
      await c.api(
        "POST",
        "/api/stores/shopify",
        { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
        t,
      )
    ).body;
  const item = await c.api("POST", "/api/collect", offerWithCategory(offerId, categoryId), t);
  await c.api(
    "POST",
    "/api/source-items/claim",
    { ids: [item.body.item.id], storeIds: [store.id] },
    t,
  );
  const list = await c.api("GET", "/api/listings", undefined, t);
  return { store, listing: list.body.items[0] };
}

const drain = async (c: Awaited<ReturnType<typeof setup>>) => {
  while (await runOnce(c.deps, jobHandlers)) {
    /* drain */
  }
};

describe("类目映射", () => {
  it("认领未映射类目→排队建议任务→建议��� Top 候选→确认后写映射并套用", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const { listing } = await storeAndClaim(ctx, t, "o1");

    let jobs = await ctx.deps.db.query.jobs.findMany();
    expect(jobs.some((j) => j.type === "listing.categorySuggest")).toBe(true);
    expect(listing.channelCategoryId).toBeNull();

    await drain(ctx);

    const res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    const sug = res.body.items.find((s: any) => s.field === "category");
    expect(sug).toBeTruthy();
    expect(sug.value.sourceCategoryId).toBe("cat-1688-9");
    // rank prompt put c2 first, c1 second
    expect(sug.value.candidates.map((c: any) => c.id)).toEqual([
      "gid://shopify/TaxonomyCategory/c2",
      "gid://shopify/TaxonomyCategory/c1",
    ]);

    // 用户选了第二个候选
    const decide = await ctx.api(
      "POST",
      `/api/listings/${listing.id}/suggestions/decide`,
      {
        decisions: [
          {
            id: sug.id,
            action: "accept",
            choice: "gid://shopify/TaxonomyCategory/c1",
          },
        ],
      },
      t,
    );
    expect(decide.body.accepted).toBe(1);

    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.channelCategoryId).toBe("gid://shopify/TaxonomyCategory/c1");
    expect(cur.body.channelCategoryName).toBe("Apparel > Outerwear > Coats");

    const maps = await ctx.api("GET", "/api/category-mappings", undefined, t);
    expect(maps.body.items.length).toBe(1);
    expect(maps.body.items[0].channelCategoryId).toBe("gid://shopify/TaxonomyCategory/c1");
    expect(maps.body.items[0].confirmedBy).toBe("user");
  });

  it("已映射类目认领时自动套用，不再排队建议", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const { listing } = await storeAndClaim(ctx, t, "o2");
    await drain(ctx);

    const res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    const sug = res.body.items.find((s: any) => s.field === "category");
    await ctx.api(
      "POST",
      `/api/listings/${listing.id}/suggestions/decide`,
      { decisions: [{ id: sug.id, action: "accept" }] }, // default top candidate c2
      t,
    );

    const jobsBefore = (await ctx.deps.db.query.jobs.findMany()).filter(
      (j) => j.type === "listing.categorySuggest" && ["queued", "running"].includes(j.status),
    );
    const item = await ctx.api("POST", "/api/collect", offerWithCategory("o3"), t);
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      {
        ids: [item.body.item.id],
        storeIds: [(await ctx.api("GET", "/api/stores", undefined, t)).body[0].id],
      },
      t,
    );
    const list = await ctx.api("GET", "/api/listings", undefined, t);
    const second = list.body.items.find((l: any) => l.id !== listing.id);
    expect(second.channelCategoryId).toBe("gid://shopify/TaxonomyCategory/c2");
    expect(second.channelCategoryName).toBe("Apparel > Outerwear > Jackets");

    const jobsAfter = (await ctx.deps.db.query.jobs.findMany()).filter(
      (j) => j.type === "listing.categorySuggest" && ["queued", "running"].includes(j.status),
    );
    expect(jobsAfter.length).toBe(jobsBefore.length);
  });

  it("发布时 productSet 带上已映射的 category", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const { listing } = await storeAndClaim(ctx, t, "o4");
    await drain(ctx);

    const res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    const sug = res.body.items.find((s: any) => s.field === "category");
    await ctx.api(
      "POST",
      `/api/listings/${listing.id}/suggestions/decide`,
      { decisions: [{ id: sug.id, action: "accept" }] },
      t,
    );

    const pub = await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    expect(pub.body.queued).toBe(1);
    await drain(ctx);

    const setCall = ctx.calls.find(
      (c) => c.url.includes("graphql.json") && String(c.body?.query ?? "").includes("productSet"),
    );
    expect(setCall).toBeTruthy();
    expect(setCall.body.variables.input.category).toBe("gid://shopify/TaxonomyCategory/c2");

    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.status).toBe("published");
  });

  it("删除映射后同来源类目重新走 AI 建议；跨工作区不可见", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const t2 = await ctx.register("b@test.dev");
    const { listing } = await storeAndClaim(ctx, t, "o5");
    await drain(ctx);

    const res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    const sug = res.body.items.find((s: any) => s.field === "category");
    await ctx.api(
      "POST",
      `/api/listings/${listing.id}/suggestions/decide`,
      { decisions: [{ id: sug.id, action: "accept" }] },
      t,
    );

    const maps = await ctx.api("GET", "/api/category-mappings", undefined, t);
    const mapId = maps.body.items[0].id;

    // 跨工作区：列表为空、删除 404
    const other = await ctx.api("GET", "/api/category-mappings", undefined, t2);
    expect(other.body.items).toEqual([]);
    const delOther = await ctx.api("DELETE", `/api/category-mappings/${mapId}`, undefined, t2);
    expect(delOther.status).toBe(404);

    const del = await ctx.api("DELETE", `/api/category-mappings/${mapId}`, undefined, t);
    expect(del.body.ok).toBe(true);

    const item = await ctx.api("POST", "/api/collect", offerWithCategory("o6"), t);
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      {
        ids: [item.body.item.id],
        storeIds: [(await ctx.api("GET", "/api/stores", undefined, t)).body[0].id],
      },
      t,
    );
    const jobs = (await ctx.deps.db.query.jobs.findMany()).filter(
      (j) => j.type === "listing.categorySuggest" && j.status === "queued",
    );
    expect(jobs.length).toBeGreaterThan(0);
  });
});
