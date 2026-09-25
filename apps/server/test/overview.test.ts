import { afterEach, describe, expect, it } from "vitest";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, setup } from "./helpers.js";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";
import { aiUsage } from "../src/db/schema.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe("overview", () => {
  it("returns pipeline counts and recent results", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();

    const empty = (await ctx.api("GET", "/api/overview", undefined, t)).body;
    expect(empty).toMatchObject({
      collectBox: { total: 0, unclaimed: 0 },
      listings: { draft: 0, publishing: 0, published: 0, failed: 0 },
      jobs: { pending: 0, running: 0, failed24h: 0 },
      ai24h: { calls: 0, tokens: 0, errors: 0 },
      recentResults: [],
    });

    const store = (
      await ctx.api(
        "POST",
        "/api/stores/shopify",
        { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
        t,
      )
    ).body;
    const item = (await ctx.api("POST", "/api/collect", harvest("77", "概览杯"), t)).body.item;
    await ctx.api("POST", "/api/source-items/claim", { ids: [item.id], storeIds: [store.id] }, t);
    const listing = (await ctx.api("GET", "/api/listings", undefined, t)).body.items[0];
    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    while (await runOnce(ctx.deps, jobHandlers)) {
      /* drain */
    }

    const ws = (await ctx.api("GET", "/api/auth/me", undefined, t)).body.workspace.id;
    await ctx.deps.db.insert(aiUsage).values([
      { workspaceId: ws, model: "m", promptTokens: 100, completionTokens: 50, totalTokens: 150 },
      { workspaceId: ws, model: "m", totalTokens: 30, status: "error", error: "x" },
    ]);

    const o = (await ctx.api("GET", "/api/overview", undefined, t)).body;
    expect(o.ai24h).toEqual({ calls: 2, tokens: 180, errors: 1 });
    expect(o.collectBox).toEqual({ total: 1, unclaimed: 0 });
    expect(o.listings).toMatchObject({ draft: 0, published: 1 });
    expect(o.recentResults).toHaveLength(1);
    expect(o.recentResults[0]).toMatchObject({ id: listing.id, title: "概览杯", status: "published" });
  });

  it("is scoped to the workspace", async () => {
    ctx = await setup();
    const t1 = await ctx.register();
    const t2 = await ctx.register("b@test.dev");
    await ctx.api("POST", "/api/collect", harvest("88", "隔离杯"), t1);

    const mine = (await ctx.api("GET", "/api/overview", undefined, t1)).body;
    const theirs = (await ctx.api("GET", "/api/overview", undefined, t2)).body;
    expect(mine.collectBox.total).toBe(1);
    expect(theirs.collectBox.total).toBe(0);
    expect(theirs.recentResults).toEqual([]);
  });
});
