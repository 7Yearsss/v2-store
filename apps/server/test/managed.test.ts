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

async function drain() {
  while (await runOnce(ctx!.deps, jobHandlers)) {
    /* drain */
  }
}

async function connectStore(t: string) {
  const res = await ctx!.api(
    "POST",
    "/api/stores/shopify",
    { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
    t,
  );
  return res.body;
}

async function collectAndClaim(t: string, storeId: string, offerId: string, title = "测试商品") {
  const item = await ctx!.api("POST", "/api/collect", harvest(offerId, title), t);
  await ctx!.api(
    "POST",
    "/api/source-items/claim",
    { ids: [item.body.item.id], storeIds: [storeId] },
    t,
  );
  const list = await ctx!.api("GET", "/api/listings", undefined, t);
  return list.body.items.find((l: { title: string }) => l.title === title);
}

async function publishListing(t: string, listingId: string) {
  await ctx!.api("POST", "/api/listings/publish", { ids: [listingId] }, t);
  await ctx!.deps.db
    .update(jobs)
    .set({ status: "succeeded" })
    .where(eq(jobs.type, "media.fetchMissing"));
  await drain();
}

describe("managed lifecycle", () => {
  it("发布形成 run + attempts；禁售词拦截记为 failed attempt，run 聚合 partial_success", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const store = await connectStore(t);
    const ok = await collectAndClaim(t, store.id, "777");
    const bad = await collectAndClaim(t, store.id, "888", "杯子");
    await ctx.api("PATCH", `/api/stores/${store.id}`, { rules: { bannedWords: ["杯子"] } }, t);

    const pub = await ctx.api(
      "POST",
      "/api/listings/publish",
      { ids: [ok.id, bad.id] },
      t,
    );
    expect(pub.body.queued).toBe(1);
    expect(pub.body.blocked).toHaveLength(1);
    const runId = pub.body.runId;
    expect(typeof runId).toBe("string");

    const run0 = await ctx.api("GET", `/api/publish/runs/${runId}`, undefined, t);
    expect(run0.body.run.status).toBe("queued");
    const blocked = run0.body.attempts.find(
      (a: { listingId: string }) => a.listingId === bad.id,
    );
    expect(blocked.status).toBe("failed");
    expect(blocked.errorCode).toBe("review_rejected");
    expect(blocked.fieldsSnapshot.title).toBe("杯子");

    await drain();

    const run1 = await ctx.api("GET", `/api/publish/runs/${runId}`, undefined, t);
    expect(run1.body.run.status).toBe("partial_success");
    const done = run1.body.attempts.find((a: { listingId: string }) => a.listingId === ok.id);
    expect(done.status).toBe("succeeded");
    expect(done.remoteId).toBe(PRODUCT);
    const listing = await ctx.api("GET", `/api/listings/${ok.id}`, undefined, t);
    expect(listing.body.linkStatus).toBe("linked");
    expect(listing.body.remoteSnapshot?.remoteId).toBe(PRODUCT);

    // 解禁后只重试失败 attempt
    await ctx.api("PATCH", `/api/stores/${store.id}`, { rules: { bannedWords: [] } }, t);
    const retry = await ctx.api("POST", `/api/publish/runs/${runId}/retry`, {}, t);
    expect(retry.body.retried).toBe(1);
    await drain();
    const run2 = await ctx.api("GET", `/api/publish/runs/${runId}`, undefined, t);
    expect(run2.body.run.status).toBe("succeeded");
    const retried = run2.body.attempts.find(
      (a: { listingId: string; retryOf: string | null }) =>
        a.listingId === bad.id && a.retryOf === blocked.id,
    );
    expect(retried.status).toBe("succeeded");
  });

  it("回扫拉远端快照：字段级漂移只标记不覆盖本地", async () => {
    const remoteProducts: Record<string, Record<string, unknown> | null> = {};
    ctx = await setup(fakeShopify({ remoteProducts }));
    const t = await ctx.register();
    const store = await connectStore(t);
    const listing = await collectAndClaim(t, store.id, "777");
    await publishListing(t, listing.id);

    remoteProducts[PRODUCT] = {
      status: "ACTIVE",
      title: "商家在后台改过的标题",
      descriptionHtml: "<p>remote</p>",
      variants: {
        nodes: [
          { sku: "777-1", price: "9.99", inventoryQuantity: 88 },
          { sku: "777-2", price: "9.99", inventoryQuantity: 88 },
        ],
      },
    };
    await ctx.api("POST", `/api/stores/${store.id}/sync`, {}, t);
    await drain();

    const managed = await ctx.api("GET", `/api/listings/${listing.id}/managed`, undefined, t);
    expect(managed.status).toBe(200);
    const l = managed.body.listing;
    expect(l.linkStatus).toBe("linked");
    expect(l.remoteSnapshot.title).toBe("商家在后台改过的标题");
    expect(l.lastPulledAt).not.toBeNull();
    const fields = l.remoteDrift.map((d: { field: string }) => d.field);
    expect(fields).toContain("title");
    expect(fields).toContain("descriptionHtml");
    // 只标记：本地标题不被远端覆盖
    expect(l.title).toBe("测试商品");
    expect(l.status).toBe("published");
    expect(managed.body.attempts.length).toBeGreaterThan(0);
  });

  it("远端不存在 → linkStatus remote_deleted + 审计，不本地硬删", async () => {
    const remoteProducts: Record<string, Record<string, unknown> | null> = {};
    ctx = await setup(fakeShopify({ remoteProducts }));
    const t = await ctx.register();
    const store = await connectStore(t);
    const listing = await collectAndClaim(t, store.id, "777");
    await publishListing(t, listing.id);

    remoteProducts[PRODUCT] = null;
    await ctx.api("POST", `/api/stores/${store.id}/sync`, {}, t);
    await drain();

    const l = (await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t)).body;
    expect(l.linkStatus).toBe("remote_deleted");
    expect(l.remoteStatus).toBe("DELETED");
    expect(l.status).toBe("published"); // 本地记录保留
    const audits = await ctx.api("GET", `/api/listings/${listing.id}/audits`, undefined, t);
    expect(
      audits.body.audits.map((a: { action: string }) => a.action),
    ).toContain("listing.remote_marked_deleted");
  });

  it("syncPolicy.stock=auto 时回扫自动推库存并留痕，stock 漂移消除", async () => {
    const remoteProducts: Record<string, Record<string, unknown> | null> = {};
    const capturedStock: Array<Array<Record<string, unknown>>> = [];
    ctx = await setup(
      fakeShopify({ remoteProducts, capturedStock, stockSkus: ["777-1", "777-2"] }),
    );
    const t = await ctx.register();
    const store = await connectStore(t);
    // 库存自动推要求：店铺开「同步货源库存」且刊登 stock 策略为 auto
    await ctx.api("PATCH", `/api/stores/${store.id}`, { rules: { trackStock: true } }, t);
    const listing = await collectAndClaim(t, store.id, "777");
    await publishListing(t, listing.id);
    await ctx.api("PATCH", `/api/listings/${listing.id}`, { syncPolicy: { stock: "auto" } }, t);

    remoteProducts[PRODUCT] = {
      status: "ACTIVE",
      title: "测试商品",
      descriptionHtml: (await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t)).body
        .descriptionHtml,
      variants: {
        nodes: [
          { sku: "777-1", price: listing.variants[0].price, inventoryQuantity: 3 },
          { sku: "777-2", price: listing.variants[1].price, inventoryQuantity: 3 },
        ],
      },
    };
    await ctx.api("POST", `/api/stores/${store.id}/sync`, {}, t);
    await drain();

    const l = (await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t)).body;
    expect(l.remoteDrift.some((d: { field: string }) => d.field === "stock")).toBe(false);
    expect(l.lastAutoAction?.action).toBe("stock_push");
    expect(l.lastAutoAction?.detail?.ok).toBe(true);
    expect(capturedStock.length).toBeGreaterThan(0);
    const audits = await ctx.api("GET", `/api/listings/${listing.id}/audits`, undefined, t);
    expect(
      audits.body.audits.map((a: { action: string }) => a.action),
    ).toContain("listing.auto_stock_push");
  });

  it("跨 workspace 隔离：run/attempt/托管详情/审计不可互访", async () => {
    ctx = await setup(fakeShopify());
    const t1 = await ctx.register();
    const t2 = await ctx.register("b@test.dev");
    const store = await connectStore(t1);
    const listing = await collectAndClaim(t1, store.id, "777");
    const pub = await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t1);
    await drain();

    for (const path of [
      `/api/publish/runs/${pub.body.runId}`,
      `/api/listings/${listing.id}/managed`,
      `/api/listings/${listing.id}/audits`,
    ]) {
      const res = await ctx.api("GET", path, undefined, t2);
      expect(res.status).toBe(404);
    }
    const retry = await ctx.api("POST", `/api/publish/runs/${pub.body.runId}/retry`, {}, t2);
    expect(retry.status).toBe(404);
    // 自己的 workspace 看不到别的 run
    const runs = await ctx.api("GET", "/api/publish/runs", undefined, t2);
    expect(runs.body.items).toHaveLength(0);
  });
});
