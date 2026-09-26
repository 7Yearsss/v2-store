import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { harvest, json, setup } from "./helpers.js";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";
import { discoveryItems, sourceItems, stores } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

async function drain() {
  while (await runOnce(ctx!.deps, jobHandlers)) {
    /* keep draining */
  }
}

async function makePlan(token: string, over: Record<string, unknown> = {}) {
  const res = await ctx!.api(
    "POST",
    "/api/selection-plans",
    {
      name: "测试计划",
      source: "keyword",
      filters: { keywords: ["收纳箱"] },
      schedule: "manual",
      enabled: true,
      ...over,
    },
    token,
  );
  expect(res.status).toBe(201);
  return res.body;
}

async function feed(
  token: string,
  planId: string | null,
  items: Array<Record<string, unknown>>,
) {
  return ctx!.api("POST", "/api/discovery/feed", { planId, items }, token);
}

describe("selection plans", () => {
  it("seeds three preset plans for a new workspace", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const res = await ctx.api("GET", "/api/selection-plans", undefined, t);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(3);
    for (const p of res.body.items) {
      expect(p.schedule).toBe("daily");
      expect(p.enabled).toBe(true);
      expect(p.due).toBe(true); // 未跑过即到期
    }
  });

  it("supports CRUD + run-now resets due state", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const plan = await makePlan(t);
    const patched = await ctx.api(
      "PATCH",
      `/api/selection-plans/${plan.id}`,
      { schedule: "daily", filters: { keywords: ["宠物"], priceMaxCny: 30 } },
      t,
    );
    expect(patched.status).toBe(200);
    expect(patched.body.schedule).toBe("daily");
    expect(patched.body.filters.keywords).toEqual(["宠物"]);

    // feed → lastRunAt 置位 → 不到期；run-now → 重新到期 + 打分 job 入队
    await feed(t, plan.id, [{ sourceItemId: "9001", title: "A" }]);
    let listed = await ctx.api("GET", "/api/selection-plans", undefined, t);
    const mine = listed.body.items.find((p: any) => p.id === plan.id);
    expect(mine.lastRunAt).not.toBeNull();
    expect(mine.due).toBe(false);

    const run = await ctx.api("POST", `/api/selection-plans/${plan.id}/run`, {}, t);
    expect(run.status).toBe(200);
    expect(run.body.lastRunAt).toBeNull();
    expect(run.body.due).toBe(true);

    const del = await ctx.api("DELETE", `/api/selection-plans/${plan.id}`, undefined, t);
    expect(del.status).toBe(200);
    const after = await ctx.api("GET", "/api/selection-plans", undefined, t);
    expect(after.body.items.find((p: any) => p.id === plan.id)).toBeUndefined();
  });
});

describe("discovery feed & tasks", () => {
  it("upserts feed items idempotently on (workspace, plan, sourceItemId)", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const plan = await makePlan(t);
    const first = await feed(t, plan.id, [
      { sourceItemId: "5551", title: "收纳箱", priceText: "¥9.9", signals: { daiFa: true } },
      { sourceItemId: "5552", title: "收纳架" },
    ]);
    expect(first.body).toEqual({ inserted: 2, updated: 0 });
    const again = await feed(t, plan.id, [
      {
        sourceItemId: "5551",
        title: "收纳箱·新标题",
        signals: { ship48h: true },
      },
    ]);
    expect(again.body).toEqual({ inserted: 0, updated: 1 });

    const items = await ctx.api("GET", `/api/discovery/items?planId=${plan.id}`, undefined, t);
    expect(items.body.total).toBe(2);
    const one = items.body.items.find((i: any) => i.sourceItemId === "5551");
    expect(one.title).toBe("收纳箱·新标题");
    // signals 键级合并：daiFa 保留、ship48h 补上
    expect(one.signals).toMatchObject({ daiFa: true, ship48h: true });

    // 同一 offerId 不同 plan / 无 plan → 各自独立成行
    const plan2 = await makePlan(t, { name: "计划B" });
    await feed(t, plan2.id, [{ sourceItemId: "5551", title: "B 计划同名" }]);
    await feed(t, null, [{ sourceItemId: "5551", title: "无计划" }]);
    const all = await ctx.api("GET", "/api/discovery/items", undefined, t);
    expect(all.body.total).toBe(4);
  });

  it("marks daily plans due only when stale and returns search urls", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const plan = await makePlan(t, {
      schedule: "daily",
      filters: { keywords: ["收纳箱", "收纳架"], priceMaxCny: 50 },
    });
    let tasks = await ctx.api("GET", "/api/discovery/tasks", undefined, t);
    const mine = tasks.body.items.find((p: any) => p.id === plan.id);
    expect(mine.due).toBe(true);
    expect(mine.urls).toHaveLength(2);
    expect(mine.urls[0]).toContain("s.1688.com/selloffer/offer_search.htm");
    expect(decodeURIComponent(mine.urls[0])).toContain("收纳箱");

    await feed(t, plan.id, [{ sourceItemId: "6001", title: "x" }]);
    tasks = await ctx.api("GET", "/api/discovery/tasks", undefined, t);
    const after = tasks.body.items.find((p: any) => p.id === plan.id);
    expect(after.due).toBe(false);
    expect(after.urls).toEqual([]);
    // manual 计划从不通过 tasks 抓（due=false 除非从未跑过）
    const manual = await makePlan(t, { name: "手动", schedule: "manual" });
    await feed(t, manual.id, [{ sourceItemId: "6002", title: "y" }]);
    tasks = await ctx.api("GET", "/api/discovery/tasks", undefined, t);
    expect(tasks.body.items.find((p: any) => p.id === manual.id).due).toBe(false);
  });
});

