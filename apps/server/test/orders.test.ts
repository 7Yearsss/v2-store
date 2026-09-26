import { createHmac } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import {
  jobs,
  listings,
  orderItems,
  orders,
  purchaseOrderItems,
  purchaseOrders,
  shipments,
  sourceItems,
  stores,
} from "../src/db/schema.js";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, setup } from "./helpers.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const SHOP = "demo.myshopify.com";

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

type OrderNode = Record<string, unknown>;

/** Raw Shopify order node matching the adapter's ORDER_FIELDS shape. */
function orderNode(id: string, overrides: Record<string, unknown> = {}): OrderNode {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    displayFinancialStatus: "PAID",
    displayFulfillmentStatus: "UNFULFILLED",
    cancelledAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-01T00:00:00Z",
    currencyCode: "USD",
    subtotalPriceSet: { shopMoney: { amount: "20.00" } },
    totalPriceSet: { shopMoney: { amount: "25.00" } },
    customer: { displayName: "Alice Chen", email: "alice@example.com", phone: "+8613812345678" },
    shippingAddress: {
      name: "Alice Chen",
      phone: "13812345678",
      country: "US",
      province: "CA",
      city: "Los Angeles",
      address1: "100 Main St",
      address2: "Apt 2",
      zip: "90001",
    },
    lineItems: {
      nodes: [
        {
          id: `gid://shopify/LineItem/${id}-1`,
          title: "Tee",
          sku: "SKU-A",
          quantity: 2,
          originalUnitPriceSet: { shopMoney: { amount: "10.00" } },
          variant: { id: "gid://shopify/ProductVariant/v0" },
        },
      ],
    },
    ...overrides,
  };
}

async function makeStore(t: string) {
  const res = await ctx!.api(
    "POST",
    "/api/stores/shopify",
    { authType: "access_token", shopDomain: "demo", accessToken: "shpat_abcdefghij" },
    t,
  );
  expect(res.status).toBeOneOf([200, 201]);
  // webhook 只路由 oauth 安装的店；测试店铺直接改 authType 模拟 oauth 店
  await ctx!.deps.db
    .update(stores)
    .set({ authType: "oauth" })
    .where(eq(stores.id, res.body.id as string));
  return res.body.id as string;
}

/** Webhook POST with a correctly-signed HMAC (config secret = "secret"). */
async function fireWebhook(
  topic: "orders/create" | "orders/updated" | "orders/cancelled",
  remoteId: string,
  opts: { secret?: string; shop?: string; status?: number } = {},
) {
  const body = JSON.stringify({ admin_graphql_api_id: remoteId });
  const hmac = createHmac("sha256", opts.secret ?? "secret").update(body, "utf8").digest("base64");
  return ctx!.app.request("/api/shopify/webhooks", {
    method: "POST",
    headers: {
      "x-shopify-hmac-sha256": hmac,
      "x-shopify-topic": topic,
      "x-shopify-shop-domain": opts.shop ?? SHOP,
    },
    body,
  });
}

/** Collect → claim → publish so the listing carries remoteVariantMap. */
async function publishOne(t: string, offerId = "777", seller?: string) {
  const storeId = await makeStore(t);
  const item = await ctx!.api("POST", "/api/collect", harvest(offerId), t);
  const sourceItemId = item.body.item.id as string;
  if (seller !== undefined) {
    await ctx!.deps.db
      .update(sourceItems)
      .set({ sellerName: seller })
      .where(eq(sourceItems.id, sourceItemId));
  }
  await ctx!.api("POST", "/api/source-items/claim", { ids: [sourceItemId], storeIds: [storeId] }, t);
  const listing = (await ctx!.api("GET", `/api/listings?storeId=${storeId}`, undefined, t)).body
    .items[0];
  await ctx!.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
  await runJobs("listing.publish");
  const l = (
    await ctx!.deps.db.select().from(listings).where(eq(listings.id, listing.id))
  )[0]!;
  return { storeId, sourceItemId, listingId: listing.id as string, listing: l };
}

