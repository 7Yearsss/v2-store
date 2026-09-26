import { afterEach, describe, expect, it } from "vitest";
import { fakeShopify } from "./fakeShopify.js";
import { harvest, offerHtml, setup } from "./helpers.js";
import { jobHandlers } from "../src/jobs/handlers.js";
import { runOnce } from "../src/jobs/queue.js";

let ctx: Awaited<ReturnType<typeof setup>> | undefined;
afterEach(async () => {
  await ctx?.close();
  ctx = undefined;
});

const drain = async () => {
  while (await runOnce(ctx!.deps, jobHandlers)) {
    /* drain */
  }
};

let storeSeq = 0;
async function addStore(t: string, rules?: Record<string, unknown>) {
  const store = (
    await ctx!.api(
      "POST",
      "/api/stores/shopify",
      {
        authType: "access_token",
        shopDomain: `demo${++storeSeq}.myshopify.com`,
        accessToken: "shpat_abcdefghij",
      },
      t,
    )
  ).body;
  if (rules) {
    await ctx!.api("PATCH", `/api/stores/${store.id}`, { rules }, t);
  }
  return store;
}

async function claimOne(t: string, storeId: string, offerId = "77") {
  const res = await ctx!.api("POST", "/api/collect", harvest(offerId, "货源杯"), t);
  const itemId = res.body.item.id as string;
  await ctx!.api("POST", "/api/source-items/claim", { ids: [itemId], storeIds: [storeId] }, t);
  const listing = (await ctx!.api("GET", "/api/listings", undefined, t)).body.items[0];
  return { itemId, listing };
}

/** 改价 + 改库存 + 改标题 + 改图 + 改属性的回采报文。 */
function mutatedHarvest(offerId = "77") {
  const h = harvest(offerId, "新标题");
  h.pageContent = offerHtml(offerId, "新标题")
    .replace('"price":"10.5"', '"price":"9"')
    .replace('"canBookCount":100', '"canBookCount":3')
    .replace("//cbu01.alicdn.com/a.jpg", "//cbu01.alicdn.com/b.jpg")
    .replace('"value":"棉"', '"value":"麻"');
  return h;
}

