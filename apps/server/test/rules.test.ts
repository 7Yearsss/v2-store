import { afterEach, describe, expect, it } from "vitest";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, json, setup, type FakeFetch } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const AI_URL = "https://ai.test/v1/chat/completions";

function fakeAll(aiReply: unknown = { title: "T" }): FakeFetch {
  const shopify = fakeShopify();
  return (url, init) =>
    url === AI_URL
      ? json({
          choices: [{ message: { content: JSON.stringify(aiReply) } }],
          usage: { prompt_tokens: 11, completion_tokens: 22, total_tokens: 33 },
        })
      : shopify(url, init);
}

async function connectStore(c: Awaited<ReturnType<typeof setup>>, t: string) {
  const res = await c.api(
    "POST",
    "/api/stores/shopify",
    { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
    t,
  );
  return res.body;
}

async function collect(c: Awaited<ReturnType<typeof setup>>, t: string, offerId = "777") {
  const item = await c.api("POST", "/api/collect", harvest(offerId, "厂家直销测试杯子"), t);
  return item.body.item;
}

const drain = async (c: Awaited<ReturnType<typeof setup>>) => {
  while (await runOnce(c.deps, jobHandlers)) {
    /* drain */
  }
};

describe("采集预处理规则", () => {
  it("认领时应用前后缀 / 替换词 / 价格区间", async () => {
    ctx = await setup(fakeAll());
    const t = await ctx.register();
    const store = await connectStore(ctx, t);
    const patched = await ctx.api(
      "PATCH",
      `/api/stores/${store.id}`,
      {
        rules: {
          titlePrefix: "[HOT]",
          titleSuffix: "Sale",
          replacements: [{ from: "厂家直销", to: "" }],
          priceMinCny: 5,
          priceMaxCny: 10.8,
        },
      },
      t,
    );
    expect(patched.body.rules.titlePrefix).toBe("[HOT]");

    const item = await collect(ctx, t);
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.id], storeIds: [store.id] },
      t,
    );
    const list = await ctx.api("GET", "/api/listings", undefined, t);
    const listing = list.body.items[0];
    expect(listing.title).toBe("[HOT] 测试杯子 Sale");
    // skus 10.5 / 11 → 区间 [5, 10.8] 只留下 10.5 那个
    expect(listing.variants).toHaveLength(1);
    expect(listing.variants[0].costCny).toBe(10.5);
  });

  it("替换词应用到属性；全部 SKU 在区间外则不建刊登", async () => {
    ctx = await setup(fakeAll());
    const t = await ctx.register();
    const store = await connectStore(ctx, t);
    await ctx.api(
      "PATCH",
      `/api/stores/${store.id}`,
      { rules: { replacements: [{ from: "棉", to: "Cotton" }], priceMaxCny: 1 } },
      t,
    );
    const item = await collect(ctx, t);
    const res = await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.id], storeIds: [store.id] },
      t,
    );
    // all skus (10.5 / 11) out of range → no listing
    expect(res.body).toEqual({ created: 0, skipped: 1 });

    // relax the cap → claim builds with replaced attributes
    await ctx.api(
      "PATCH",
      `/api/stores/${store.id}`,
      { rules: { replacements: [{ from: "棉", to: "Cotton" }], priceMaxCny: 100 } },
      t,
    );
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.id], storeIds: [store.id] },
      t,
    );
    const list = await ctx.api("GET", "/api/listings", undefined, t);
    expect(list.body.items[0].descriptionHtml).toContain("Cotton");
  });
});

describe("发布前检查", () => {
  it("命中禁售词的刊登不排队，逐条返回原因", async () => {
    ctx = await setup(fakeAll());
    const t = await ctx.register();
    const store = await connectStore(ctx, t);
    const item = await collect(ctx, t);
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.id], storeIds: [store.id] },
      t,
    );
    const list = await ctx.api("GET", "/api/listings", undefined, t);
    const lid = list.body.items[0].id;

    await ctx.api(
      "PATCH",
      `/api/stores/${store.id}`,
      { rules: { bannedWords: ["杯子", "Nike"] } },
      t,
    );
    const pub = await ctx.api("POST", "/api/listings/publish", { ids: [lid] }, t);
    expect(pub.body.queued).toBe(0);
    expect(pub.body.blocked).toHaveLength(1);
    expect(pub.body.blocked[0].words).toEqual(["杯子"]);
    const cur = await ctx.api("GET", `/api/listings/${lid}`, undefined, t);
    expect(cur.body.status).toBe("draft");
  });

  it("已排队任务在执行前也过同一道门禁", async () => {
    ctx = await setup(fakeAll());
    const t = await ctx.register();
    const store = await connectStore(ctx, t);
    const item = await collect(ctx, t);
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.id], storeIds: [store.id] },
      t,
    );
    const list = await ctx.api("GET", "/api/listings", undefined, t);
    const lid = list.body.items[0].id;
    await ctx.api("POST", "/api/listings/publish", { ids: [lid] }, t);
    // 排队后再加禁售词 → job 执行时被拦（permanent → status failed）
    await ctx.api(
      "PATCH",
      `/api/stores/${store.id}`,
      { rules: { bannedWords: ["杯子"] } },
      t,
    );
    await drain(ctx);
    const cur = await ctx.api("GET", `/api/listings/${lid}`, undefined, t);
    expect(cur.body.status).toBe("failed");
    expect(cur.body.lastError).toContain("禁售词");
  });
});

describe("AI 用量计量", () => {
  it("AI 调用落 ai_usage（含 tokens）", async () => {
    ctx = await setup(fakeAll());
    ctx.deps.config.ai = { baseUrl: "https://ai.test/v1", apiKey: "k", model: "m" };
    const t = await ctx.register();
    const store = await connectStore(ctx, t);
    const item = await collect(ctx, t);
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.id], storeIds: [store.id] },
      t,
    );
    await drain(ctx);
    const usage = await ctx.deps.db.query.aiUsage.findMany();
    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({
      model: "m",
      promptTokens: 11,
      completionTokens: 22,
      totalTokens: 33,
      status: "ok",
    });
  });
});