describe("order webhooks", () => {
  it("rejects a forged HMAC signature", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    await makeStore(t);
    const res = await ctx.app.request("/api/shopify/webhooks", {
      method: "POST",
      headers: {
        "x-shopify-hmac-sha256": "forged==",
        "x-shopify-topic": "orders/create",
        "x-shopify-shop-domain": SHOP,
      },
      body: JSON.stringify({ admin_graphql_api_id: "gid://shopify/Order/1" }),
    });
    expect(res.status).toBe(401);
    // 不该有任何 order.sync 入队
    const queued = await ctx.deps.db.select().from(jobs).where(eq(jobs.type, "order.sync"));
    expect(queued.length).toBe(0);
  });

  it("enqueues order.sync per order topic and dedupes identical payloads", async () => {
    const fakeOrders = { "gid://shopify/Order/1001": orderNode("1001") };
    ctx = await setup(fakeShopify({ orders: fakeOrders }));
    const t = await ctx.register();
    await makeStore(t);
    for (const topic of ["orders/create", "orders/updated", "orders/cancelled"] as const) {
      const res = await fireWebhook(topic, "gid://shopify/Order/1001");
      expect(res.status).toBe(200);
    }
    const queued = await ctx.deps.db.select().from(jobs).where(eq(jobs.type, "order.sync"));
    expect(queued.length).toBe(1); // 同 storeId+remoteId 去重
    expect(queued[0]!.payload).toMatchObject({ remoteId: "gid://shopify/Order/1001" });
  });

  it("ignores webhooks for shops we don't know", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    await makeStore(t);
    const res = await fireWebhook("orders/create", "gid://shopify/Order/1", {
      shop: "other.myshopify.com",
    });
    expect(res.status).toBe(200);
    const queued = await ctx.deps.db.select().from(jobs).where(eq(jobs.type, "order.sync"));
    expect(queued.length).toBe(0);
  });
});

describe("order.sync", () => {
  it("upserts orders+items idempotently and merges out-of-order payloads by freshness", async () => {
    const gid = "gid://shopify/Order/1001";
    const fakeOrders: Record<string, OrderNode | null> = { [gid]: orderNode("1001") };
    ctx = await setup(fakeShopify({ orders: fakeOrders }));
    const t = await ctx.register();
    const storeId = await makeStore(t);

    await fireWebhook("orders/create", gid);
    await runJobs("order.sync");
    await runJobs("order.map");

    let list = await ctx.api("GET", "/api/orders", undefined, t);
    expect(list.body.total).toBe(1);
    const order = list.body.items[0];
    expect(order.name).toBe("#1001");
    expect(order.status).toBe("new");
    expect(order.items.length).toBe(1);
    expect(order.items[0].qty).toBe(2);
    expect(order.items[0].remoteVariantId).toBe("gid://shopify/ProductVariant/v0");

    // 重复 webhook + 重跑任务 → 不产生第二单/第二行
    await fireWebhook("orders/updated", gid);
    await runJobs("order.sync");
    list = await ctx.api("GET", "/api/orders", undefined, t);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].items.length).toBe(1);
    const orderId = order.id;
    const itemId = order.items[0].id;

    // 更新的版本写入（updatedAt 更晚，名字变了）
    fakeOrders[gid] = orderNode("1001", {
      name: "#1001-v2",
      updatedAt: "2026-09-02T00:00:00Z",
      displayFinancialStatus: "PARTIALLY_REFUNDED",
    });
    await fireWebhook("orders/updated", gid);
    await runJobs("order.sync");
    list = await ctx.api("GET", "/api/orders", undefined, t);
    expect(list.body.items[0].name).toBe("#1001-v2");
    expect(list.body.items[0].id).toBe(orderId);
    expect(list.body.items[0].items[0].id).toBe(itemId);
    expect(list.body.items[0].financialStatus).toBe("PARTIALLY_REFUNDED");

    // 乱序到达的旧版本（updatedAt 更早）不覆盖
    fakeOrders[gid] = orderNode("1001", {
      name: "#1001-stale",
      updatedAt: "2026-08-30T00:00:00Z",
    });
    await fireWebhook("orders/updated", gid);
    await runJobs("order.sync");
    list = await ctx.api("GET", "/api/orders", undefined, t);
    expect(list.body.items[0].name).toBe("#1001-v2");
    expect(list.body.items[0].financialStatus).toBe("PARTIALLY_REFUNDED");

    // orders/cancelled → cancelledAt 置位 → status=cancelled（取消有终态权威）
    fakeOrders[gid] = orderNode("1001", {
      updatedAt: "2026-09-03T00:00:00Z",
      cancelledAt: "2026-09-03T00:00:01Z",
      displayFinancialStatus: "REFUNDED",
    });
    await fireWebhook("orders/cancelled", gid);
    await runJobs("order.sync");
    list = await ctx.api("GET", "/api/orders?status=cancelled", undefined, t);
    expect(list.body.total).toBe(1);
    expect(list.body.items[0].status).toBe("cancelled");

    // 手动同步走 cursor 增量（remoteId 空参数）
    const st = await ctx.api("POST", "/api/orders/sync", { storeId }, t);
    expect(st.status).toBe(200);
    await runJobs("order.sync");
    const row = await ctx.deps.db.select().from(stores).where(eq(stores.id, storeId));
    expect(row[0]!.ordersCursor).toBe("2026-09-03T00:00:00.000Z");
  });
});

