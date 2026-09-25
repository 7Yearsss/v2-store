import { afterEach, describe, expect, it } from "vitest";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, setup } from "./helpers.js";
import { jobHandlers } from "../src/jobs/handlers.js";
import { enqueue, runOnce } from "../src/jobs/queue.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

describe("jobs api", () => {
  it("lists jobs with labels and retry resets a failed job", async () => {
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
    const item = (await ctx.api("POST", "/api/collect", harvest("55", "任务杯"), t)).body.item;
    await ctx.api("POST", "/api/source-items/claim", { ids: [item.id], storeIds: [store.id] }, t);
    const listing = (await ctx.api("GET", "/api/listings", undefined, t)).body.items[0];

    // enqueue a publish job, then fail it deterministically by exhausting attempts
    const ws = (await ctx.api("GET", "/api/auth/me", undefined, t)).body.workspace.id;
    await enqueue(ctx.deps.db, "listing.publish", { listingId: listing.id }, { workspaceId: ws });
    // run once with a fetch that throws → job marked failed after attempts=3? maxAttempts default 3; force single-attempt job for determinism
    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    while (await runOnce(ctx.deps, jobHandlers)) {
      /* drain — publish succeeds via fakeShopify */
    }

    const list = (await ctx.api("GET", "/api/jobs", undefined, t)).body;
    expect(list.total).toBeGreaterThanOrEqual(1);
    const pub = list.items.find((j: { type: string }) => j.type === "listing.publish");
    expect(pub).toBeTruthy();
    expect(pub.listingId).toBe(listing.id);

    // failed filter: mark a job failed manually through retry cycle
    await enqueue(ctx.deps.db, "listing.publish", { listingId: crypto.randomUUID() }, { workspaceId: ws, maxAttempts: 1 });
    while (await runOnce(ctx.deps, jobHandlers)) {
      /* drain — handler throws on missing listing → failed */
    }
    const failed = (await ctx.api("GET", "/api/jobs?status=failed", undefined, t)).body;
    expect(failed.items.length).toBeGreaterThanOrEqual(1);
    const doomed = failed.items.find((j: { lastError: string | null }) => j.lastError);
    const retry = await ctx.api("POST", `/api/jobs/${doomed.id}/retry`, undefined, t);
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe("queued");
    expect(retry.body.attempts).toBe(0);
  });

  it("is scoped to the workspace", async () => {
    ctx = await setup();
    const t1 = await ctx.register();
    const t2 = await ctx.register("b@test.dev");
    await enqueue(ctx.deps.db, "listing.aiEnhance", { listingId: "x" }, { workspaceId: (await ctx.api("GET", "/api/auth/me", undefined, t1)).body.workspace.id });

    const mine = (await ctx.api("GET", "/api/jobs", undefined, t1)).body;
    const theirs = (await ctx.api("GET", "/api/jobs", undefined, t2)).body;
    expect(mine.total).toBe(1);
    expect(theirs.total).toBe(0);
  });
});
