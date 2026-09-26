import { afterEach, describe, expect, it } from "vitest";
import type { PipelinePolicy, StoreRules } from "@caiji/shared";
import { jobHandlers } from "../src/jobs/handlers.js";
import { enqueue, runOnce } from "../src/jobs/queue.js";
import { publishAttempts, publishRuns } from "../src/db/schema.js";
import { fakeShopify } from "./fakeShopify.js";
import { json, setup, type FakeFetch } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const AI_URL = "https://ai.test/v1/chat/completions";

/** fakeShopify + AI 应答（类目两问 + enhance 默认应答），与 category.test 同构。 */
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
  c.deps.config.ai = { baseUrl: "https://ai.test/v1", apiKey: "k", model: "m", imageModel: "imgm" };
}

async function makeStore(
  c: Awaited<ReturnType<typeof setup>>,
  t: string,
  rules?: StoreRules,
) {
  const store = (
    await c.api(
      "POST",
      "/api/stores/shopify",
      { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
      t,
    )
  ).body;
  if (rules) {
    await c.api("PATCH", `/api/stores/${store.id}`, { rules }, t);
  }
  return store;
}

/** 带类目信息的采集载荷（categorySuggest stage 需要 sourceCategoryId）。 */
function collectBody(offerId: string, categoryId = "cat-1688-9") {
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
        title: "链路杯",
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

const drain = async (c: Awaited<ReturnType<typeof setup>>) => {
  while (await runOnce(c.deps, jobHandlers)) {
    /* drain */
  }
};

/** collect → autoClaim 店 → listing.claim → 链路跑完一轮 → 返回产生的 listing
 * （listing 在 claim job 内创建，collect 本身不落刊登）。 */
async function collectPipeline(
  c: Awaited<ReturnType<typeof setup>>,
  t: string,
  offerId: string,
) {
  await c.api("POST", "/api/collect", collectBody(offerId), t);
  await drain(c);
  const list = await c.api("GET", "/api/listings", undefined, t);
  return list.body.items[0];
}

/** 排空到「advance 已在排但尚未执行」为止（用来在自动推进前插桩）。 */
async function drainUntilAdvanceQueued(c: Awaited<ReturnType<typeof setup>>) {
  while (true) {
    const pending = (await c.deps.db.query.jobs.findMany()).some(
      (j) => j.type === "pipeline.advance" && j.status === "queued",
    );
    if (pending) return;
    if (!(await runOnce(c.deps, jobHandlers))) return;
  }
}

const AUTO: PipelinePolicy = { holdPoint: "auto", autoPublish: true, publishMode: "now" };

describe("一键链路", () => {
  it("认领并发布：advance=true → 策略全开跑完 published（autoAccept 全字段 + 学习映射）", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const store = await makeStore(ctx, t, {
      pipeline: { autoAcceptFields: ["title", "category"], holdPoint: "after_ai" },
    });
    const item = (
      await ctx.api("POST", "/api/collect", collectBody("p1"), t)
    ).body.item;
    const res = await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.id], storeIds: [store.id], advance: true },
      t,
    );
    expect(res.body.created).toBe(1);
    const listing = (await ctx.api("GET", "/api/listings", undefined, t)).body.items[0];
    expect(listing.pipelineStage).toBe("claimed");

    await drain(ctx);

    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.status).toBe("published");
    expect(cur.body.pipelineStage).toBe("published");
    expect(cur.body.remoteId).toBe("gid://shopify/Product/42");
    // advancePolicy 把店铺的 after_ai 全开 → 不卡；白名单字段已应用 + 类目映射已学习
    expect(cur.body.title).toBe("AI Title");
    expect(cur.body.channelCategoryId).toBe("gid://shopify/TaxonomyCategory/c2");
    const maps = await ctx.api("GET", "/api/category-mappings", undefined, t);
    expect(maps.body.items[0]?.confirmedBy).toBe("ai");
    // remoteVariantMap 回填（本地 sku = 货源 id-序号）
    expect(cur.body.remoteVariantMap?.["p1-1"]?.variantId).toBe("gid://shopify/ProductVariant/v0");
    expect(cur.body.remoteVariantMap?.["p1-1"]?.inventoryItemId).toBe(
      "gid://shopify/InventoryItem/i0",
    );
  });

  it("holdPoint=after_ai：autoClaim 链路卡在 AI 审核，REST 推进后发布", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    await makeStore(ctx, t, {
      pipeline: { autoClaim: true, autoPublish: true, publishMode: "now", holdPoint: "after_ai" },
    });
    const listing = await collectPipeline(ctx, t, "p2");
    await drain(ctx);

    let cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("hold_ai");
    expect(cur.body.pipelineHoldReason).toContain("人工审核");
    expect(cur.body.status).toBe("draft");
    const sug = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    expect(sug.body.items.filter((s: any) => s.status === "pending").length).toBeGreaterThan(0);

    await ctx.api("POST", `/api/listings/${listing.id}/pipeline/advance`, {}, t);
    await drain(ctx);
    cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("published");
    expect(cur.body.status).toBe("published");
  });

  it("holdPoint=after_precheck 卡发布前检查；autoPublish=false 停在 precheck 待推进", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    await makeStore(ctx, t, {
      pipeline: {
        autoClaim: true,
        autoPublish: true,
        publishMode: "now",
        holdPoint: "after_precheck",
      },
    });
    const listing = await collectPipeline(ctx, t, "p3a");
    await drain(ctx);
    let cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("hold_precheck");
    expect(cur.body.status).toBe("draft");
    await ctx.api("POST", `/api/listings/${listing.id}/pipeline/advance`, {}, t);
    await drain(ctx);
    cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("published");

    // autoPublish=false：链路停在 precheck，人工推进才发
    const s2 = await makeStore(ctx, t, {
      pipeline: { autoClaim: true, autoPublish: false, publishMode: "now", holdPoint: "auto" },
    });
    await ctx.api("POST", "/api/collect", collectBody("p3b"), t);
    await drain(ctx);
    const l2 = (await ctx.api("GET", "/api/listings", undefined, t)).body.items.find(
      (l: any) => l.storeId === s2.id,
    );
    cur = await ctx.api("GET", `/api/listings/${l2.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("precheck");
    expect(cur.body.status).toBe("draft");
    await ctx.api("POST", `/api/listings/${l2.id}/pipeline/advance`, {}, t);
    await drain(ctx);
    cur = await ctx.api("GET", `/api/listings/${l2.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("published");
  });

  it("paced 顺延：同店第二件排到 第一件+paceMinutes；手动推进提前放行", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    await makeStore(ctx, t, {
      pipeline: {
        autoClaim: true,
        autoPublish: true,
        publishMode: "paced",
        paceMinutes: 120,
        holdPoint: "auto",
      },
    });
    const l1 = await collectPipeline(ctx, t, "p4a");
    const l2 = await collectPipeline(ctx, t, "p4b");
    await drain(ctx);

    const l1cur = await ctx.api("GET", `/api/listings/${l1.id}`, undefined, t);
    expect(l1cur.body.pipelineStage).toBe("published");
    const l2cur = await ctx.api("GET", `/api/listings/${l2.id}`, undefined, t);
    expect(l2cur.body.pipelineStage).toBe("queued");
    expect(l2cur.body.status).toBe("draft"); // 排队中保持草稿可编辑
    const gap =
      new Date(l2cur.body.publishAt).getTime() - new Date(l1cur.body.publishedAt).getTime();
    expect(gap).toBeGreaterThanOrEqual(119 * 60_000);
    expect(gap).toBeLessThanOrEqual(121 * 60_000);
    // 未来 runAt 的发布 job 留在队列
    const queuedPub = (await ctx.deps.db.query.jobs.findMany()).filter(
      (j) => j.type === "listing.publish" && j.status === "queued",
    );
    expect(queuedPub.length).toBe(1);
    // 手动推进 = 提前放行排队中的发布
    await ctx.api("POST", `/api/listings/${l2.id}/pipeline/advance`, {}, t);
    await drain(ctx);
    expect(
      (await ctx.api("GET", `/api/listings/${l2.id}`, undefined, t)).body.pipelineStage,
    ).toBe("published");
  });

  it("scheduled：publishAt 未来时 → 排队到点不立即发", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const future = new Date(Date.now() + 30 * 60_000).toISOString();
    await makeStore(ctx, t, {
      pipeline: {
        autoClaim: true,
        autoPublish: true,
        publishMode: "scheduled",
        publishAt: future,
        holdPoint: "auto",
      },
    });
    const listing = await collectPipeline(ctx, t, "p4c");
    await drain(ctx);
    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("queued");
    expect(cur.body.status).toBe("draft");
    expect(new Date(cur.body.publishAt).getTime()).toBeGreaterThan(Date.now() + 25 * 60_000);
  });

  it("白名单越界：未白名单字段不自动应用、建议留 pending", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    await makeStore(ctx, t, {
      pipeline: { ...AUTO, autoClaim: true, autoAcceptFields: ["title"] },
    });
    const listing = await collectPipeline(ctx, t, "p5");
    await drain(ctx);
    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.title).toBe("AI Title"); // 白名单内 → 已应用
    expect(cur.body.channelCategoryId).toBeNull(); // 白名单外 → 不应用
    const sug = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    const pending = sug.body.items.filter((s: any) => s.status === "pending");
    expect(pending.some((s: any) => s.field === "category")).toBe(true);
    expect(cur.body.pipelineStage).toBe("published"); // 类目非阻塞，链路照常发布
  });

  it("熔断：当日失败率 >50% 且样本 >5 → 自动发布停排，手动可越过", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const store = await makeStore(ctx, t, { pipeline: { ...AUTO, autoClaim: true } });
    const ws = (await ctx.api("GET", "/api/auth/me", undefined, t)).body.workspace.id;

    await ctx.api("POST", "/api/collect", collectBody("p6"), t);
    // 跑到 advance 已排未跑：listing 已建但自动发布尚未判定
    await drainUntilAdvanceQueued(ctx);
    const listing = (await ctx.api("GET", "/api/listings", undefined, t)).body.items[0];

    // 造样本：6 个今日失败 attempt（熔断在 advance 判定点检查）
    const [run] = await ctx.deps.db
      .insert(publishRuns)
      .values({ workspaceId: ws, listingIds: [listing.id], status: "failed" })
      .returning({ id: publishRuns.id });
    await ctx.deps.db.insert(publishAttempts).values(
      Array.from({ length: 6 }, () => ({
        workspaceId: ws,
        runId: run!.id,
        listingId: listing.id,
        storeId: store.id,
        status: "failed" as const,
        fieldsSnapshot: {
          title: "x",
          descriptionHtml: "",
          images: [],
          descImages: [],
          options: [],
          variants: [],
          tags: [],
          productType: "",
          vendor: "",
          weightKg: null,
          channelCategoryId: null,
          channelCategoryName: null,
          channelAttributes: [],
        },
      })),
    );

    await drain(ctx);
    let cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("hold_precheck");
    expect(cur.body.pipelineHoldReason).toContain("熔断");
    const audits = (await ctx.api("GET", `/api/listings/${listing.id}/audits`, undefined, t)).body
      .audits;
    expect(audits.some((a: any) => a.action === "pipeline.circuit_open")).toBe(true);

    // 手动推进越过熔断
    await ctx.api("POST", `/api/listings/${listing.id}/pipeline/advance`, {}, t);
    await drain(ctx);
    cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("published");
  });

  it("幂等：重复 claim+advance 不重复建刊登、不二次入场", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const store = await makeStore(ctx, t, { pipeline: AUTO });
    const item = (await ctx.api("POST", "/api/collect", collectBody("p7"), t)).body.item;
    const r1 = await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.id], storeIds: [store.id], advance: true },
      t,
    );
    expect(r1.body.created).toBe(1);
    const r2 = await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [item.id], storeIds: [store.id], advance: true },
      t,
    );
    expect(r2.body.created).toBe(0);
    expect(r2.body.skipped).toBe(1);
    const list = await ctx.api("GET", "/api/listings", undefined, t);
    expect(list.body.items.length).toBe(1);
    await drain(ctx);
    const cur = await ctx.api("GET", `/api/listings/${list.body.items[0].id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("published");
    // 发布只建一条 attempt（第二个 claim 对在途链路只做手动推进）
    const atts = await ctx.deps.db.query.publishAttempts.findMany();
    expect(atts.length).toBe(1);
  });

  it("stage 重跑只覆盖自己 stage 的 pending；已接受不动", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    const store = await makeStore(ctx, t, { pipeline: { ...AUTO, autoClaim: true } });
    const listing = await collectPipeline(ctx, t, "p8");
    await drain(ctx);

    const before = (await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t))
      .body.items;
    const catSug = before.find((s: any) => s.field === "category");
    const titleSug = before.find((s: any) => s.field === "title");
    expect(catSug?.stage).toBe("categorySuggest");
    expect(titleSug?.stage).toBe("enhance");
    // 接受 title 后只重跑 categorySuggest stage
    await ctx.api(
      "POST",
      `/api/listings/${listing.id}/suggestions/decide`,
      { decisions: [{ id: titleSug.id, action: "accept" }] },
      t,
    );
    const ws = (await ctx.api("GET", "/api/auth/me", undefined, t)).body.workspace.id;
    await enqueue(
      ctx.deps.db,
      "listing.categorySuggest",
      { listingId: listing.id },
      { workspaceId: ws },
    );
    await drain(ctx);

    const after = (await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t))
      .body.items;
    // enhance 的已接受建议原样保留
    expect(after.find((s: any) => s.id === titleSug.id)?.status).toBe("accepted");
    // categorySuggest 的旧 pending 被新行替换
    expect(after.find((s: any) => s.id === catSug.id)).toBeUndefined();
    expect(
      after.find((s: any) => s.field === "category" && s.status === "pending"),
    ).toBeTruthy();
  });

  it("disabledStages：关掉 categorySuggest 后不产类目建议", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    await makeStore(ctx, t, {
      pipeline: { ...AUTO, autoClaim: true, disabledStages: ["categorySuggest"] },
    });
    const listing = await collectPipeline(ctx, t, "p9");
    await drain(ctx);
    const sug = await ctx.api("GET", `/api/listings/${listing.id}/suggestions`, undefined, t);
    expect(sug.body.items.some((s: any) => s.field === "category")).toBe(false);
  });

  it("暂停/取消：暂停打 manual 标记；取消清链路字段", async () => {
    ctx = await setup(fakeAll());
    enableAi(ctx);
    const t = await ctx.register();
    await makeStore(ctx, t, {
      pipeline: { autoClaim: true, autoPublish: true, publishMode: "now", holdPoint: "after_ai" },
    });
    const listing = await collectPipeline(ctx, t, "p11");
    await drain(ctx);
    let cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("hold_ai");

    await ctx.api("POST", `/api/listings/${listing.id}/pipeline/pause`, {}, t);
    cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineHoldReason).toBe("manual");

    // 取消 → pipeline 字段清空，刊登留草稿
    await ctx.api("POST", `/api/listings/${listing.id}/pipeline/cancel`, {}, t);
    cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBeNull();
    expect(cur.body.pipelineHoldReason).toBeNull();
    expect(cur.body.status).toBe("draft");
    const pending = (await ctx.deps.db.query.jobs.findMany()).filter(
      (j) =>
        j.type === "pipeline.advance" &&
        j.status === "queued" &&
        String(j.payload?.listingId) === listing.id,
    );
    expect(pending.length).toBe(0);
  });

  it("发布失败 → stage=failed + 原因；跨 workspace 隔离", async () => {
    const shopifyFail = fakeShopify({
      productSetErrors: [{ message: "fake publish boom" }],
    });
    ctx = await setup((url, init) =>
      url === AI_URL
        ? json({ choices: [{ message: { content: '{"title":"AI Title","tags":["t"]}' } }] })
        : shopifyFail(url, init),
    );
    enableAi(ctx);
    const t = await ctx.register();
    const t2 = await ctx.register("b@test.dev");
    await makeStore(ctx, t, { pipeline: { ...AUTO, autoClaim: true } });
    const listing = await collectPipeline(ctx, t, "p12");
    await drain(ctx);

    const cur = await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t);
    expect(cur.body.pipelineStage).toBe("failed");
    expect(cur.body.pipelineHoldReason).toContain("boom");
    expect(cur.body.status).toBe("failed");

    // 跨 workspace：看不到刊登、REST 全 404
    expect((await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t2)).status).toBe(404);
    for (const act of ["advance", "pause", "cancel"]) {
      expect(
        (await ctx.api("POST", `/api/listings/${listing.id}/pipeline/${act}`, {}, t2)).status,
      ).toBe(404);
    }
    expect((await ctx.api("GET", "/api/listings", undefined, t2)).body.items.length).toBe(0);
  });
});