describe("order.map 三档 + 人工绑定", () => {
  it("matches by remoteVariantMap → by sku → unmatched, and manual bind wins", async () => {
    const gid = "gid://shopify/Order/2001";
    const node = orderNode("2001", {
      lineItems: {
        nodes: [
          {
            // 一档：variantId 命中 remoteVariantMap → matched（s1）
            id: "gid://shopify/LineItem/a",
            title: "A",
            sku: "DIFFERENT-SKU",
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: "5" } },
            variant: { id: "gid://shopify/ProductVariant/v0" },
          },
          {
            // 二档：variantId 未中但 sku 命中刊登变体 → matched（s2）
            id: "gid://shopify/LineItem/b",
            title: "B",
            sku: "777-2",
            quantity: 3,
            originalUnitPriceSet: { shopMoney: { amount: "5" } },
            variant: null,
          },
          {
            // 三档：都未命中 → unmatched
            id: "gid://shopify/LineItem/c",
            title: "C",
            sku: "UNKNOWN",
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: "5" } },
            variant: null,
          },
        ],
      },
    });
    ctx = await setup(fakeShopify({ orders: { [gid]: node } }));
    const t2 = await ctx.register("b@test.dev");
    const { sourceItemId: src2 } = await publishOne(t2);

    await fireWebhook("orders/create", gid);
    await runJobs("order.sync");
    await runJobs("order.map");

    const order = (await ctx.api("GET", "/api/orders", undefined, t2)).body.items[0];
    const byLine = new Map<string, any>(
      order.items.map((i: any) => [i.remoteLineItemId as string, i]),
    );
    expect(byLine.get("gid://shopify/LineItem/a")!.mapping).toBe("matched");
    expect(byLine.get("gid://shopify/LineItem/a")!.sourceSkuId).toBe("s1");
    expect(byLine.get("gid://shopify/LineItem/a")!.offerId).toBe("777");
    expect(byLine.get("gid://shopify/LineItem/b")!.mapping).toBe("matched");
    expect(byLine.get("gid://shopify/LineItem/b")!.sourceSkuId).toBe("s2");
    expect(byLine.get("gid://shopify/LineItem/c")!.mapping).toBe("unmatched");

    // 人工绑定 unmatched 行
    const bind = await ctx.api(
      "POST",
      `/api/orders/${order.id}/items/${byLine.get("gid://shopify/LineItem/c")!.id}/bind`,
      { sourceItemId: src2, sourceSkuId: "s1" },
      t2,
    );
    expect(bind.status).toBe(200);
    const after = bind.body.items.find((i: any) => i.remoteLineItemId === "gid://shopify/LineItem/c");
    expect(after.mapping).toBe("matched");
    expect(after.sourceSkuId).toBe("s1");
    expect(after.offerId).toBe("777");
  });
});

