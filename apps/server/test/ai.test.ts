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
const AI_REPLY = {
  title: "Insulated Water Bottle 500ml Leakproof",
  descriptionHtml: "<p>Keep drinks cold for 24h.</p><ul><li>304 stainless steel</li></ul>",
  productType: "Water Bottle",
  tags: ["water bottle", "insulated", "bpa free"],
  options: [
    { name: "Color", values: ["Red"] },
    { name: "Size", values: ["M", "L"] },
  ],
};

/** fakeShopify + a canned AI chat reply. */
function fakeAll(aiReply: unknown = AI_REPLY): FakeFetch {
  const shopify = fakeShopify();
  return (url, init) => {
    if (url === AI_URL) {
      return json({ choices: [{ message: { content: JSON.stringify(aiReply) } }] });
    }
    return shopify(url, init);
  };
}

function enableAi(c: Awaited<ReturnType<typeof setup>>) {
  c.deps.config.ai = { baseUrl: "https://ai.test/v1", apiKey: "k", model: "m", imageModel: "imgm" };
}

async function claimOne(c: Awaited<ReturnType<typeof setup>>, t: string) {
  const store = await c.api(
    "POST",
    "/api/stores/shopify",
    { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
    t,
  );
  const item = await c.api("POST", "/api/collect", harvest("777", "保温水杯"), t);
  const claim = await c.api(
    "POST",
    "/api/source-items/claim",
    { ids: [item.body.item.id], storeIds: [store.body.id] },
    t,
  );
  const list = await c.api("GET", "/api/listings", undefined, t);
  return { store: store.body, claim: claim.body, listing: list.body.items[0] };
}

const drain = async (c: Awaited<ReturnType<typeof setup>>) => {
  while (await runOnce(c.deps, jobHandlers)) {
    /* drain */
  }
};

describe("AI 产线", () => {
  it("认领后自动生成字段级建议，pending 随任务结束清除", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const { claim, listing } = await claimOne(ctx, t);
    expect(claim).toEqual({ created: 1, skipped: 0 });

    let res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    expect(res.body.pending).toBe(true);
    expect(res.body.items).toEqual([]);

    await drain(ctx);

    res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    expect(res.body.pending).toBe(false);
    const byField = Object.fromEntries(res.body.items.map((s: any) => [s.field, s]));
    expect(byField.title.value).toBe(AI_REPLY.title);
    expect(byField.descriptionHtml.value).toContain("cold for 24h");
    expect(byField.tags.value).toEqual(AI_REPLY.tags);
    expect(byField.options.value.options[0].name).toBe("Color");
    expect(byField.options.value.variantOptionValues).toEqual([
      ["Red", "M"],
      ["Red", "L"],
    ]);

    // 刊登本体未被改动
    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.title).toBe("保温水杯");
  });

  it("接受写入刊登、回退标记，选项按序映射到变体", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const { listing } = await claimOne(ctx, t);
    await drain(ctx);

    const res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    const byField = Object.fromEntries(res.body.items.map((s: any) => [s.field, s]));

    const decide = await ctx.api(
      "POST",
      `/api/listings/${listing.id}/suggestions/decide`,
      {
        decisions: [
          { id: byField.title.id, action: "accept" },
          { id: byField.options.id, action: "accept" },
          { id: byField.tags.id, action: "reject" },
        ],
      },
      t,
    );
    expect(decide.body).toEqual({ accepted: 2, rejected: 1 });

    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.title).toBe(AI_REPLY.title);
    expect(cur.body.tags).toEqual([]);
    expect(cur.body.options.map((o: any) => o.name)).toEqual(["Color", "Size"]);
    expect(cur.body.variants.map((v: any) => v.optionValues)).toEqual([
      ["Red", "M"],
      ["Red", "L"],
    ]);

    const after = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    expect(after.body.items.find((s: any) => s.field === "title").status).toBe("accepted");
    expect(after.body.items.find((s: any) => s.field === "tags").status).toBe("rejected");
  });

  it("店铺关掉 AI 或没配 AI 时认领不排队", async () => {
    ctx = await setup(fakeAll());
    const t = await ctx.register();
    const { store } = await claimOne(ctx, t);
    let jobs = await ctx.deps.db.query.jobs.findMany();
    expect(jobs.filter((j) => j.type === "listing.aiEnhance")).toEqual([]);

    enableAi(ctx);
    await ctx.api("PATCH", `/api/stores/${store.id}`, { aiEnhance: false }, t);
    const item = await ctx.api("POST", "/api/collect", harvest("888", "收纳箱"), t);
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.body.item.id], storeIds: [store.id] },
      t,
    );
    jobs = await ctx.deps.db.query.jobs.findMany();
    expect(jobs.filter((j) => j.type === "listing.aiEnhance")).toEqual([]);
  });

  it("手动触发 + 新一轮会替换未处理的旧建议", async () => {
    ctx = await setup(fakeAll({ title: "First Draft" }));
    enableAi(ctx);
    const t = await ctx.register();
    const { listing } = await claimOne(ctx, t);
    await drain(ctx);

    const rerun = await ctx.api("POST", `/api/listings/${listing.id}/ai-enhance`, {}, t);
    expect(rerun.body.queued).toBe(true);
    await drain(ctx);

    const res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    expect(res.body.items.filter((s: any) => s.status === "pending").length).toBe(
      res.body.items.length,
    );
  });

  it("跨工作区看不到建议", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const t2 = await ctx.register("b@test.dev");
    const { listing } = await claimOne(ctx, t);
    await drain(ctx);
    const res = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t2);
    expect(res.status).toBe(404);
    const decide = await ctx.api(
      "POST",
      `/api/listings/${listing.id}/suggestions/decide`,
      { decisions: [{ id: listing.id, action: "accept" }] },
      t2,
    );
    expect([404, 409]).toContain(decide.status);
  });
});

