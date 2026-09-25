import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { jobs } from "../src/db/schema.js";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const PRODUCT = "gid://shopify/Product/42";

/** Run queued jobs of one type now (media fallback jobs are delayed). */
async function runJobs(type: string) {
  await ctx!.deps.db.update(jobs).set({ runAt: new Date(0) }).where(eq(jobs.type, type));
  await ctx!.deps.db
    .update(jobs)
    .set({ status: "succeeded" })
    .where(eq(jobs.type, "media.fetchMissing"));
  while (await runOnce(ctx!.deps, jobHandlers)) {
    /* drain */
  }
}

async function publishOne(t: string, storePatch: Record<string, unknown> = {}) {
  const store = await ctx!.api(
    "POST",
    "/api/stores/shopify",
    { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
    t,
  );
  if (Object.keys(storePatch).length) {
    await ctx!.api("PATCH", `/api/stores/${store.body.id}`, storePatch, t);
  }
  const item = await ctx!.api("POST", "/api/collect", harvest("777"), t);
  await ctx!.api("POST", "/api/source-items/claim", { ids: [item.body.item.id], storeIds: [store.body.id] }, t);
  const listing = (await ctx!.api("GET", "/api/listings", undefined, t)).body.items[0];
  await ctx!.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
  await runJobs("listing.publish");
  return { storeId: store.body.id, listingId: listing.id as string };
}

describe("publish lifecycle", () => {
  it("creates ACTIVE on the Online Store once; re-syncs never override status", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const { listingId } = await publishOne(t);

    const first = ctx.calls.find((c) => c.body?.query?.includes("productSet"))!;
    expect(first.body.variables.input.status).toBe("ACTIVE");
    const pub = ctx.calls.find((c) => c.body?.query?.includes("publishablePublish"))!;
    expect(pub.body.variables).toEqual({
      id: PRODUCT,
      input: [{ publicationId: "gid://shopify/Publication/online" }],
    });
    const done = (await ctx.api("GET", `/api/listings/${listingId}`, undefined, t)).body;
    expect(done.remoteStatus).toBe("ACTIVE");
    expect(done.lastError).toContain("未能转存"); // image fallback only

    ctx.calls.length = 0;
    await ctx.api("POST", "/api/listings/publish", { ids: [listingId] }, t);
    await runJobs("listing.publish");
    const again = ctx.calls.find((c) => c.body?.query?.includes("productSet"))!;
    expect(again.body.variables.input.status).toBeUndefined();
    expect(ctx.calls.some((c) => c.body?.query?.includes("publishablePublish"))).toBe(false);
  });

  it("warns instead of failing when publication scopes are missing", async () => {
    ctx = await setup(fakeShopify({ noPublicationScope: true }));
    const t = await ctx.register();
    const { listingId } = await publishOne(t);
    const done = (await ctx.api("GET", `/api/listings/${listingId}`, undefined, t)).body;
    expect(done.status).toBe("published");
    expect(done.lastError).toContain("write_publications");
  });

  it("uses the store's brand as vendor, never the supplier, and applies the price floor", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    await publishOne(t, {
      vendor: "Acme",
      pricing: { exchangeRate: 0.14, markup: 3, priceEnding: 0.99, extraCostCny: 0, minPrice: 9.9 },
    });
    const input = ctx.calls.find((c) => c.body?.query?.includes("productSet"))!.body.variables.input;
    expect(input.vendor).toBe("Acme");
    expect(input.variants[0].price).toBe("9.99");
  });
});

describe("status sync", () => {
  it("pulls channel-side status back, including deletions", async () => {
    const statuses: Record<string, string | null> = {};
    ctx = await setup(fakeShopify({ remoteStatuses: statuses }));
    const t = await ctx.register();
    const { storeId, listingId } = await publishOne(t);

    statuses[PRODUCT] = "DRAFT";
    await ctx.api("POST", `/api/stores/${storeId}/sync`, {}, t);
    // a second request while one is queued doesn't pile up jobs
    await ctx.api("POST", `/api/stores/${storeId}/sync`, {}, t);
    const queued = await ctx.deps.db.select().from(jobs).where(eq(jobs.type, "store.syncListings"));
    expect(queued.filter((j) => j.status === "queued")).toHaveLength(1);
    await runJobs("store.syncListings");
    let l = (await ctx.api("GET", `/api/listings/${listingId}`, undefined, t)).body;
    expect(l.remoteStatus).toBe("DRAFT");
    expect(l.syncedAt).not.toBeNull();

    statuses[PRODUCT] = null;
    await ctx.api("POST", `/api/stores/${storeId}/sync`, {}, t);
    await runJobs("store.syncListings");
    l = (await ctx.api("GET", `/api/listings/${listingId}`, undefined, t)).body;
    expect(l.remoteStatus).toBe("DELETED");

    // republishing a deleted product creates a new one
    ctx.calls.length = 0;
    await ctx.api("POST", "/api/listings/publish", { ids: [listingId] }, t);
    await runJobs("listing.publish");
    const recreate = ctx.calls.find((c) => c.body?.query?.includes("productSet"))!;
    expect(recreate.body.variables.identifier).toBeUndefined();
    expect(recreate.body.variables.input.status).toBe("ACTIVE");
    l = (await ctx.api("GET", `/api/listings/${listingId}`, undefined, t)).body;
    expect(l.remoteStatus).toBe("ACTIVE");
  });
});