describe("采购单 + 履约", () => {
  it("splits POs by seller and merges items; confirms via procure-confirm", async () => {
    // 两货源两店铺，各发一单，行项跨供应商 → 应拆成 2 张 PO。
    // fake 的 variant gid 不带 product 维度，这里走 sku 档匹配避免共享 v0。
    const o1 = orderNode("4001", {
      lineItems: {
        nodes: [
          {
            id: "gid://shopify/LineItem/w",
            title: "W",
            sku: "777-1",
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: "5" } },
            variant: null,
          },
        ],
      },
    });
    const o2 = orderNode("4002", {
      lineItems: {
        nodes: [
          {
            id: "gid://shopify/LineItem/x",
            title: "X",
            sku: "888-1",
            quantity: 1,
            originalUnitPriceSet: { shopMoney: { amount: "7" } },
            variant: null,
          },
        ],
      },
    });
    const fakeOrders: Record<string, OrderNode | null> = {
      "gid://shopify/Order/4001": o1,
      "gid://shopify/Order/4002": o2,
    };
    ctx = await setup(fakeShopify({ orders: fakeOrders }));
    const t = await ctx.register();
    const a = await publishOne(t, "777", "供应商甲");
    const b = await publishOne(t, "888", "供应商乙");
    void a;
    void b;

    await fireWebhook("orders/create", "gid://shopify/Order/4001");
    await fireWebhook("orders/create", "gid://shopify/Order/4002");
    await runJobs("order.sync");
    await runJobs("order.map");

    const list = await ctx.api("GET", "/api/orders", undefined, t);
    const o4001 = list.body.items.find((o: any) => o.name === "#4001");
    const o4002 = list.body.items.find((o: any) => o.name === "#4002");
    expect(o4001.items[0].mapping).toBe("matched");
    expect(o4001.items[0].sourceSkuId).toBe("s1");
    expect(o4002.items[0].mapping).toBe("matched");
    expect(o4002.items[0].sourceSkuId).toBe("s1");

    // 勾选两订单行项 → 按供应商拆成 2 张 PO
    const created = await ctx.api(
      "POST",
      "/api/purchase-orders",
      { orderItemIds: [o4001.items[0].id, o4002.items[0].id] },
      t,
    );
    expect(created.status).toBe(201);
    expect(created.body.total).toBe(2);
    const sellers = new Set(created.body.items.map((p: any) => p.sourceSeller));
    expect([...sellers].sort()).toEqual(["供应商乙", "供应商甲"].sort());
    const poA = created.body.items.find((p: any) => p.sourceSeller === "供应商甲");
    const poB = created.body.items.find((p: any) => p.sourceSeller === "供应商乙");

    // 行项进单 → procureStatus queued，订单状态 → procuring（未审核时闸挡住）→ 先审核
    await ctx.api("POST", `/api/orders/${o4001.id}/review`, {}, t);
    const proc = await ctx.api("GET", `/api/orders/${o4001.id}`, undefined, t);
    expect(proc.body.order.status).toBe("procuring");

    // 重复入单被拒
    const dup = await ctx.api(
      "POST",
      "/api/purchase-orders",
      { orderItemIds: [o4001.items[0].id] },
      t,
    );
    expect(dup.status).toBe(409);

    // 合并：把乙行从乙单移到甲单
    const merged = await ctx.api(
      "PATCH",
      `/api/purchase-orders/${poA.id}`,
      { addItemIds: [o4002.items[0].id] },
      t,
    );
    expect(merged.status).toBe(409); // 还在乙单里 → 冲突
    await ctx.api(
      "PATCH",
      `/api/purchase-orders/${poB.id}`,
      { removeItemIds: [o4002.items[0].id] },
      t,
    );
    const merged2 = await ctx.api(
      "PATCH",
      `/api/purchase-orders/${poA.id}`,
      { addItemIds: [o4002.items[0].id] },
      t,
    );
    expect(merged2.status).toBe(200);
    expect(merged2.body.items.length).toBe(2);

    // 状态推进：placed → 行项 placed
    const advanced = await ctx.api(
      "PATCH",
      `/api/purchase-orders/${poA.id}`,
      { status: "placed", sourceOrderId: "1688-SO-1" },
      t,
    );
    expect(advanced.body.status).toBe("placed");
    const oi = (
      await ctx.deps.db
        .select()
        .from(orderItems)
        .where(eq(orderItems.id, o4001.items[0].id))
    )[0]!;
    expect(oi.procureStatus).toBe("placed");

    // 轨迹录入
    const tracked = await ctx.api(
      "PATCH",
      `/api/purchase-orders/${poA.id}`,
      { domesticTracking: [{ carrier: "中通", no: "SF123" }] },
      t,
    );
    expect(tracked.body.domesticTracking).toEqual([{ carrier: "中通", no: "SF123" }]);

    // procure-confirm：插件「标记已下单」回填。poA 混了乙货源的行项 → 不复用，
    // 该 orderItem 的链接被搬到新建 PO，poA 保持原状
    const confirm = await ctx.api(
      "POST",
      `/api/orders/${o4001.id}/procure-confirm`,
      { offerId: "777", sourceOrderId: "1688-SO-9" },
      t,
    );
    expect(confirm.status).toBe(200);
    expect(confirm.body.purchaseOrderId).not.toBe(poA.id);
    const poRow = (
      await ctx.deps.db
        .select()
        .from(purchaseOrders)
        .where(eq(purchaseOrders.id, confirm.body.purchaseOrderId))
    )[0]!;
    expect(poRow.sourceOrderId).toBe("1688-SO-9");
    expect(poRow.status).toBe("placed");
    // 行项从混合 PO 搬进新 PO，一条订单行只属于一张未完结采购单
    const linksAfter = await ctx.deps.db
      .select()
      .from(purchaseOrderItems)
      .where(eq(purchaseOrderItems.orderItemId, o4001.items[0].id));
    expect(linksAfter.length).toBe(1);
    expect(linksAfter[0]!.purchaseOrderId).toBe(confirm.body.purchaseOrderId);
    // poA 未被覆盖：仍是旧的 sourceOrderId / placed
    const poAAfter = (
      await ctx.deps.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, poA.id))
    )[0]!;
    expect(poAAfter.sourceOrderId).toBe("1688-SO-1");
    expect(poAAfter.status).toBe("placed");
    // 干净场景复用：再次 confirm 同一 offer → 命中刚建的纯覆盖 PO
    const confirm2 = await ctx.api(
      "POST",
      `/api/orders/${o4001.id}/procure-confirm`,
      { offerId: "777", sourceOrderId: "1688-SO-10" },
      t,
    );
    expect(confirm2.body.purchaseOrderId).toBe(confirm.body.purchaseOrderId);
  });

  it("POST /orders/:id/procure returns offers with address (buyer) for the extension card", async () => {
    const gid = "gid://shopify/Order/5001";
    ctx = await setup(fakeShopify({ orders: { [gid]: orderNode("5001") } }));
    const t = await ctx.register();
    await publishOne(t); // offer 777, sku 777-1→v0
    await fireWebhook("orders/create", gid);
    await runJobs("order.sync");
    await runJobs("order.map");
    const order = (await ctx.api("GET", "/api/orders", undefined, t)).body.items[0];
    // 行项 sku 是 "SKU-A"（未匹配），variantId v0 → remoteVariantMap 命中 matched
    expect(order.items[0].mapping).toBe("matched");

    const res = await ctx.api("POST", `/api/orders/${order.id}/procure`, {}, t);
    expect(res.status).toBe(200);
    expect(res.body.offers).toHaveLength(1);
    expect(res.body.offers[0]).toMatchObject({
      offerId: "777",
      qty: 2,
      specText: expect.any(String),
    });
    expect(res.body.address.recipient).toBe("Alice Chen"); // 明文只在采购卡/address 端点
    expect(res.body.address.phone).toBe("13812345678");
  });
});