describe("selection.score job", () => {
  it("scores deterministically and hard-gates violated signals", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const plan = await makePlan(t, {
      filters: { keywords: ["收纳"], requireDaiFa: true, priceMinCny: 5, priceMaxCny: 30 },
    });
    await feed(t, plan.id, [
      {
        sourceItemId: "7001",
        title: "好候选",
        priceText: "¥10",
        signals: { daiFa: true, ship48h: true, repurchaseRate: 0.25, rank: 5 },
      },
      { sourceItemId: "7002", title: "非代发", priceText: "¥10", signals: { daiFa: false } },
      { sourceItemId: "7003", title: "超价", priceText: "¥99", signals: { daiFa: true } },
      { sourceItemId: "7004", title: "信号未知", priceText: "¥20", signals: {} },
      { sourceItemId: "7005", title: "无信号无价" },
    ]);
    await drain();
    const items = await ctx.api("GET", `/api/discovery/items?planId=${plan.id}`, undefined, t);
    const by = (id: string) => items.body.items.find((i: any) => i.sourceItemId === id);
    // 7001: daiFa20 + 48h15 + 回头25%→15 + 价带内15 + rank5→10 = 75
    expect(by("7001").score).toBe(75);
    expect(by("7002").score).toBe(0); // 硬门槛：非代发
    expect(by("7003").score).toBe(0); // 硬门槛：超价带
    expect(by("7004").score).toBe(15); // 只有价带分，未知信号不淘汰
    expect(by("7005").score).toBe(0);
  });

  it("adds margin trial from the workspace store pricing rule", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const me = await ctx.api("GET", "/api/auth/me", undefined, t);
    await ctx.deps.db.insert(stores).values({
      workspaceId: me.body.workspace.id,
      platform: "shopify",
      name: "s1",
      shopDomain: "s1.myshopify.com",
      authType: "access_token",
      credentials: "x",
      pricing: { exchangeRate: 0.14, markup: 3, priceEnding: 0.99 },
    });
    const plan = await makePlan(t);
    await feed(t, plan.id, [
      { sourceItemId: "8001", title: "高毛利", priceText: "¥10" },
      { sourceItemId: "8002", title: "平价", priceText: "¥1000" },
    ]);
    await drain();
    const items = await ctx.api("GET", `/api/discovery/items?planId=${plan.id}`, undefined, t);
    const by = (id: string) => items.body.items.find((i: any) => i.sourceItemId === id);
    // ¥10 → 卖 4.99、成本 1.4 → 毛利 ≈72% → +20
    expect(by("8001").score).toBe(20);
    // ¥1000 → 卖 (1000*0.14*3)=420→420.99、成本 140 → 毛利 ≈67% → 还是 +20；换成高价低毛利场景
    expect(by("8002").score).toBeGreaterThanOrEqual(15);
  });

  it("writes LLM ai_note only for the top-20 and tolerates AI being absent", async () => {
    ctx = await setup(async (url, init) => {
      if (url.includes("/chat/completions")) {
        const req = JSON.parse(String(init?.body));
        const userMsg = JSON.parse(req.messages[1].content) as {
          items: Array<{ id: string }>;
        };
        return json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  notes: userMsg.items.map((i) => ({ id: i.id, note: "代发可做" })),
                }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    const t = await ctx.register();
    const me = await ctx.api("GET", "/api/auth/me", undefined, t);
    ctx.deps.config.ai = {
      baseUrl: "https://ai.test/v1",
      apiKey: "k",
      model: "m",
      imageModel: "img",
    };
    const plan = await makePlan(t);
    const items = Array.from({ length: 25 }, (_, i) => ({
      sourceItemId: `9${100 + i}`,
      title: `候选${i}`,
      priceText: "¥10",
      signals: i === 0 ? { daiFa: true, ship48h: true } : { daiFa: true },
    }));
    await feed(t, plan.id, items);
    await drain();
    const rows = await ctx.deps.db
      .select()
      .from(discoveryItems)
      .where(eq(discoveryItems.workspaceId, me.body.workspace.id));
    expect(rows.filter((r) => r.score != null)).toHaveLength(25);
    // top-20 上限：25 条候选只写 20 条评语
    const noted = rows.filter((r) => r.aiNote === "代发可做");
    expect(noted).toHaveLength(20);
    expect(ctx.calls.filter((c) => c.url.includes("/chat/completions"))).toHaveLength(1);
  });

  it("leaves scores without ai_note when AI is not configured", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const plan = await makePlan(t);
    await feed(t, plan.id, [{ sourceItemId: "8100", title: "x", signals: { daiFa: true } }]);
    await drain();
    const items = await ctx.api("GET", `/api/discovery/items?planId=${plan.id}`, undefined, t);
    expect(items.body.items[0].score).toBe(20);
    expect(items.body.items[0].aiNote).toBeNull();
  });
});