describe("fl-monitor 货源监控", () => {
  it("六种 change_type 落库 + 指纹去重 + supersede", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const store = await addStore(t); // 监控未开 → 全部留 pending
    const { itemId } = await claimOne(t, store.id);

    const res = await ctx.api("POST", "/api/collect", mutatedHarvest(), t);
    expect(res.status).toBe(200);
    // 仅 sku s1 价/库变化：price×1 + stock×1 + title + images + attributes = 5 条
    expect(res.body.changes).toBe(5);
    expect(res.body.pending).toBe(5);

    const pending = await ctx.api("GET", "/api/source-changes?pending=true", undefined, t);
    const types = new Set(pending.body.items.map((c: { changeType: string }) => c.changeType));
    expect(types).toEqual(new Set(["price", "stock", "title", "images", "attributes"]));

    // 插件下架上报 → 第六种
    const rep = await ctx.api(
      "POST",
      "/api/collect/report",
      { offerId: "77", availability: "delisted" },
      t,
    );
    expect(rep.body.found).toBe(true);
    expect(rep.body.item.availability).toBe("delisted");
    const pending2 = await ctx.api("GET", "/api/source-changes?pending=true", undefined, t);
    const types2 = new Set(pending2.body.items.map((c: { changeType: string }) => c.changeType));
    expect(types2).toEqual(
      new Set(["price", "stock", "title", "images", "attributes", "delisted"]),
    );

    // 相同报文再采一次：指纹去重，无新变更；回架顺带把 delisted pending 落账 relisted
    const again = await ctx.api("POST", "/api/collect", mutatedHarvest(), t);
    expect(again.body.changes).toBe(0);
    const pending3 = await ctx.api("GET", "/api/source-changes?pending=true", undefined, t);
    expect(pending3.body.items.length).toBe(pending2.body.items.length - 1);

    // 价格再变 → 新指纹落库，同 (type,sku) 旧 pending 标 superseded
    const h = mutatedHarvest();
    h.pageContent = h.pageContent.replace('"price":"9"', '"price":"8.5"');
    const r3 = await ctx.api("POST", "/api/collect", h, t);
    expect(r3.body.changes).toBe(1); // 仅 s1 的 price
    const all = await ctx.api("GET", "/api/source-changes?pending=false", undefined, t);
    const priceRows = all.body.items.filter((c: { changeType: string }) => c.changeType === "price");
    expect(priceRows.filter((c: { appliedAt: string | null }) => c.appliedAt)).toHaveLength(1);
    expect(priceRows.filter((c: { appliedAt: string | null }) => !c.appliedAt)).toHaveLength(1);

    // 恢复上架：pending 的 delisted 落账 relisted
    const ok = await ctx.api(
      "POST",
      "/api/collect/report",
      { offerId: "77", availability: "ok" },
      t,
    );
    expect(ok.body.item.availability).toBe("ok");
    const pending4 = await ctx.api("GET", "/api/source-changes?pending=true", undefined, t);
    expect(
      pending4.body.items.some((c: { changeType: string }) => c.changeType === "delisted"),
    ).toBe(false);
  });

  it("判定矩阵：monitor 关→只落 pending；开+priceAuto+published+price=auto→推价", async () => {
    const capturedPrices: Array<Array<Record<string, unknown>>> = [];
    ctx = await setup(fakeShopify({ capturedPrices, stockSkus: ["77-1", "77-2"] }));
    const t = await ctx.register();

    // A 店：trackStock+监控+priceAuto 全开；B 店：只开监控（刊登 syncPolicy 全 notify）
    const storeA = await addStore(t, {
      trackStock: true,
      monitor: { enabled: true, priceAuto: true },
    });
    const storeB = await addStore(t, { monitor: { enabled: true } });
    const { itemId } = await claimOne(t, storeA.id);
    // 同一货源再认领到 B 店（刊登 syncPolicy 默认 notify）
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [itemId], storeIds: [storeB.id] },
      t,
    );
    const items = (await ctx.api("GET", "/api/listings", undefined, t)).body.items;
    const listingA = items.find((l: { storeId: string }) => l.storeId === storeA.id);
    const listingB = items.find((l: { storeId: string }) => l.storeId === storeB.id);
    // A 店刊登开价格 auto
    await ctx.api("PATCH", `/api/listings/${listingA.id}`, { syncPolicy: { price: "auto" } }, t);
    const priceBefore = listingA.variants[0].price;
    // A 店刊登发布
    await ctx.api("POST", "/api/listings/publish", { ids: [listingA.id] }, t);
    await drain();
    expect(capturedPrices).toHaveLength(0);

    const res = await ctx.api("POST", "/api/collect", mutatedHarvest(), t);
    expect(res.body.changes).toBeGreaterThan(0);
    // A：价已按定价规则重算并推送（(9+0)*0.14*3=3.78→3.99）；B：保持原样
    await drain();
    const la = (await ctx.api("GET", `/api/listings/${listingA.id}`, undefined, t)).body;
    const lb = (await ctx.api("GET", `/api/listings/${listingB.id}`, undefined, t)).body;
    expect(la.variants[0].costCny).toBe(9);
    expect(la.variants[0].price).toBe(3.99);
    expect(la.variants[0].price).not.toBe(priceBefore);
    expect(lb.variants[0].costCny).toBe(9);
    expect(lb.variants[0].price).toBe(listingB.variants[0].price); // 不自动改价

    // fakeShopify 桩断言：productVariantsBulkUpdate 收到两条变体的新价
    expect(capturedPrices).toHaveLength(1);
    expect(capturedPrices[0]).toHaveLength(2);
    expect(capturedPrices[0][0]).toMatchObject({
      id: "gid://shopify/ProductVariant/v0",
      price: "3.99",
    });
    expect(la.lastAutoAction?.action).toBe("price_push");
    const audits = await ctx.api("GET", `/api/listings/${listingA.id}/audits`, undefined, t);
    expect(audits.body.audits.map((a: { action: string }) => a.action)).toContain(
      "listing.auto_price_push",
    );

    // A 店已处理、B 店 notify → 变更仍是 pending（关注页可见）
    const pending = await ctx.api("GET", "/api/source-changes?pending=true", undefined, t);
    expect(pending.body.items.length).toBeGreaterThan(0);
  });

  it("delisted→unpublish：下架上报触发远端下架 job", async () => {
    const capturedDelist: string[] = [];
    ctx = await setup(fakeShopify({ capturedDelist }));
    const t = await ctx.register();
    const store = await addStore(t, {
      trackStock: true,
      monitor: { enabled: true },
      inventory: { oosAction: "unpublish" },
    });
    const { listing } = await claimOne(t, store.id);
    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    await drain();

    const rep = await ctx.api(
      "POST",
      "/api/collect/report",
      { offerId: "77", availability: "delisted" },
      t,
    );
    expect(rep.body.republished).toBe(1);
    await drain();
    expect(capturedDelist).toEqual(["gid://shopify/Product/42"]);
    const done = (await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t)).body;
    expect(done.remoteStatus).toBe("DRAFT");
  });

  it("delisted→oosAction=zero：强制清零并推远端库存", async () => {
    const capturedStock: Array<Array<Record<string, unknown>>> = [];
    ctx = await setup(fakeShopify({ capturedStock, stockSkus: ["77-1", "77-2"] }));
    const t = await ctx.register();
    const store = await addStore(t, {
      trackStock: true,
      monitor: { enabled: true },
      inventory: { oosAction: "zero" },
    });
    const { listing } = await claimOne(t, store.id);
    // 即使刊登 stock 策略是 notify，售罄清零也强制推
    await ctx.api("PATCH", `/api/listings/${listing.id}`, { syncPolicy: { stock: "notify" } }, t);
    await ctx.api("POST", "/api/listings/publish", { ids: [listing.id] }, t);
    await drain();
    capturedStock.length = 0;

    await ctx.api("POST", "/api/collect/report", { offerId: "77", availability: "delisted" }, t);
    await drain();
    const done = (await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t)).body;
    expect(done.variants.every((v: { stock: number }) => v.stock === 0)).toBe(true);
    expect(capturedStock.length).toBeGreaterThan(0);
    expect(
      (capturedStock[0] as Array<{ quantity: number }>).every((q) => q.quantity === 0),
    ).toBe(true);
  });

  it("source-changes decide：apply 落刊登，ignore 落账", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const store = await addStore(t); // 监控关 → 全部 pending
    const { listing } = await claimOne(t, store.id);
    await ctx.api("POST", "/api/collect", mutatedHarvest(), t);
    const pending = await ctx.api("GET", "/api/source-changes?pending=true", undefined, t);
    const priceRows = pending.body.items.filter(
      (c: { changeType: string }) => c.changeType === "price",
    );
    const titleRow = pending.body.items.find(
      (c: { changeType: string }) => c.changeType === "title",
    );
    // 手动应用价格（仅 s1 一条）+ 标题
    const dec = await ctx.api(
      "POST",
      "/api/source-changes/decide",
      { ids: [...priceRows.map((r: { id: string }) => r.id), titleRow.id], action: "apply" },
      t,
    );
    expect(dec.body.applied).toBe(2);
    const done = (await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t)).body;
    expect(done.variants[0].price).toBe(3.99);
    expect(done.title).toBe("新标题");

    // 其余 pending 一键忽略
    const rest = await ctx.api("GET", "/api/source-changes?pending=true", undefined, t);
    const ign = await ctx.api(
      "POST",
      "/api/source-changes/decide",
      { ids: rest.body.items.map((r: { id: string }) => r.id), action: "ignore" },
      t,
    );
    expect(ign.body.applied).toBe(0);
    expect(ign.body.ignored).toBe(rest.body.items.length);
    const left = await ctx.api("GET", "/api/source-changes?pending=true", undefined, t);
    expect(left.body.items).toHaveLength(0);
  });

  it("internal_tags 筛选 + /listings/batch 批量操作", async () => {
    ctx = await setup(fakeShopify());
    const t = await ctx.register();
    const store = await addStore(t);
    const { listing } = await claimOne(t, store.id);
    const res2 = await ctx.api("POST", "/api/collect", harvest("88", "货源杯B"), t);
    await ctx.api(
      "POST",
      "/api/source-items/claim",
      { ids: [res2.body.item.id], storeIds: [store.id] },
      t,
    );
    const other = (await ctx.api("GET", "/api/listings", undefined, t)).body.items.find(
      (l: { id: string }) => l.id !== listing.id,
    );
    expect(other).toBeTruthy();

    const b = await ctx.api(
      "POST",
      "/api/listings/batch",
      {
        ids: [listing.id, other.id],
        ops: [
          { op: "internal_tag", add: ["主推"] },
          { op: "price_mul", value: 2 },
          { op: "monitor_enable" },
        ],
      },
      t,
    );
    expect(b.body.updated).toBe(2);
    const one = (await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t)).body;
    expect(one.internalTags).toEqual(["主推"]);
    expect(one.variants[0].price).toBe(listing.variants[0].price * 2);
    expect(one.syncPolicy).toMatchObject({ stock: "auto", price: "auto" });

    const tagged = await ctx.api("GET", "/api/listings?tag=主推", undefined, t);
    expect(tagged.body.items).toHaveLength(2);
    const none = await ctx.api("GET", "/api/listings?tag=不存在", undefined, t);
    expect(none.body.items).toHaveLength(0);

    await ctx.api(
      "POST",
      "/api/listings/batch",
      { ids: [listing.id], ops: [{ op: "internal_tag", remove: ["主推"], add: ["清仓"] }] },
      t,
    );
    const after = (await ctx.api("GET", `/api/listings/${listing.id}`, undefined, t)).body;
    expect(after.internalTags).toEqual(["清仓"]);
  });

  it("freight-forwarders CRUD + 跨 workspace 隔离", async () => {
    ctx = await setup(fakeShopify());
    const t1 = await ctx.register("w1@test.dev");
    const t2 = await ctx.register("w2@test.dev");

    const created = await ctx.api(
      "POST",
      "/api/freight-forwarders",
      {
        name: "深圳仓",
        address: {
          recipient: "张三",
          phone: "13800000000",
          country: "中国",
          city: "深圳市",
          address1: "宝安区 xx 路 1 号",
        },
        systemType: "manual",
      },
      t1,
    );
    expect(created.status).toBe(201);
    const id = created.body.id;

    const list1 = await ctx.api("GET", "/api/freight-forwarders", undefined, t1);
    expect(list1.body.items).toHaveLength(1);
    expect(list1.body.items[0].address.city).toBe("深圳市");
    const list2 = await ctx.api("GET", "/api/freight-forwarders", undefined, t2);
    expect(list2.body.items).toHaveLength(0);

    const upd = await ctx.api(
      "PATCH",
      `/api/freight-forwarders/${id}`,
      { address: { ...created.body.address, city: "广州市" } },
      t1,
    );
    expect(upd.body.address.city).toBe("广州市");
    // 跨 workspace 读写一律 404
    expect(
      (await ctx.api("PATCH", `/api/freight-forwarders/${id}`, { note: "x" }, t2)).status,
    ).toBe(404);
    expect((await ctx.api("DELETE", `/api/freight-forwarders/${id}`, undefined, t2)).status).toBe(404);

    expect((await ctx.api("DELETE", `/api/freight-forwarders/${id}`, undefined, t1)).status).toBe(200);
    expect((await ctx.api("GET", "/api/freight-forwarders", undefined, t1)).body.items).toHaveLength(0);
  });
});