describe("fulfill.push", () => {
  async function shippedSetup(opts: { fulfillmentErrors?: Array<{ message: string }> } = {}) {
    const gid = "gid://shopify/Order/6001";
    const capturedFulfillment: Array<Record<string, unknown>> = [];
    ctx = await setup(
      fakeShopify({
        orders: { [gid]: orderNode("6001") },
        capturedFulfillment,
        fulfillmentErrors: opts.fulfillmentErrors,
      }),
    );
    const t = await ctx.register();
    await publishOne(t);
    await fireWebhook("orders/create", gid);
    await runJobs("order.sync");
    await runJobs("order.map");
    const order = (await ctx.api("GET", "/api/orders", undefined, t)).body.items[0];
    await ctx.api("POST", `/api/orders/${order.id}/review`, {}, t);
    return { t, order, capturedFulfillment };
  }

  it("pushes fulfillment via fulfillmentCreate and writes back remote_fulfillment_id", async () => {
    const { t, order, capturedFulfillment } = await shippedSetup();
    const res = await ctx!.api(
      "POST",
      `/api/orders/${order.id}/fulfill`,
      { trackingNo: "1Z999AA10123456784", carrier: "4PX", trackingUrl: "https://t.17track.net/x" },
      t,
    );
    expect(res.status).toBe(200);
    await runJobs("fulfill.push");

    expect(capturedFulfillment).toHaveLength(1);
    const f = capturedFulfillment[0]!;
    expect(f.notifyCustomer).toBe(true);
    expect(f.trackingInfo).toMatchObject({ number: "1Z999AA10123456784", company: "4PX" });
    const groups = f.lineItemsByFulfillmentOrder as Array<{
      fulfillmentOrderId: string;
      fulfillmentOrderLineItems: Array<{ id: string; quantity: number }>;
    }>;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.fulfillmentOrderLineItems).toEqual([
      { id: "gid://shopify/FulfillmentOrderLineItem/foli0", quantity: 2 },
    ]);

    const s = (
      await ctx!.deps.db.select().from(shipments).where(eq(shipments.orderId, order.id))
    )[0]!;
    expect(s.status).toBe("pushed");
    expect(s.remoteFulfillmentId).toBe("gid://shopify/Fulfillment/f1");
    const dto = (await ctx!.api("GET", `/api/orders/${order.id}`, undefined, t)).body.order;
    expect(dto.status).toBe("shipped");
  });

  it("marks shipment failed and order exception on userErrors", async () => {
    const { t, order } = await shippedSetup({
      fulfillmentErrors: [{ message: "fulfillment service unavailable" }],
    });
    await ctx!.api(
      "POST",
      `/api/orders/${order.id}/fulfill`,
      { trackingNo: "BAD-1" },
      t,
    );
    await runJobs("fulfill.push");
    const s = (
      await ctx!.deps.db.select().from(shipments).where(eq(shipments.orderId, order.id))
    )[0]!;
    expect(s.status).toBe("failed");
    expect(s.lastError).toContain("unavailable");
    const dto = (await ctx!.api("GET", `/api/orders/${order.id}`, undefined, t)).body.order;
    expect(dto.status).toBe("exception");
  });
});