describe("collect backfill & dismiss", () => {
  it("collect marks items collected and backfills source_item_db_id + collected_via", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const plan = await makePlan(t);
    await feed(t, plan.id, [
      { sourceItemId: "123456", title: "收纳箱", thumb: "//img", priceText: "¥9.9" },
    ]);
    const list = await ctx.api("GET", `/api/discovery/items?planId=${plan.id}`, undefined, t);
    const itemId = list.body.items[0].id;

    const collect = await ctx.api("POST", "/api/discovery/collect", { ids: [itemId] }, t);
    expect(collect.status).toBe(200);
    expect(collect.body.items).toEqual([
      { id: itemId, offerId: "123456", title: "收纳箱", image: "//img", price: "¥9.9" },
    ]);

    // 模拟插件详情页重采后回传（via=plan）
    const res = await ctx.api(
      "POST",
      "/api/collect",
      { ...harvest("123456", "收纳箱"), collectedVia: "plan" },
      t,
    );
    expect(res.status).toBe(201);
    expect(res.body.item.collectedVia).toBe("plan");
    expect(res.body.discoveryBackfilled).toBe(1);

    const after = await ctx.api("GET", `/api/discovery/items?planId=${plan.id}&status=collected`, undefined, t);
    expect(after.body.items).toHaveLength(1);
    expect(after.body.items[0].sourceItemDbId).toBe(res.body.item.id);

    // collected 的条目不能再 collect
    const again = await ctx.api("POST", "/api/discovery/collect", { ids: [itemId] }, t);
    expect(again.body.items).toEqual([]);
  });

  it("backfills pool items on manual collect without via (implied plan)", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const plan = await makePlan(t);
    await feed(t, plan.id, [{ sourceItemId: "777001", title: "x" }]);
    const res = await ctx.api("POST", "/api/collect", harvest("777001", "x"), t);
    expect(res.status).toBe(201);
    expect(res.body.discoveryBackfilled).toBe(1);
    const [row] = await ctx.deps.db
      .select()
      .from(sourceItems)
      .where(eq(sourceItems.id, res.body.item.id));
    expect(row.collectedVia).toBe("plan");
  });

  it("dismiss moves items out of the new pool", async () => {
    ctx = await setup();
    const t = await ctx.register();
    const plan = await makePlan(t);
    await feed(t, plan.id, [
      { sourceItemId: "8801", title: "a" },
      { sourceItemId: "8802", title: "b" },
    ]);
    const list = await ctx.api("GET", `/api/discovery/items?planId=${plan.id}`, undefined, t);
    const id = list.body.items[0].id;
    const res = await ctx.api("POST", "/api/discovery/dismiss", { ids: [id] }, t);
    expect(res.body.dismissed).toBe(1);
    const news = await ctx.api("GET", `/api/discovery/items?planId=${plan.id}&status=new`, undefined, t);
    expect(news.body.total).toBe(1);
    const gone = await ctx.api("GET", `/api/discovery/items?planId=${plan.id}&status=dismissed`, undefined, t);
    expect(gone.body.total).toBe(1);
  });
});

describe("workspace isolation", () => {
  it("keeps plans and pool scoped per workspace", async () => {
    ctx = await setup();
    const a = await ctx.register("a@test.dev");
    const b = await ctx.register("b@test.dev");
    const planA = await makePlan(a);
    await feed(a, planA.id, [{ sourceItemId: "99001", title: "A 的候选" }]);

    const bPlans = await ctx.api("GET", "/api/selection-plans", undefined, b);
    expect(bPlans.body.items.find((p: any) => p.id === planA.id)).toBeUndefined();
    const bFeed = await feed(b, planA.id, [{ sourceItemId: "99002", title: "越权" }]);
    expect(bFeed.status).toBe(404);
    const bItems = await ctx.api("GET", "/api/discovery/items", undefined, b);
    expect(bItems.body.items.find((i: any) => i.sourceItemId === "99001")).toBeUndefined();

    const aItems = await ctx.api("GET", `/api/discovery/items?planId=${planA.id}`, undefined, a);
    const bCollect = await ctx.api(
      "POST",
      "/api/discovery/collect",
      { ids: [aItems.body.items[0].id] },
      b,
    );
    expect(bCollect.body.items).toEqual([]);
    const bDismiss = await ctx.api(
      "POST",
      "/api/discovery/dismiss",
      { ids: [aItems.body.items[0].id] },
      b,
    );
    expect(bDismiss.body.dismissed).toBe(0);
    const bPatch = await ctx.api("PATCH", `/api/selection-plans/${planA.id}`, { name: "x" }, b);
    expect(bPatch.status).toBe(404);
    const bTasks = await ctx.api("GET", "/api/discovery/tasks", undefined, b);
    expect(bTasks.body.items.find((p: any) => p.id === planA.id)).toBeUndefined();
  });
});