const IMG_EDIT_URL = "https://ai.test/v1/images/edits";
const SRC_IMG = "https://cbu01.alicdn.com/a.jpg";
// 1x1 PNG
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function fakeAllWithImage(): FakeFetch {
  const base = fakeAll();
  return (url, init) => {
    if (url === IMG_EDIT_URL) {
      return json({ data: [{ b64_json: PNG.toString("base64") }] });
    }
    if (url === SRC_IMG) {
      return new Response(new Uint8Array(PNG), {
        headers: { "Content-Type": "image/png" },
      });
    }
    return base(url, init);
  };
}

describe("AI 图片", () => {
  it("白底图：生成后插在原图后，入媒体库并计量", async () => {
    ctx = await setup(fakeAllWithImage());
    enableAi(ctx);
    const t = await ctx.register();
    const { listing } = await claimOne(ctx, t);

    const res = await ctx.api(
      "POST",
      `/api/listings/${listing.id}/ai-image`,
      { imageUrl: SRC_IMG, action: "whiteBg" },
      t,
    );
    expect(res.body).toEqual({ queued: true });
    // 同图同动作已在队列 → 去重
    const dup = await ctx.api(
      "POST",
      `/api/listings/${listing.id}/ai-image`,
      { imageUrl: SRC_IMG, action: "whiteBg" },
      t,
    );
    expect(dup.body).toEqual({ queued: false });

    await drain(ctx);

    const after = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(after.body.images).toHaveLength(2);
    expect(after.body.images[1]).toMatch(/^\/api\/media\//);

    const { aiUsage } = await import("../src/db/schema.js");
    const usage = await ctx.deps.db.select().from(aiUsage);
    expect(usage.filter((u) => u.model === "image:imgm" && u.status === "ok")).toHaveLength(1);
  });

  it("不在刊登里的图 400，跨工作区 404", async () => {
    ctx = await setup(fakeAllWithImage());
    enableAi(ctx);
    const t = await ctx.register();
    const t2 = await ctx.register("c@test.dev");
    const { listing } = await claimOne(ctx, t);
    const bad = await ctx.api(
      "POST",
      `/api/listings/${listing.id}/ai-image`,
      { imageUrl: "https://cbu01.alicdn.com/not-in-listing.jpg", action: "whiteBg" },
      t,
    );
    expect(bad.status).toBe(400);
    const cross = await ctx.api(
      "POST",
      `/api/listings/${listing.id}/ai-image`,
      { imageUrl: SRC_IMG, action: "whiteBg" },
      t2,
    );
    expect(cross.status).toBe(404);
  });
});