describe("地址与隔离", () => {
  it("stores address encrypted, lists masked, exposes plaintext only via /address", async () => {
    const gid = "gid://shopify/Order/7001";
    ctx = await setup(fakeShopify({ orders: { [gid]: orderNode("7001") } }));
    const t = await ctx.register();
    await makeStore(t);
    await fireWebhook("orders/create", gid);
    await runJobs("order.sync");

    // 库里是密文
    const row = (await ctx.deps.db.select().from(orders))[0]!;
    expect(row.shippingAddressEnc).toMatch(/^v1\./);
    expect(row.shippingAddressEnc).not.toContain("13812345678");
    expect(row.shippingAddressEnc).not.toContain("Main St");

    // 列表/详情只有脱敏
    const list = await ctx.api("GET", "/api/orders", undefined, t);
    expect(list.body.items[0].shippingAddressMasked).toBe("US CA Los Angeles · A*** · 138****5678");
    const raw = JSON.stringify(list.body);
    expect(raw).not.toContain("100 Main St");
    expect(raw).not.toContain("13812345678");

    // 明文走独立端点
    const addr = await ctx.api("GET", `/api/orders/${row.id}/address`, undefined, t);
    expect(addr.status).toBe(200);
    expect(addr.body.address.address1).toBe("100 Main St");
    expect(addr.body.address.phone).toBe("13812345678");
  });

  it("isolates orders/POs/forwarders across workspaces", async () => {
    const gid = "gid://shopify/Order/8001";
    ctx = await setup(fakeShopify({ orders: { [gid]: orderNode("8001") } }));
    const t = await ctx.register("a@test.dev");
    const t2 = await ctx.register("b@test.dev");
    await makeStore(t);
    await fireWebhook("orders/create", gid);
    await runJobs("order.sync");
    const order = (await ctx.api("GET", "/api/orders", undefined, t)).body.items[0];

    // 他店不可见
    expect((await ctx.api("GET", "/api/orders", undefined, t2)).body.total).toBe(0);
    expect((await ctx.api("GET", `/api/orders/${order.id}`, undefined, t2)).status).toBe(404);
    expect((await ctx.api("GET", `/api/orders/${order.id}/address`, undefined, t2)).status).toBe(404);
    expect(
      (await ctx.api("POST", `/api/orders/${order.id}/review`, {}, t2)).status,
    ).toBe(404);

    // 货代地址簿按 workspace 隔离
    const fw = await ctx.api(
      "POST",
      "/api/freight-forwarders",
      { name: "X 集运", address: { address1: "深圳仓 1 号" } },
      t,
    );
    expect(fw.status).toBe(201);
    expect((await ctx.api("GET", "/api/freight-forwarders", undefined, t2)).body.total).toBe(0);
    expect(
      (await ctx.api("DELETE", `/api/freight-forwarders/${fw.body.id}`, undefined, t2)).status,
    ).toBe(404);

    // 采购单同理（单不存在 → 404，而不是越权读到）
    expect((await ctx.api("GET", "/api/purchase-orders", undefined, t2)).body.total).toBe(0);
  });
});
